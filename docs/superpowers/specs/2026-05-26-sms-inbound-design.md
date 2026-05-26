# Inbound SMS Reporting Design

**Date:** 2026-05-26
**Status:** Approved (brainstorm phase)
**Goal:** Allow anyone to text a Twilio number to file a maintenance request, with the same classifier + duplicate detection + Slack mirror pipeline used for in-Slack mentions.

## Summary

Add a third Lambda (`SmsReceiverFn`) behind its own public Function URL. Twilio POSTs SMS events to the URL. The Lambda verifies the Twilio HMAC signature, runs the message through the existing classifier/dedup/Sheets services, posts a mirror to a configurable Slack channel, and returns a TwiML response that becomes the texter's reply SMS. One-shot interaction: severity must be included inline (e.g., `"printer jammed - medium"`). No per-phone state, no SQS, no new IAM beyond the function itself.

Expected incremental cost: ~$1/month Twilio number + ~$0.02 per SMS exchange. AWS side stays within free tier at current volume.

## Architecture

```
                       Texter
                         │
                         │ SMS to Twilio number
                         ▼
                    Twilio
                         │
                         │ HTTPS POST (form-encoded)
                         │ Headers: X-Twilio-Signature
                         ▼
       ┌──────────────────────────────────────┐
       │ Lambda: SmsReceiverFn                │  Node 22, 256 MB, 15s timeout
       │  1. verify X-Twilio-Signature HMAC   │  Function URL, AuthType NONE
       │  2. parse form body (From, Body)     │
       │  3. extractSeverity(Body)            │
       │  4. classify / dedup / append        │
       │  5. post to Slack mirror channel     │
       │  6. return TwiML reply               │
       └──────────────────────────────────────┘
                    │           │
        Groq · Sheets · Slack Web API
```

No SQS. No worker. Single sync Lambda fits Twilio's 15-second webhook timeout comfortably; realistic budget is <5s.

## File Plan

```
NEW   src/lambda/sms-receiver.js     Lambda entry: verify, parse, dispatch to pipeline, render TwiML
NEW   src/lambda/twilio-signature.js HMAC-SHA1 verifier for X-Twilio-Signature
NEW   src/sms/pipeline.js            Pure-ish: input {from, body, deps} → {twimlBody, sheetsRow?, slackPost?}
NEW   src/lib/severity.js            Shared extractSeverity() (moved from src/events/mention.js)
NEW   tests/lambda/sms-receiver.test.js
NEW   tests/lambda/twilio-signature.test.js
NEW   tests/sms/pipeline.test.js
NEW   tests/lib/severity.test.js

MODIFY src/events/mention.js         Import extractSeverity from src/lib/severity.js
MODIFY src/lambda/clients.js         Extend getDeps() cache shape to also return sheetsService, groqService, dedupService (slack worker keeps using client+handler only).
MODIFY template.yaml                 Add SmsReceiverFn + log group + 2 params (TwilioAuthToken, SmsTargetChannelId)
MODIFY .env.example                  Document TWILIO_AUTH_TOKEN, SMS_TARGET_CHANNEL_ID
MODIFY .github/workflows/deploy.yml  Pass new params from secrets/vars
MODIFY README.md                     Add SMS feature line + setup pointer
```

## SMS Pipeline Behavior

**Input:** `{ from, body, deps }`
- `from` — E.164 phone, e.g. `+15555550100`
- `body` — raw text
- `deps` — `{ sheetsService, groqService, dedupService, slackClient, smsTargetChannelId, spreadsheetId }`

**Output:** `{ replyText }` — string to put inside `<Message>` in the TwiML response (always set).

All side effects (Sheets append, Slack post) happen inside the pipeline before it returns, so the receiver only renders TwiML.

**Steps:**

1. Strip whitespace. Extract severity via shared `extractSeverity()`. Apply `new:` prefix bypass before severity extraction.
2. **No severity** → `replyText = "Please include severity at the end: minor, medium, or critical. Example: \"Printer jammed - medium\""`. Return.
3. **Empty description after strip** → `replyText = "Please describe the issue."`. Return.
4. **Maintenance classifier** (skipped if `new:` bypass): `groqService.isMaintenanceRequest(description)`.
   - If `false` → `replyText = "That doesn't look like a maintenance issue. Try: \"<what's broken> - minor/medium/critical\""`. Return.
5. Fetch open issues from Sheets. Filter to last 7 days for dedup.
6. **Dedup** (skipped if `new:` bypass): `dedupService.findDuplicate(description, recentIssues)`.
   - If confident match → `replyText = "Looks like this is already reported (issue #<id>, status: <status>). Not logging again. Reply \"new: <description>\" to force create."`. Return.
   - If uncertain → carry the `duplicate.id` into the Slack post and the reply (`"This might be related to issue #<id>."`).
7. Reporter name = masked phone: `"SMS ****" + from.slice(-4)`.
8. Append row to Sheets via `sheetsService.appendIssue({ reporter, description, severity })`. Capture `id`.
9. Generate fix suggestion: `groqService.suggestFix(description)`. (Best-effort — null on failure.)
10. Post to Slack at `smsTargetChannelId` via `slackClient.chat.postMessage`:
    ```
    📱 New SMS request from SMS ****0100
    *<description>* — severity *<severity>* — logged as #<id>
    <https://docs.google.com/spreadsheets/d/<sheetId>|View in Google Sheets>
    [optional] _This might be related to issue #<dupId>._
    [optional] _Suggested fix:_ <suggestion>
    ```
11. `replyText` (to texter):
    ```
    Logged as issue #<id> (severity: <severity>).
    [optional] Suggested fix: <suggestion (truncated to 800 chars)>
    ```
12. Return.

**`new:` prefix semantics:** identical to Slack flow. Matches `/^new:\s*(.+)$/i`. Skips classifier and dedup. Otherwise extracts severity from the remaining text the same way.

**Privacy:** never log full phone numbers. Last-4 only in Sheets reporter, Slack mirror, and any log lines.

**Character cap:** Twilio outbound `<Message>` body should stay <1600 chars (Twilio splits >160-char SMS into segments transparently up to 1600 chars). Truncate the suggestion to 800 chars in the SMS reply; Slack mirror gets the full suggestion.

## Signature Verification (Twilio)

Algorithm (per Twilio docs):
1. Take the full URL Twilio called (including query string).
2. Append each POST parameter name + value, sorted alphabetically by name (no separators between).
3. HMAC-SHA1 the result using the **Auth Token** as the key.
4. Base64-encode the digest.
5. Compare against `X-Twilio-Signature` header using `crypto.timingSafeEqual`.

The full URL must match exactly what Twilio constructed. For Lambda Function URLs, Twilio is configured with the public URL; the Lambda sees the same path. Reconstruct using `https://<host>` + the raw request path (no port mangling since Function URLs are always 443).

## Lambda Handler

```js
import { verifyTwilioSignature } from "./twilio-signature.js";
import { getDeps } from "./clients.js";
import { runSmsPipeline } from "../sms/pipeline.js";

export async function handler(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : (event.body || "");

  const params = Object.fromEntries(new URLSearchParams(body));
  const url = `https://${event.requestContext.domainName}${event.rawPath}`;
  const sigHeader = getHeader(event.headers, "x-twilio-signature");

  const ok = verifyTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    url,
    params,
    signature: sigHeader,
  });
  if (!ok) return { statusCode: 403, body: "invalid signature" };

  const { client, sheetsService, groqService, dedupService } = getDeps();

  const { replyText } = await runSmsPipeline({
    from: params.From,
    body: params.Body,
    deps: {
      sheetsService,
      groqService,
      dedupService,
      slackClient: client,
      smsTargetChannelId: process.env.SMS_TARGET_CHANNEL_ID,
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
    },
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(replyText)}</Message></Response>`,
  };
}
```

`getDeps()` will be extended to also return `sheetsService`, `groqService`, and `dedupService` alongside the existing `client` and `handler`. The Slack worker keeps consuming only `client` + `handler`; the SMS receiver uses the services directly. Cache shape grows; nothing else changes.

## AWS Resources (SAM)

Additions to `template.yaml`:

```yaml
Parameters:
  TwilioAuthToken:      { Type: String, NoEcho: true }
  SmsTargetChannelId:   { Type: String }

Resources:
  SmsReceiverFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/sms-receiver.handler
      MemorySize: 256
      Timeout: 15
      Environment:
        Variables:
          TWILIO_AUTH_TOKEN:      !Ref TwilioAuthToken
          SMS_TARGET_CHANNEL_ID:  !Ref SmsTargetChannelId
          SLACK_BOT_TOKEN:        !Ref SlackBotToken
          GOOGLE_SHEET_ID:        !Ref GoogleSheetId
          GOOGLE_CLIENT_ID:       !Ref GoogleClientId
          GOOGLE_CLIENT_SECRET:   !Ref GoogleClientSecret
          GOOGLE_REFRESH_TOKEN:   !Ref GoogleRefreshToken
          GROQ_API_KEY:           !Ref GroqApiKey
      FunctionUrlConfig:
        AuthType: NONE

  SmsReceiverLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${SmsReceiverFn}
      RetentionInDays: 14

Outputs:
  SmsFunctionUrl:
    Description: Paste into Twilio Console → phone number → Messaging Webhook (HTTP POST)
    Value: !GetAtt SmsReceiverFnUrl.FunctionUrl
```

No new SQS, no DLQ. If reliability becomes a concern, Twilio retries failed webhooks per its own policy.

## Secrets / CI

**New GitHub Secret:** `TWILIO_AUTH_TOKEN`
**New GitHub Variable:** `SMS_TARGET_CHANNEL_ID`

Workflow appends to `--parameter-overrides`:

```
TwilioAuthToken="${{ secrets.TWILIO_AUTH_TOKEN }}" \
SmsTargetChannelId="${{ vars.SMS_TARGET_CHANNEL_ID }}"
```

`config.js` is unchanged. The SMS Lambda reads `process.env.TWILIO_AUTH_TOKEN` and `process.env.SMS_TARGET_CHANNEL_ID` directly (same pattern as the Slack receiver reads `SLACK_SIGNING_SECRET`). `loadConfig()` continues to be worker-only.

## Testing

- **`twilio-signature.test.js`** — known fixture from Twilio's docs (valid signature accepted), tampered body rejected, params sorted alphabetically (verifies that param order in the input object doesn't affect the result), missing/empty inputs return false.
- **`sms-receiver.test.js`** — bad signature → 403; missing severity → TwiML asks; non-maintenance → TwiML rejects; confident duplicate → TwiML notes existing; happy path → Sheets `appendIssue` called + Slack `chat.postMessage` called + TwiML response contains `Logged as issue #N`. Mock `getDeps` to inject test doubles for services.
- **`pipeline.test.js`** — pure tests on every branch: no-severity, empty-description-after-strip, classifier-rejects, confident-dup, uncertain-dup carried into reply, `new:` bypass skips classifier and dedup, suggestion-truncation-in-reply, success-path.
- **`severity.test.js`** — move existing severity-extraction tests from `mention.test.js` to the new shared location; keep mention tests covering only mention-handler-specific behavior.

`npm test` must stay green.

## Cutover

1. Provision a Twilio account if you don't have one. Buy a US local number (~$1/mo). Trial accounts can text only verified numbers — fine for initial testing.
2. Copy Twilio `Auth Token` (Account Info, not API Key SID).
3. `gh secret set TWILIO_AUTH_TOKEN --repo jonyen/fh-maintenance-bot` (paste at prompt).
4. `gh variable set SMS_TARGET_CHANNEL_ID --body "<test-channel-id>" --repo jonyen/fh-maintenance-bot`.
5. Merge PR → CI deploys. Note `SmsFunctionUrl` from CloudFormation outputs.
6. Twilio Console → Phone Numbers → your number → Messaging Configuration → "A message comes in" → set to **Webhook**, **HTTP POST**, paste `SmsFunctionUrl`. Save.
7. Live test from a personal phone: text `"test - minor"` to the Twilio number.
   - Expect: SMS reply within ~5s confirming issue ID; new row in Sheets; mirror message in target Slack channel.
8. Swap `SMS_TARGET_CHANNEL_ID` to the production channel when ready and re-run the workflow (`gh workflow run deploy.yml`).

Rollback: in Twilio Console, set the webhook to a status URL or remove it. The Lambda stack stays deployed at ~$0 cost.

## Cost Estimate

| Item | Cost |
|---|---|
| Twilio US local number | ~$1.15/mo |
| Twilio SMS (inbound + outbound) | ~$0.016 per exchange |
| AWS Lambda invocations + compute | within free tier |
| CloudWatch Logs | <100 MB/mo, free tier |
| **Total** | **~$1/mo + ~$0.02 per SMS report** |

## Out of Scope (v1)

- Two-way severity conversation (would require per-phone pending state — DynamoDB or Sheets-backed).
- MMS / image attachments (Twilio supports it; ignored for now).
- Outbound notifications back to the reporter when the issue's status changes.
- Rate limiting / per-phone-number quotas.
- A2P 10DLC brand registration (Twilio's US carrier compliance for production traffic — Twilio walks through it; defer for personal/test traffic).
- STOP/UNSUBSCRIBE handling beyond Twilio's automatic compliance.
- Multi-region deploys.
