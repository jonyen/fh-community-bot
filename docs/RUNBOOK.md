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

The queue is FIFO, grouped by Slack user. A failing message holds back that
member's later messages until it reaches the DLQ: three receives of up to
180 s each, so about nine minutes. Other members are not held up.

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

## `fh-community-rollcall-failed`

The basketball roll-call Lambda (`RollCallFn`, runs Tuesday and Thursday 08:00
New York time) failed to post in every channel in `BBALL_CHANNEL_IDS`. A
failure in only some channels doesn't fire this; look for `bball: roll call
post failed` in its log group, `/aws/lambda/<RollCallFn>`, or the
`RollCallFailed` metric (dimension `Flow=bball`). The usual causes are the bot
not being in the channel (`not_in_channel`, invite it), a wrong channel id
(`channel_not_found`) or a Slack token problem (`invalid_auth`). After fixing,
post by hand:

```bash
aws lambda invoke --function-name <RollCallFn physical name> /dev/stdout
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

## A #reservations message gets no reply

The bot reads top-level messages in #reservations only (not thread replies) and
stays silent on anything it reads as chatter. If real requests get no reply:

- The bot must be a member of #reservations, and `RESERVATIONS_CHANNEL_ID` must
  be set on both the receiver and the worker (`template.yaml`).
- The app must be subscribed to `message.channels` (`message.groups` if the
  channel is private).
- Check the worker logs for `reservation message already answered`: the bot
  skips a message whose thread already has a bot reply.

## Card buttons or the Edit form don't work

- **Interactivity:** the Request URL and the **Options Load URL** (Select Menus)
  must both be the receiver's Function URL. Without the Options Load URL, the
  item search in the Edit form shows no results.
- **Edit does nothing:** the receiver opens the form itself, with
  `SLACK_BOT_TOKEN`. Look for `views.open failed` in the receiver logs.
- **Book does nothing:** a press is ignored when the card no longer carries the
  pressed request (already booked, or edited since). Look for
  `stale reservation card press` in the worker logs.

Slack app clean-up after the move from DMs: the `message.im` event and the
`im:history` scope are no longer used and can be removed. Keep the `/reserve`
slash command: it is how members ask privately in #reservations. Its request
URL must be the receiver's Function URL. If `/reserve` gives "dispatch_failed"
or nothing at all, check that URL and look for the command in the receiver logs.

## A cancel says "I couldn't find that booking as it was"

The bot cancels only when the row or event still matches what it booked (or
what the "mine" list showed): rooms compare title, date, start, end, name and
rooms; the kitchen compares name, date, start and end; calendars compare date
and start. Someone edited the row or event since, so the bot deleted nothing
and gave the member a link to fix it by hand. Nothing to repair in the bot.

Cancelled rooms bookings stay in the rooms sheet with `Canceled` in Status, by
design: the row is Management's record. The bot, the digests and conflict
checks treat `Canceled` like Denied. Kitchen cancels clear the row's details and
leave the dated row.

## Reservation digests in #reservations

Two digest posts, both at 08:00 New York time:

- Weekday digest: Monday, covers Mon-Thu.
- Weekend digest: Friday, covers Fri-Sun.

After each booking the bot makes, it edits the matching post. Bookings made
directly in the sheets or calendars show up on the next edit or the next post,
not before.

## Reserve all, the tray and repeat series

A member's tray is one row in the auth table, `tray#<slack user id>`, with the
fields `version`, `lines`, `view`, `editing`, `running`, `claims`, `posts` and
`ended`. It expires 24 hours after the last change (TTL on `expiresAt`). A repeat
series is stored in the member's ledger row, `bookings#<slack user id>`, in its
`series` field (one entry per series).

Reserve all runs in the worker, whose timeout is 300 s (`Timeout` in
`template.yaml`). The event queue's `VisibilityTimeout` is 900 s, 3 times the
timeout. It is kept shorter than the usual 6 times because a failed message holds
up the member's other events (one FIFO group) until it is visible again. A slow run can be retried; this is safe, because the tray
records progress per date as it writes:

- A date is marked `started` before it is written and `done` after. A retry
  skips `done` dates and picks up from the first date not yet written.
- `claims` holds the id of the run that marked each date. `running` is the run
  now in progress, and `ended` lists runs that finished or were taken over, so a
  redelivered event stops. `posts` holds a public post not yet tidied up.

**"May already be booked, please check"** means a run marked a date `started` and
never marked it `done` (the worker was cut off mid-write). The bot does not
write it again, because it can't tell whether the write landed. It tells the
member and drops the date from the tray. To check, open the sheet (rooms or
kitchen) and look for the row on that date, or open the resource calendar and
look for the event. If it is there, nothing to do. If not, the member can book
it again.

To inspect a tray, read the row `tray#<U>` in the table. Do not edit it by hand
while a run is in progress.

The digest is found by paging back through the channel history, so it is still
found after many top-level posts. The bot posts as "Reservations" (maintenance
replies still use "FH Maintenance"); old messages keep the old name.
