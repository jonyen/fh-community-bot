# fh-community-bot

A Slack bot for managing facilities maintenance issue reporting and tracking. Mention the bot in a Slack channel to log issues, detect duplicates, and get AI-powered fix suggestions.

## Features

- **Issue reporting** via Slack @mentions — automatically logged to Google Sheets
- **Duplicate detection** — two-pass strategy using keyword matching + LLM verification
- **Fix suggestions** — AI-powered quick-fix recommendations for common issues
- **Issue management** — list open issues, close/resolve by ID or description

## Architecture

```
Slack ──HTTPS──▶ ReceiverFn (Lambda Function URL)
                        │
                        ▼
                  EventQueue (SQS) ──▶ WorkerFn (Lambda)
                                              │
                                              ▼
                              Groq · Google Sheets · Slack Web API
```

Two AWS Lambdas. SQS in between for the 3-second Slack ack budget. No VPC, no database.

## Tech Stack

- AWS Lambda (Node 22, arm64), SQS, CloudWatch Logs
- AWS SAM for IaC
- GitHub Actions + OIDC for deploys
- [Slack Web API](https://slack.dev/) (Events API, not Socket Mode)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [Groq](https://groq.com/) (Llama 3.3 70B)

## Setup

See [`docs/aws-bootstrap.md`](docs/aws-bootstrap.md) for the one-time bootstrap runbook.

After bootstrap, deploys happen automatically on push to `main`.

### Local development

```bash
npm install
cp .env.example .env  # fill in secrets
npm test
```

### Required environment variables (for local tests / `sam local`)

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_CHANNEL_ID` | Channel ID for maintenance requests |
| `GOOGLE_SHEET_ID` | Spreadsheet ID |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth2 refresh token |
| `GROQ_API_KEY` | Groq API key (`gsk_...`) |

To generate a Google refresh token:

```bash
node scripts/get-google-token.js <client_id> <client_secret>
```

## Usage

In the configured Slack channel:

| Command | Description |
|---|---|
| `@bot <description>` | Report a new issue |
| `@bot list` or `@bot show` | List all open issues |
| `@bot close #<ID>` | Resolve an issue by ID |
| `@bot close <description>` | Resolve an issue by description |
| `@bot create new: <description>` | Force-create, bypassing duplicate detection |

## Project structure

```
src/
  config.js                  # env loading
  events/mention.js          # @mention business logic (Slack-runtime-agnostic)
  services/sheets.js         # Google Sheets CRUD
  services/groq.js           # LLM client
  services/dedup.js          # duplicate detection
  lambda/
    receiver.js              # entry: verify Slack sig, enqueue to SQS
    worker.js                # entry: SQS → dispatch
    dispatch.js              # SQS record → (event, say, client) → mention handler
    clients.js               # cold-start dep wiring
    slack-signature.js       # HMAC verification
template.yaml                # SAM
samconfig.toml               # SAM defaults
.github/workflows/deploy.yml # CI/CD
```
