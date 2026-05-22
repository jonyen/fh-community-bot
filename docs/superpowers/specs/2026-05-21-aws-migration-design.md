# AWS Migration Design — fh-maintenance-bot

**Date:** 2026-05-21
**Status:** Approved (brainstorm phase)
**Goal:** Move bot off Raspberry Pi onto AWS at lowest cost and operational complexity.

## Summary

Replace the always-on Pi process (Bolt Socket Mode + pm2) with two AWS Lambda functions communicating via an SQS queue. Switch the Slack app from Socket Mode to the Events API (HTTP). All AWS resources defined in a single AWS SAM template. CI/CD via GitHub Actions using an OIDC-assumed IAM role. Region us-east-1.

Expected monthly cost: ~$0 (within AWS free tier at current traffic).

## Architecture

```
                    Slack
                      │
                      │ HTTPS POST (event)
                      ▼
       ┌──────────────────────────────┐
       │ Lambda: ReceiverFn           │  Node 20, 128 MB, 10s timeout
       │   - Bolt AwsLambdaReceiver   │  Function URL, AuthType NONE
       │   - verifies signing secret  │
       │   - ack() < 3s               │
       │   - send event → SQS         │
       └───────────────┬──────────────┘
                       │
                       ▼
              ┌────────────────┐
              │ EventQueue (SQS)│ visibility 60s, maxReceiveCount 3
              └────────┬───────┘
                       │ event source mapping, BatchSize 1
                       ▼
       ┌──────────────────────────────┐
       │ Lambda: WorkerFn             │  Node 20, 256 MB, 30s timeout
       │   - constructs Bolt App      │
       │   - dispatches to mention    │
       │     handler                  │
       │   - calls Groq + Sheets      │
       │   - posts via Slack Web API  │
       └──────────────────────────────┘

       Failed messages → EventDLQ (14-day retention)
```

No VPC. No KMS CMK (AWS-managed encryption only). No custom domain.

## Code Changes

```
src/
  app.js                   # DELETE (Socket Mode entry)
  config.js                # MODIFY — drop SLACK_APP_TOKEN; add SLACK_SIGNING_SECRET, EVENT_QUEUE_URL
  lambda/
    receiver.js            # NEW
    worker.js              # NEW
  events/mention.js        # unchanged
  services/sheets.js       # unchanged
  services/groq.js         # unchanged
  services/dedup.js        # unchanged
```

### receiver.js

- Build Bolt `AwsLambdaReceiver` with `signingSecret`.
- Bolt verifies Slack signature and `X-Slack-Request-Timestamp` (replay protection).
- Bolt auto-handles `url_verification` challenge on Slack Request URL setup.
- For real events: enqueue raw event JSON to SQS via `@aws-sdk/client-sqs` `SendMessageCommand`.
- Ack immediately with HTTP 200. Total receiver budget < 3s.

### worker.js

- SQS event source mapping, batch size 1 (one event per invocation).
- Parse the Slack event body from the SQS record.
- Instantiate a `WebClient` from `@slack/web-api` using `SLACK_BOT_TOKEN`.
- Synthesize the `{ event, say, client }` shape `mention.js` expects:
  - `client` = `WebClient` instance
  - `say` = `(msg) => client.chat.postMessage({ channel: event.channel, ...msg })`
- Apply the existing thread-reply filter (currently in `app.event("message")`):
  - skip if no `thread_ts` and event type is `message`
  - skip bot messages / subtype messages
  - skip messages already containing an `@mention` (handled by app_mention path)
- Dispatch to `mentionHandler`.
- Thrown errors → SQS retries → DLQ after 3 attempts.

### package.json

- Add: `@aws-sdk/client-sqs`, `@slack/web-api` (likely already transitive via Bolt — confirm during impl).
- Remove `pm2` from `start` script. Drop `start` entirely or replace with `sam local start-lambda`.
- Keep `test` / `test:watch` (vitest).

### config.js

- New required vars: `SLACK_SIGNING_SECRET`, `EVENT_QUEUE_URL`.
- Removed required var: `SLACK_APP_TOKEN`.
- Other vars unchanged.

## Slack App Reconfiguration (manual, one-time)

1. Disable Socket Mode (Settings → Socket Mode → off).
2. Revoke the App-Level Token (`xapp-...`).
3. Enable Event Subscriptions; set Request URL to the deployed Lambda Function URL.
4. Re-subscribe bot events: `app_mention`, `message.channels`.
5. Reinstall the app to the workspace (re-prompt for scopes).
6. Copy the Signing Secret (Basic Information → App Credentials) into the Lambda env var `SLACK_SIGNING_SECRET`.
7. Bot Token (`xoxb-...`) unchanged; still used for Web API calls.

## AWS Resources (SAM)

`template.yaml` (sketch):

```yaml
Transform: AWS::Serverless-2016-10-31
Parameters:
  SlackBotToken:        { Type: String, NoEcho: true }
  SlackSigningSecret:   { Type: String, NoEcho: true }
  SlackChannelId:       { Type: String }
  GoogleSheetId:        { Type: String }
  GoogleClientId:       { Type: String, NoEcho: true }
  GoogleClientSecret:   { Type: String, NoEcho: true }
  GoogleRefreshToken:   { Type: String, NoEcho: true }
  GroqApiKey:           { Type: String, NoEcho: true }

Resources:
  EventDLQ:
    Type: AWS::SQS::Queue
    Properties:
      MessageRetentionPeriod: 1209600

  EventQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt EventDLQ.Arn
        maxReceiveCount: 3

  ReceiverFn:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs20.x
      Handler: src/lambda/receiver.handler
      MemorySize: 128
      Timeout: 10
      Environment:
        Variables:
          SLACK_SIGNING_SECRET: !Ref SlackSigningSecret
          SLACK_BOT_TOKEN:      !Ref SlackBotToken
          EVENT_QUEUE_URL:      !Ref EventQueue
      FunctionUrlConfig:
        AuthType: NONE
      Policies:
        - SQSSendMessagePolicy: { QueueName: !GetAtt EventQueue.QueueName }

  WorkerFn:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs20.x
      Handler: src/lambda/worker.handler
      MemorySize: 256
      Timeout: 30
      Environment:
        Variables:
          SLACK_BOT_TOKEN:      !Ref SlackBotToken
          SLACK_CHANNEL_ID:     !Ref SlackChannelId
          GOOGLE_SHEET_ID:      !Ref GoogleSheetId
          GOOGLE_CLIENT_ID:     !Ref GoogleClientId
          GOOGLE_CLIENT_SECRET: !Ref GoogleClientSecret
          GOOGLE_REFRESH_TOKEN: !Ref GoogleRefreshToken
          GROQ_API_KEY:         !Ref GroqApiKey
      Events:
        FromQueue:
          Type: SQS
          Properties:
            Queue: !GetAtt EventQueue.Arn
            BatchSize: 1

  ReceiverLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${ReceiverFn}
      RetentionInDays: 14

  WorkerLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${WorkerFn}
      RetentionInDays: 14

Outputs:
  FunctionUrl:
    Value: !GetAtt ReceiverFnUrl.FunctionUrl
```

Stack name: `fh-maintenance-bot`. Region: `us-east-1`.

## Secrets

All 7 secrets stored as Lambda env vars (encrypted at rest via AWS-managed KMS).

- Local dev `.env` remains for vitest / future fallback. Already gitignored.
- `samconfig.toml` committed with non-secret defaults only: `region = "us-east-1"`, `stack_name = "fh-maintenance-bot"`, capabilities, etc. No `parameter_overrides` block in the committed file.
- `samconfig.local.toml` (gitignored) holds laptop-side `parameter_overrides` for `sam deploy` from a developer machine.
- CI passes secrets to `sam deploy` via `--parameter-overrides`, sourced from GitHub Secrets — never written to a file in the runner.

GitHub Secrets required:

| Name | Purpose |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | OIDC-assumed deploy role |
| `SLACK_BOT_TOKEN` | Bot OAuth |
| `SLACK_SIGNING_SECRET` | Request verification |
| `SLACK_CHANNEL_ID` | Channel scope |
| `GOOGLE_SHEET_ID` | Spreadsheet |
| `GOOGLE_CLIENT_ID` | OAuth client |
| `GOOGLE_CLIENT_SECRET` | OAuth client |
| `GOOGLE_REFRESH_TOKEN` | Sheets API auth |
| `GROQ_API_KEY` | LLM |

`.gitignore` additions: `samconfig.local.toml`, `.aws-sam/`.

Future improvement (deferred): migrate to SSM Parameter Store SecureString for rotation without redeploy.

## Deploy / CI

### One-time bootstrap (manual, from laptop)

1. `aws configure` (or SSO).
2. Create IAM OIDC identity provider for GitHub (`token.actions.githubusercontent.com`).
3. Create IAM role `fh-maintenance-bot-deploy`:
   - Trust policy: GitHub OIDC, condition `repo:jonyen/fh-maintenance-bot:ref:refs/heads/main`.
   - Permissions: CloudFormation, Lambda, SQS, IAM PassRole (for Lambda execution role), CloudWatch Logs, S3 (SAM artifacts bucket).
4. `sam deploy --guided` once → creates SAM artifacts bucket and the stack.
5. Read `FunctionUrl` stack output → paste into Slack app Request URL.

### Recurring deploys (GitHub Actions)

`.github/workflows/deploy.yml`:

- Trigger: `push` to `main`, `paths-ignore: ['docs/**', '**.md']`.
- Steps:
  1. `actions/checkout@v4`
  2. `aws-actions/configure-aws-credentials@v4` (OIDC → assume `AWS_DEPLOY_ROLE_ARN`)
  3. `aws-actions/setup-sam@v2`
  4. `actions/setup-node@v4` with Node 20
  5. `npm ci`
  6. `npm test`
  7. `sam build`
  8. `sam deploy --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides ...` (values from GitHub Secrets).

Rollback: CloudFormation auto-rolls failed updates. Manual `sam delete` if a teardown is required.

## Observability

- CloudWatch Logs per Lambda, 14-day retention.
- DLQ depth is the failure signal — manual console check in v1.
- No metrics/alarms in v1.

## Testing

- Keep existing vitest suite (handlers + services) unchanged.
- Add unit tests:
  - `receiver.handler` — signature verification path, SQS enqueue called with correct payload, ack response shape.
  - `worker.handler` — SQS record parsing, thread-reply filter logic, dispatch to mention handler.
- Mock `@aws-sdk/client-sqs` `SendMessageCommand` and `@slack/web-api` `WebClient`.
- CI runs `npm test` before `sam deploy`.

## Cutover

1. Deploy stack while Pi still running. New Function URL idle.
2. Smoke test Function URL with a signed `curl` payload (verify 200 ack and a queued SQS message).
3. On the Pi: `pm2 stop fh-maintenance-bot`.
4. Slack app: disable Socket Mode → set Request URL → re-subscribe events → reinstall to workspace.
5. Live test: `@bot test` in the configured channel; confirm reply and Sheets row appear.
6. On the Pi: `pm2 delete fh-maintenance-bot`, archive `.env`, power down / repurpose.
7. Watch DLQ depth for 24 hours.

Rollback: re-enable Socket Mode in Slack, `pm2 start` on the Pi. The Lambda stack can stay deployed at ~$0 cost.

## Cost Estimate (us-east-1, ~50 events/day)

| Resource | Free tier | Expected |
|---|---|---|
| Lambda invocations | 1M req/mo | ≪ tier — $0 |
| Lambda compute | 400k GB-s/mo | ≪ tier — $0 |
| SQS requests | 1M req/mo | ≪ tier — $0 |
| CloudWatch Logs | 5 GB ingest | <100 MB — $0 |
| Data transfer out | 100 GB/mo | negligible — $0 |
| **Total** | | **~$0/mo** |

## Out of Scope (v1)

- VPC isolation, KMS customer-managed keys, X-Ray tracing
- Custom domain in front of the Function URL
- CloudWatch alarms, SNS notifications, on-call paging
- SSM Parameter Store / Secrets Manager migration
- Blue/green or canary deployment
- Multi-region failover
- Rate limiting or per-user throttling
- The previously-removed weekly digest cron
