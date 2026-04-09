# fh-maintenance-bot

A Slack bot for managing facilities maintenance issue reporting and tracking. Mention the bot in a Slack channel to log issues, detect duplicates, and get AI-powered fix suggestions.

## Features

- **Issue reporting** via Slack @mentions -- automatically logged to Google Sheets
- **Duplicate detection** -- two-pass strategy using keyword matching + LLM verification
- **Fix suggestions** -- AI-powered quick-fix recommendations for common issues
- **Issue management** -- list open issues, close/resolve by ID or description

## Tech Stack

- [Slack Bolt](https://slack.dev/bolt-js/) (Socket Mode) for event handling
- [Google Sheets API](https://developers.google.com/sheets/api) for issue storage
- [Groq](https://groq.com/) (Llama 3.3 70B) for AI features

## Setup

### Prerequisites

- Node.js 20+
- A Slack app with Bot Token and App-Level Token (Socket Mode enabled)
- A Google Cloud project with Sheets API enabled and OAuth2 credentials
- A Groq API key (get one at https://console.groq.com/)

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
| `GROQ_API_KEY` | Yes | Groq API key (`gsk_...`) |

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
    groq.js           # LLM client (suggestions, dedup, digest)
    dedup.js          # Duplicate detection logic
tests/                # Vitest test suite
scripts/
  get-google-token.js # OAuth2 token generation utility
```
