# fh-maintenance-bot

A Slack bot for managing facilities maintenance issue reporting and tracking. Mention the bot in a Slack channel to log issues, detect duplicates, get AI-powered fix suggestions, and receive weekly digests of outstanding work.

## Features

- **Issue reporting** via Slack @mentions -- automatically logged to Google Sheets
- **Duplicate detection** -- two-pass strategy using keyword matching + LLM verification
- **Fix suggestions** -- AI-powered quick-fix recommendations for common issues
- **Weekly digest** -- scheduled summary of open issues posted to Slack
- **Issue management** -- list open issues, close/resolve by ID or description

## Tech Stack

- [Slack Bolt](https://slack.dev/bolt-js/) (Socket Mode) for event handling
- [Google Sheets API](https://developers.google.com/sheets/api) for issue storage
- [Ollama](https://ollama.com/) (local LLM) for AI features
- [node-cron](https://github.com/node-cron/node-cron) for scheduling

## Setup

### Prerequisites

- Node.js 20+
- A Slack app with Bot Token and App-Level Token (Socket Mode enabled)
- A Google Cloud project with Sheets API enabled and OAuth2 credentials
- Ollama running locally (optional -- bot degrades gracefully without it)

### Installation

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_CHANNEL_ID` | Yes | Channel ID for maintenance requests |
| `GOOGLE_SHEET_ID` | Yes | Spreadsheet ID for issue storage |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Google OAuth2 refresh token |
| `OLLAMA_BASE_URL` | No | Ollama API endpoint (default: `http://localhost:11434/v1`) |
| `WEEKLY_DIGEST_CRON` | No | Cron expression for digest schedule (default: `0 9 * * 1`) |
| `TIMEZONE` | No | Timezone for cron (default: `America/Los_Angeles`) |

To generate a Google refresh token:

```bash
node scripts/get-google-token.js <client_id> <client_secret>
```

### Running

```bash
npm start
```

### Testing

```bash
npm test
npm run test:watch
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

## Project Structure

```
src/
  app.js              # Entry point, Bolt app initialization
  config.js           # Environment config loading & validation
  events/
    mention.js        # @mention handler (triage, commands)
  services/
    sheets.js         # Google Sheets CRUD
    ollama.js         # LLM client (suggestions, dedup, digest)
    dedup.js          # Duplicate detection logic
  jobs/
    weekly-digest.js  # Cron-scheduled weekly digest
tests/                # Vitest test suite
scripts/
  get-google-token.js # OAuth2 token generation utility
```
