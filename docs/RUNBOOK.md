# Runbook

What the alarms mean and what to do about them. Alarms post to the Slack
channel set by `ALARM_CHANNEL`, via the `fh-community-alarms` SNS topic whose
ARN is a stack output.

## Service level objective

**99.5% of submitted issue reports reach the Google Sheet, measured monthly.**

The SLI is the `FhCommunityBot/IssueLogged` metric, not Lambda success. A
worker that completes without writing a row is a failure by this definition —
somebody filed a maintenance issue and nobody will see it. That is the gap
plain error counts miss.

## Reading the logs

Every line is JSON, and every line from one Slack event carries the same
`correlationId` — the SQS message id, which survives a DLQ redrive, so a
replayed message logs under the same id as its original attempt.

```
fields @timestamp, level, message, severity, type, error.message
| filter correlationId = "<message id>"
| sort @timestamp asc
```

Recent failures across both functions:

```
fields @timestamp, @log, message, error.message
| filter level = "error"
| sort @timestamp desc
| limit 50
```

---

## `fh-community-dlq-not-empty`

**The most important alarm here.** Messages reach the DLQ only after
`maxReceiveCount: 3`, so anything sitting in it has already failed three times
and will not retry itself. Each message is a Slack event — often a maintenance
report — that never got processed.

**Diagnose:**

1. Read a message without consuming it:
   ```bash
   aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 1 \
     --visibility-timeout 0
   ```
2. Take its `messageId` and filter the worker logs by that `correlationId` to
   see all three failed attempts.
3. Usual causes: Google credentials expired or revoked, the Sheet was renamed
   or its tab removed, or a malformed event hit an unhandled path.

**Fix, then redrive.** Do not redrive before fixing the cause — the messages
will simply fail three more times and come back.

```bash
aws sqs start-message-move-task \
  --source-arn "$DLQ_ARN" --destination-arn "$QUEUE_ARN"
```

The alarm has `OKActions`, so it posts again when the queue drains.

## `fh-community-queue-backlog`

**Means:** the oldest queued event has been waiting over five minutes.
Somebody submitted a form and is still looking at an unanswered message.

**Diagnose:** worker `Errors` and `Throttles`, and `ConcurrentExecutions`
against the account limit. A poison message failing and retrying on a loop also
shows up here before it reaches the DLQ.

**Fix:** if the worker is throttled, raise reserved concurrency. If it is
erroring, the DLQ alarm is about to fire too — treat that as the primary.

## `fh-community-issue-write-failed`

**Means:** `sheetsService.appendIssue` threw. The reporter was told to try
again, so unless they do, the report is lost.

**Diagnose:** find `appendIssue failed` and read `error.message`. Typically an
expired `GOOGLE_REFRESH_TOKEN`, a revoked OAuth grant, or Sheets rate limiting.

**Fix:** refresh the token with `scripts/get-google-token.js` and redeploy.
Check the thread — if the reporter did not retry, the issue needs adding by
hand.

## `fh-community-receiver-slow`

**Means:** receiver p99 is above 2s against Slack's 3s delivery deadline. Past
that Slack retries, and you get duplicate events.

**Diagnose:** the receiver should only verify the signature and enqueue. If it
is slow, either cold starts dominate or work has crept in that belongs in the
worker.

**Fix:** move any non-trivial work into the worker. The whole point of the
Function-URL-to-SQS split is keeping this path short.

---

## Adding an alert path that survives a Slack outage

Alarms reach Slack through a Lambda that calls Slack, so a Slack outage
silences them. SNS fans out, so an independent path costs one command:

```bash
aws sns subscribe \
  --topic-arn "$(aws cloudformation describe-stacks --stack-name <stack> \
      --query 'Stacks[0].Outputs[?OutputKey==`AlarmTopicArn`].OutputValue' --output text)" \
  --protocol email --notification-endpoint you@example.com
```

## Deploy fails with an SNS or CloudWatch AccessDenied

The deploy role needs SNS and CloudWatch alarm/dashboard permissions beyond the
Lambda and SQS ones. See the `observability` inline policy in
[`aws-bootstrap.md`](aws-bootstrap.md). CloudFormation rolls the stack back on
this failure, so the running bot is unaffected — reapply the policy and re-run
the deploy.

## Deploy fails with a scheduler AccessDenied

The deploy role is missing the `scheduler` inline policy for the digest
schedules. Apply it from [`aws-bootstrap.md`](aws-bootstrap.md) and re-run the
deploy. CloudFormation rolls back, so the running bot is unaffected.

## `fh-community-digest-failed`

The reservations digest Lambda (`DigestFn`, runs Monday and Friday 08:00 New
York time) errored and posted nothing.
Check its log group, `/aws/lambda/<DigestFn>`. The usual causes are a revoked
Google refresh token (`invalid_grant`) or a Slack token problem
(`not_in_channel`, `invalid_auth`). After fixing, post the digest by hand:

```bash
aws lambda invoke --function-name <DigestFn physical name> /dev/stdout
```

## Digest DM: "couldn't read some sources"

The digest posted, but one backend could not be read, so the post says it may
be incomplete. The DM names the source and the error:

- **Rooms / Kitchen**, `The caller does not have permission`: the sheet was
  unshared from the bot's Google account. Ask the owner (Management for rooms,
  Arie Chen for the kitchen) to share it again with edit access.
- **Equipment calendars**, one item failing: that resource calendar was removed
  or renamed in Google Workspace. Update the `RESOURCE_CALENDARS` repo variable
  and redeploy.

## `reservation write failed` in the worker logs

A #reservations booking passed the conflict check but the write to the sheet or
calendar failed. The member was told to book directly, with the link. The log
line carries `backend` (`rooms`, `kitchen`, `rms`) and the error; the causes are
the same sharing issues as above. The `ReservationFailed` metric counts these.

## Connected accounts: "Couldn't connect" pages or `ConnectFailed`

The `ConnectFailed` metric carries a `stage` field:

- `exchange`: Google refused the sign-in code. Usually the redirect URI on the
  Web OAuth client doesn't match the stack output `OAuthRedirectUri` exactly,
  or the client secret changed. Fix the client or the GitHub secrets and
  redeploy.
- `no_refresh_token`: Google returned no offline access. Check the consent
  screen is Internal and the scopes are approved.
- `store`: DynamoDB or KMS failed. Check the OAuthCallbackFn logs.

`ConnectRejected` with `reason: mismatch` means a member signed in with a
Google account that doesn't match their Slack email. This is working as
intended; the page told them which account to use.

## A member says bookings keep asking them to connect

Their stored token is revoked (they removed access in their Google account, or
it went unused for six months). The bot marks them `revoked` and prompts again;
connecting again fixes it. If it keeps happening for everyone, check the OAuth
consent screen is still **Internal**: in External testing mode Google expires
refresh tokens after 7 days.

## `/reserve` works but follow-up messages get no reply

`/reserve` replies in the member's DM with the bot and needs only `chat:write`.
Follow-ups are plain DM messages, which reach the bot only after these Slack app
changes. Until they land, `/reserve` answers but follow-ups are ignored:

- Add the bot scope `im:history`. (`im:write` is not needed; the bot posts by
  user id.)
- Subscribe to the bot event `message.im`.
- App Home, Messages tab: turn it on and tick "Allow users to send messages".
- Reinstall the app to the workspace so the new scope takes effect.

A request closes when it is answered, booked or refused, after 2 hours idle, or
when the member says "start over" or "cancel".

## Reservation digests in #reservations

Two digest posts, both at 08:00 New York time:

- Weekday digest: Monday, covers Mon-Thu.
- Weekend digest: Friday, covers Fri-Sun.

After each booking the bot makes, it edits the matching post. Bookings made
directly in the sheets or calendars show up on the next edit or the next post,
not before.
