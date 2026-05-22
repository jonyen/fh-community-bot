# AWS Bootstrap

One-time setup before CI deploys can run. Do this from your laptop with admin AWS credentials.

## 1. AWS account + CLI

- `aws configure` (or SSO).
- Default region: `us-east-1`.

## 2. GitHub OIDC provider

If your AWS account doesn't already have a provider for `token.actions.githubusercontent.com`:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

(GitHub publishes the current root CA thumbprint here: https://docs.github.com/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

## 3. Deploy role

Create an IAM role `fh-maintenance-bot-deploy` with:

**Trust policy** (replace `OWNER/REPO`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:ref:refs/heads/main" }
    }
  }]
}
```

**Permissions:** for a first pass, attach `AWSCloudFormationFullAccess`, `AmazonSQSFullAccess`, `AWSLambda_FullAccess`, `IAMFullAccess`, `CloudWatchLogsFullAccess`, `AmazonS3FullAccess`. Tighten later.

Record the role ARN.

## 4. GitHub repository secrets

In GitHub → Settings → Secrets and variables → Actions, create:

| Name | Source |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | role ARN from step 3 |
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret |
| `SLACK_CHANNEL_ID` | Slack channel ID where the bot operates |
| `GOOGLE_SHEET_ID` | spreadsheet ID |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | from `scripts/get-google-token.js` |
| `GROQ_API_KEY` | from https://console.groq.com |

## 5. First manual deploy (to set the Slack Request URL)

```bash
cp samconfig.toml samconfig.local.toml
```

Edit `samconfig.local.toml` and add under `[default.deploy.parameters]`:

```toml
parameter_overrides = """
SlackBotToken="xoxb-..."
SlackSigningSecret="..."
SlackChannelId="C..."
GoogleSheetId="..."
GoogleClientId="..."
GoogleClientSecret="..."
GoogleRefreshToken="..."
GroqApiKey="gsk_..."
"""
```

Then:

```bash
sam build
sam deploy
```

Note the `FunctionUrl` output.

## 6. Reconfigure the Slack app

In https://api.slack.com/apps → your app:

1. Settings → Socket Mode → **disable**.
2. Settings → Basic Information → revoke the App-Level Token (`xapp-...`).
3. Features → Event Subscriptions → enable; paste the `FunctionUrl` from step 5 as the **Request URL**. Slack will send a `url_verification` challenge; expect a green check.
4. Subscribe to bot events: `app_mention`, `message.channels`.
5. Save.
6. Reinstall app to workspace if Slack prompts for scope re-grant.

## 7. Smoke test

In the configured channel:

```
@FH Maintenance test
```

Expect: 👀 reaction within ~1s, then severity prompt. Confirm a row appears in the Sheet.

Watch logs:

```bash
sam logs --stack-name fh-maintenance-bot --name ReceiverFn --tail
sam logs --stack-name fh-maintenance-bot --name WorkerFn   --tail
```

## 8. Decommission the Pi

```
pm2 stop fh-maintenance-bot
pm2 delete fh-maintenance-bot
```

Keep `.env` archived offline for 30 days in case rollback is needed.

## Rollback

1. Slack app → re-enable Socket Mode, regenerate App-Level Token, paste it back into the Pi's `.env`.
2. On the Pi: `pm2 start ecosystem.config.cjs`.
3. AWS stack can stay deployed at ~$0 cost while debugging.
