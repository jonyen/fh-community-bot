# GitHub Actions Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that deploys the SAM stack on push to `main` or manual trigger, using OIDC for AWS auth.

**Architecture:** Single `deploy` job: checkout → install → test → AWS OIDC auth → SAM build → SAM deploy with parameters from GitHub Secrets and Variables. Pre-work removes 2 orphaned tests so CI can pass.

**Tech Stack:** GitHub Actions, AWS SAM CLI, Node.js 20, AWS OIDC, CloudFormation.

---

### Task 1: Remove orphaned generateDigest tests

**Files:**
- Modify: `tests/services/groq.test.js`

The `generateDigest` function was removed but its tests remain and fail. Remove them so `npm test` exits 0.

- [ ] **Step 1: Open the test file and locate the orphaned describe block**

Open `tests/services/groq.test.js`. Find the `describe("generateDigest", ...)` block. It contains two `it(...)` tests — one for a normal digest summary and one for "returns null when API fails". Both tests call `service.generateDigest(...)` which throws `TypeError: service.generateDigest is not a function`.

- [ ] **Step 2: Delete the describe block**

Remove the entire `describe("generateDigest", () => { ... })` block and nothing else. Do not touch the other describe blocks (`suggestFix`, `checkDuplicate`, `isMaintenanceRequest`) — they must remain intact.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass with 0 failures. Before this change, the output showed 82 passed / 2 failed. After this change, it should show 80 passed / 0 failed (the 2 removed tests are no longer counted).

- [ ] **Step 4: Commit**

```bash
git add tests/services/groq.test.js
git commit -m "remove orphaned generateDigest tests"
```

---

### Task 2: Write the GitHub Actions workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create the .github/workflows directory**

Run: `mkdir -p .github/workflows`

- [ ] **Step 2: Create the workflow file**

Create `.github/workflows/deploy.yml` with this exact content:

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

**Important notes on the contents:**
- `permissions: id-token: write` is required for OIDC — without it, `configure-aws-credentials` cannot request the JWT.
- `vars.X` references GitHub Actions **variables** (non-sensitive, editable in repo Settings → Secrets and variables → Actions → Variables tab).
- `secrets.X` references GitHub Actions **secrets** (sensitive, write-only after creation).
- `--no-fail-on-empty-changeset` prevents the workflow from failing when there are no changes to deploy (e.g., doc-only commits).
- The Node version (`20`) matches the Lambda runtime declared in `template.yaml`.
- `sam build` creates the `.aws-sam/` artifact directory (already in `.gitignore`).

- [ ] **Step 3: Validate YAML syntax**

Run: `node -e "const yaml = require('fs').readFileSync('.github/workflows/deploy.yml', 'utf8'); console.log('File length:', yaml.length)"`
Expected: Prints `File length: <some number around 1500>`. This is just a sanity check that the file exists and is readable. The real validation happens when GitHub runs it.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "add GitHub Actions deploy workflow"
```

---

### Task 3: Write the deployment setup guide

**Files:**
- Create: `docs/deployment.md`

This document captures the one-time manual AWS and GitHub setup so anyone (including future-you) can reproduce it.

- [ ] **Step 1: Create docs/deployment.md**

Create `docs/deployment.md` with this exact content:

````markdown
# Deployment

This project deploys to AWS via GitHub Actions using SAM. The workflow is at `.github/workflows/deploy.yml`.

## How it runs

- **Automatic:** Every push to `main` triggers a deploy.
- **Manual:** In GitHub → Actions → "Deploy" → "Run workflow".

Tests run first. If any fail, deploy is aborted.

## One-time AWS setup

The workflow authenticates to AWS via OIDC (no long-lived credentials in GitHub). Do this once:

### 1. Create the OIDC identity provider

In the AWS Console → IAM → Identity Providers → Add provider:

- **Provider type:** OpenID Connect
- **Provider URL:** `https://token.actions.githubusercontent.com`
- **Audience:** `sts.amazonaws.com`

Click "Add provider". AWS will verify the thumbprint automatically.

### 2. Create an IAM role for GitHub Actions

IAM → Roles → Create role:

- **Trusted entity type:** Web identity
- **Identity provider:** `token.actions.githubusercontent.com`
- **Audience:** `sts.amazonaws.com`
- **GitHub organization:** `jonyen`
- **GitHub repository:** `fh-maintenance-bot`

(Leave branch blank to allow all branches, or restrict to `main` only if you prefer. The workflow only deploys from `main` anyway.)

Name the role: `github-actions-fh-maintenance-bot-deploy`

**Trust policy** (IAM should generate this for you, but verify it looks like):

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

### 3. Attach permissions

Attach the AWS managed policy **`PowerUserAccess`** to the role. This is broad but sufficient for SAM deployments of this stack.

You also need to grant IAM permissions so SAM can create the Lambda execution roles. Add this inline policy to the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:PassRole",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:TagRole",
      "iam:UntagRole"
    ],
    "Resource": "*"
  }]
}
```

Least-privilege scoping of these policies is a future improvement; for now `PowerUserAccess` + the IAM inline policy is sufficient.

### 4. Copy the role ARN

After creating the role, copy its ARN (looks like `arn:aws:iam::123456789012:role/github-actions-fh-maintenance-bot-deploy`). You'll need it in the next step.

## One-time GitHub setup

In the repo → Settings → Secrets and variables → Actions:

### Variables (Variables tab)

These are not sensitive — anyone with repo read access can see them.

| Name | Description |
|------|-------------|
| `AWS_REGION` | AWS region, e.g., `us-east-1` |
| `AWS_DEPLOY_ROLE_ARN` | The IAM role ARN from step 4 above |
| `SLACK_CHANNEL_IDS` | Comma-separated Slack channel IDs, e.g., `C0123,C0456` |
| `GOOGLE_SHEET_ID` | The Google Sheets spreadsheet ID |
| `PINPOINT_APP_ID` | The Amazon Pinpoint application ID |
| `PINPOINT_NUMBER` | The Pinpoint phone number (E.164, e.g., `+15551234567`) |

### Secrets (Secrets tab)

These are sensitive and write-only after creation.

| Name | Description |
|------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth2 refresh token |
| `GROQ_API_KEY` | Groq API key |

## First deploy

Once the above is set up, either:

1. Push a commit to `main`, or
2. Go to GitHub → Actions → Deploy → Run workflow

The workflow will run tests, build, and deploy. If it fails, check the Actions log — common issues:
- **"Unable to load credentials from... "** — OIDC setup incomplete; re-verify the trust policy and audience.
- **"Parameter X not found in SSM/..."** — missing a GitHub secret or variable; check the spelling.
- **"Stack is in ROLLBACK_COMPLETE state"** — a prior failed deploy left the stack in a bad state; delete the stack in CloudFormation and re-run.

## Local deploys

Local deploys still work via `sam build && sam deploy` — you'll be prompted interactively because `samconfig.toml` has `confirm_changeset = true`. The workflow bypasses this with `--no-confirm-changeset`.
````

- [ ] **Step 2: Commit**

```bash
git add docs/deployment.md
git commit -m "add deployment setup guide"
```

---

## Self-Review

**Spec coverage:**
- Remove orphaned `generateDigest` tests — Task 1 ✅
- `.github/workflows/deploy.yml` with OIDC, test gate, SAM build/deploy — Task 2 ✅
- `docs/deployment.md` with manual setup steps (OIDC provider, IAM role, trust policy, IAM permissions, GitHub vars/secrets) — Task 3 ✅
- `template.yaml`, `samconfig.toml`, source code unchanged — confirmed, no task touches them ✅

**Placeholder scan:** No TBDs, TODOs, or vague instructions. Every code block is complete.

**Type consistency:** Parameter names in the workflow (`SlackBotToken`, `SlackChannelIds`, etc.) match the SAM template parameters exactly. GitHub `vars` vs `secrets` split matches the spec.

**Scope:** 3 tasks, each small and independent. Task 1 can run first (red → green); Tasks 2 and 3 are additive file creations.
