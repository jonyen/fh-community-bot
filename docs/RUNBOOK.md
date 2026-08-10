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
