# SMS Service + AWS Migration Design Spec

## Overview

Migrate the maintenance bot from Raspberry Pi (PM2 + Slack Socket Mode) to fully serverless AWS (Lambda + API Gateway), and add SMS as a second input channel via Amazon Pinpoint. Both channels share the same core logic. Slack switches from Socket Mode to HTTP Events mode.

## Architecture

```
SMS (Pinpoint number)              Slack (HTTP Events)
        |                                  |
        v                                  v
   SNS Topic                         API Gateway
        |                            /slack/events
        v                                  |
   Lambda: sms-handler              Lambda: slack-handler
        |                                  |
        +------------------+---------------+
                           v
                    Shared Core Logic
                    |-- services/sheets.js   (Google Sheets)
                    |-- services/groq.js     (Groq/Llama 3)
                    |-- services/dedup.js    (duplicate detection)
                    +-- services/conversation.js (DynamoDB state)
                           |
                    External Services
                    |-- Google Sheets API
                    |-- Groq API
                    |-- DynamoDB (conversation state)
                    +-- Pinpoint (outbound SMS)
```

## SMS Flow

1. Tenant texts the Pinpoint number.
2. Pinpoint routes inbound SMS to an SNS topic, which triggers the `sms-handler` Lambda.
3. Lambda looks up the phone number in DynamoDB for conversation state.
4. **No active conversation:** Classify the message via Groq. If it's a maintenance request, ask for severity via reply SMS.
5. **Awaiting severity:** Validate the response (`minor`, `medium`, `critical`), log to Google Sheets, reply with confirmation + AI-suggested fix.
6. **Has linked issue:** Treat as a follow-up note, append to Google Sheets.
7. Conversation state expires after 24 hours of inactivity (DynamoDB TTL).

### SMS Scope (limited)

SMS users can:
- Report new issues (with severity prompt)
- Reply with follow-up details (appended as notes)
- Text "NEW" to start a new issue even if one is active

SMS users cannot list, close, or resolve issues. Those actions remain Slack-only.

## Slack Migration (Socket Mode -> HTTP Events)

- Replace `@slack/bolt` Socket Mode with HTTP Events mode.
- API Gateway receives Slack events at `/slack/events`.
- Lambda verifies the Slack signing secret on each request (replaces socket-based auth).
- Slack URL verification challenge handled in the Lambda.
- All existing Slack functionality is preserved: report, list, close/resolve, thread notes.

## DynamoDB Schema

**Table: `maintenance-bot-conversations`**

| Key | Type | Description |
|-----|------|-------------|
| `pk` | String (partition key) | `SMS#{phoneNumber}` or `SLACK#{threadTs}` |
| `state` | String | `awaiting_severity`, `issue_created` |
| `issueDescription` | String | The reported issue text |
| `issueRowId` | String | Google Sheets row ID (once created) |
| `reporterName` | String | Phone number or Slack user name |
| `suggestion` | String | Cached AI suggestion |
| `duplicate` | Map | Duplicate detection result (`id`, `confident`) |
| `ttl` | Number | Unix timestamp for auto-expiry (24h after last update) |
| `updatedAt` | String | ISO 8601 timestamp of last activity |

This replaces the in-memory `pendingIssues` and `createdIssues` Maps in the current Slack handler, making both channels fully stateless.

## Infrastructure

**Tooling:** AWS SAM (simple template for this scope).

**Resources:**
- 2 Lambda functions (`sms-handler`, `slack-handler`) with a shared code layer
- 1 API Gateway with routes: `/slack/events`
- 1 DynamoDB table (`maintenance-bot-conversations`)
- 1 SNS topic (Pinpoint inbound SMS -> Lambda)
- Amazon Pinpoint application + dedicated phone number (number provisioned manually via AWS console)

**SAM template** defines all resources. Lambdas share the `src/services/` layer via a common directory structure — no Lambda Layers needed if bundled as a single deployment package.

## Project Structure (updated)

```
fh-maintenance-bot/
|-- src/
|   |-- handlers/
|   |   |-- slack.js           -- API Gateway -> Slack event handling
|   |   +-- sms.js             -- SNS -> SMS event handling
|   |-- services/
|   |   |-- sheets.js          -- Google Sheets read/write/search
|   |   |-- groq.js            -- Groq/LLM client
|   |   |-- dedup.js           -- Duplicate detection logic
|   |   +-- conversation.js    -- DynamoDB conversation state
|   |-- core/
|   |   +-- mention.js         -- Shared issue processing logic (extracted from events/mention.js)
|   +-- config.js              -- Env var loading + validation
|-- template.yaml              -- SAM template
|-- package.json
+-- .gitignore
```

Key changes from current structure:
- `src/app.js` removed (no more long-running process)
- `src/events/mention.js` refactored into `src/core/mention.js` (channel-agnostic logic) and `src/handlers/slack.js` / `src/handlers/sms.js` (channel-specific entry points)
- `src/services/conversation.js` added (DynamoDB state management)
- `template.yaml` added (SAM infrastructure definition)
- PM2 config (`ecosystem.config.cjs`) removed

## Environment Variables

Carried over:
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | The `#maintenance` channel ID |
| `GOOGLE_SHEET_ID` | Spreadsheet ID |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth2 refresh token |
| `GROQ_API_KEY` | Groq API key |

New:
| Variable | Description |
|----------|-------------|
| `SLACK_SIGNING_SECRET` | Verifies Slack HTTP requests |
| `DYNAMODB_TABLE` | Conversation state table name |
| `PINPOINT_APP_ID` | Amazon Pinpoint application ID |
| `PINPOINT_NUMBER` | Originating phone number for outbound SMS |

Removed:
| Variable | Description |
|----------|-------------|
| `SLACK_APP_TOKEN` | No longer needed (Socket Mode removed) |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Google Sheets API down | Reply (SMS or Slack): "Couldn't log this issue — please try again shortly." |
| Groq API down | Log issue, skip fix suggestion with note |
| Pinpoint send failure | Log error, no retry (user can text again) |
| DynamoDB failure | Reply with generic error, issue not lost if already in Sheets |
| Invalid Slack signature | Return 401, do not process |
| SMS from unknown format | Attempt to parse, fall back to treating full body as description |
| Conversation state expired | Treat as new conversation |

## What's Not Changing

- Google Sheets as the issue store (same schema, same columns)
- Groq as the AI provider (same model, same prompts)
- Duplicate detection logic (keyword + AI two-pass)
- All Slack user-facing behavior (report, list, close, notes)
- CC notification to manager for medium/critical issues (Slack only)
