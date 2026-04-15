# GitHub Actions Deployment Design Spec

## Overview

Add a GitHub Actions workflow that deploys the SAM stack on push to `main` or manual trigger. Authenticates to AWS via OIDC (no long-lived credentials). Tests must pass before deploy. The 2 pre-existing orphaned `generateDigest` tests are removed so CI can pass on a clean base.

## Triggers

- `push` to `main` branch
- `workflow_dispatch` (manual trigger from GitHub UI)

## Pre-Work: Remove Orphaned Tests

Delete the `describe("generateDigest", ...)` block from `tests/services/groq.test.js`. The `generateDigest` function was removed when the weekly digest feature was scrapped; the tests remain as dead weight and block CI. No replacement is needed — the feature is gone and YAGNI applies.

## AWS OIDC Setup (Manual, One-Time)

The workflow assumes an IAM role via OIDC. The user must complete these steps in AWS before the workflow can deploy:

1. **Create OIDC identity provider** (IAM → Identity Providers):
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

2. **Create IAM role** (e.g., `github-actions-fh-maintenance-bot-deploy`) with this trust policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": {
         "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
       },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
         },
         "StringLike": {
           "token.actions.githubusercontent.com:sub": "repo:jonyen/fh-maintenance-bot:*"
         }
       }
     }]
   }
   ```

3. **Attach permissions** to the role. Minimum required for SAM deploy:
   - CloudFormation: create/update/delete stacks
   - S3: read/write to the SAM managed bucket (`aws-sam-cli-managed-default-*`)
   - Lambda: create/update/delete functions, get/update code
   - IAM: create/delete roles and policies for Lambda execution
   - DynamoDB: create/update/delete tables
   - SNS: create/delete topics
   - API Gateway: create/update/delete APIs

   For simplicity, `PowerUserAccess` (AWS managed) + an inline IAM pass-role policy works. For least-privilege, a custom policy scoped to these services is better but out of scope for this spec.

4. **Configure GitHub Actions variables and secrets** at repo level (Settings → Secrets and variables → Actions):

   **Variables** (non-sensitive, visible to anyone with repo read access):
   - `AWS_REGION` — e.g., `us-east-1`
   - `AWS_DEPLOY_ROLE_ARN` — the ARN of the IAM role from step 2
   - `SLACK_CHANNEL_IDS` — comma-separated list of channel IDs
   - `GOOGLE_SHEET_ID` — the public spreadsheet identifier
   - `PINPOINT_APP_ID`
   - `PINPOINT_NUMBER`

   **Secrets** (sensitive):
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `GROQ_API_KEY`

These setup steps are documented in a new `docs/deployment.md` file so they can be followed once before the first deploy.

## Workflow File

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: Setup SAM CLI
        uses: aws-actions/setup-sam@v2
        with:
          use-installer: true

      - name: SAM build
        run: sam build

      - name: SAM deploy
        run: |
          sam deploy \
            --no-confirm-changeset \
            --no-fail-on-empty-changeset \
            --parameter-overrides \
              SlackBotToken=${{ secrets.SLACK_BOT_TOKEN }} \
              SlackSigningSecret=${{ secrets.SLACK_SIGNING_SECRET }} \
              SlackChannelIds=${{ vars.SLACK_CHANNEL_IDS }} \
              GoogleSheetId=${{ vars.GOOGLE_SHEET_ID }} \
              GoogleClientId=${{ secrets.GOOGLE_CLIENT_ID }} \
              GoogleClientSecret=${{ secrets.GOOGLE_CLIENT_SECRET }} \
              GoogleRefreshToken=${{ secrets.GOOGLE_REFRESH_TOKEN }} \
              GroqApiKey=${{ secrets.GROQ_API_KEY }} \
              PinpointAppId=${{ vars.PINPOINT_APP_ID }} \
              PinpointNumber=${{ vars.PINPOINT_NUMBER }}
```

## Files Created

- `.github/workflows/deploy.yml` — the workflow file
- `docs/deployment.md` — manual OIDC setup guide and secret/variable reference

## Files Modified

- `tests/services/groq.test.js` — delete `generateDigest` describe block (2 tests removed)

## What's Not Changing

- `template.yaml`
- `samconfig.toml` — stays at `confirm_changeset = true` for local manual deploys; CI bypasses with `--no-confirm-changeset`
- Source code
- Other test files

## Open Items / Out of Scope

- **Least-privilege IAM policy** — using `PowerUserAccess` is recommended for now. A custom policy is better but not needed to ship this.
- **Rollback on failure** — SAM's default rollback behavior handles CloudFormation-level failures. No custom rollback logic needed.
- **Environment separation (dev/staging/prod)** — single environment for now. Branch-based environment selection is a future enhancement.
- **Notification on deploy** (Slack/email) — deferred; GitHub Actions UI shows status.
