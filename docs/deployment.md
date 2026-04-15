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

- **"Unable to load credentials from..."** — OIDC setup incomplete; re-verify the trust policy and audience.
- **"Parameter X not found in SSM/..."** — missing a GitHub secret or variable; check the spelling.
- **"Stack is in ROLLBACK_COMPLETE state"** — a prior failed deploy left the stack in a bad state; delete the stack in CloudFormation and re-run.

## Local deploys

Local deploys still work via `sam build && sam deploy` — you'll be prompted interactively because `samconfig.toml` has `confirm_changeset = true`. The workflow bypasses this with `--no-confirm-changeset`.
