# Maintenance Bot Design Spec

## Overview

A Slack bot that listens for @mentions in a dedicated maintenance channel, logs issues to Google Sheets, detects duplicates, suggests simple fixes using an open-source LLM (Llama 3 70B via Groq), and posts weekly digests of outstanding issues.

## Architecture

```
Slack (Socket Mode)
    │
    ▼
Slack Bolt App (Node.js on Railway)
    ├── Event Listener — listens for @mentions in #maintenance channel
    ├── Issue Manager — deduplicates, logs to Google Sheets, notifies
    ├── AI Advisor — calls Groq (Llama 3 70B) for fix suggestions
    └── Weekly Digest — node-cron fires Monday 9am, AI summarizes, posts to channel

External Services:
    ├── Google Sheets API — issue storage
    └── Groq API (OpenAI-compatible) — fix suggestions + weekly summaries
```

## Core Flow: New @mention

1. User posts `@maintenance-bot <issue description>` in `#maintenance`
2. Bot receives the `app_mention` event
3. Bot checks Google Sheet for similar open issues (two-pass dedup)
4. **If duplicate found:** replies in thread — "This issue has already been logged (row #X, reported by @user on date). Current status: [status]"
5. **If new issue:** logs to Google Sheet, replies in thread with confirmation + AI-suggested fix if applicable

## Google Sheet Schema

| Column | Description |
|--------|-------------|
| ID | Auto-incrementing integer |
| Timestamp | ISO 8601 datetime |
| Reporter | Slack user ID |
| Description | Issue text from the message |
| Status | `open` / `in_progress` / `resolved` |
| AI Suggestion | Generated fix suggestion (if any) |
| Message Link | Permalink to the Slack message |
| Resolved Date | ISO 8601 datetime (blank until resolved) |

## Duplicate Detection (Two-Pass)

1. **Quick pass:** Normalize text (lowercase, strip punctuation), check for keyword overlap against open issues in the sheet (e.g. both contain "lobby printer")
2. **AI pass:** If no clear keyword match, send the new message + last 20 open issue descriptions to Groq: "Is this reporting the same issue as any of these? Reply with the matching ID or 'none'." Catches rephrasings like "printer broken" vs "can't print anything"

This avoids calling Groq for every obvious duplicate while catching subtle ones.

## AI Integration

**Provider:** Groq API (OpenAI-compatible format) with Llama 3 70B.

**Client setup:**
```js
const client = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});
```

**Fix suggestion prompt:**
```
You are a facilities/maintenance assistant. A user reported this issue:
"{issue_description}"

If this is a trivial issue with a common fix, suggest a short actionable fix
the reporter can try themselves. If it requires professional attention,
say so briefly. Keep it under 3 sentences.
```

**Weekly digest prompt:**
```
Summarize these outstanding maintenance issues for a weekly update post
in Slack. Group by priority/area if possible. Be concise and actionable.
Issues: {json_of_open_issues}
```

## Weekly Digest

- **Schedule:** Monday 9am (configurable via `WEEKLY_DIGEST_CRON` env var)
- **Trigger:** `node-cron` in-process
- **Process:** Read all open issues from Google Sheet, send to Groq for summarization, post to `#maintenance` channel
- **No open issues:** Posts "No outstanding issues this week" instead of skipping

## Configuration

All config via environment variables:

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token for socket mode (`xapp-...`) |
| `SLACK_CHANNEL_ID` | The `#maintenance` channel ID |
| `GOOGLE_SHEET_ID` | Spreadsheet ID from the sheet URL |
| `GOOGLE_CREDENTIALS` | Service account JSON (base64-encoded) |
| `GROQ_API_KEY` | Groq API key |
| `WEEKLY_DIGEST_CRON` | Cron expression, defaults to `0 9 * * 1` (Mon 9am) |
| `TIMEZONE` | e.g. `America/Los_Angeles`, defaults to UTC |

**Google Sheets auth:** Service account with editor access to the spreadsheet. No OAuth flow — service account added as a collaborator on the sheet.

**Slack app scopes:** `app_mentions:read`, `chat:write`, `channels:history`

## Project Structure

```
fh-maintenance-bot/
├── src/
│   ├── app.js              — Bolt app init, socket mode, event registration
│   ├── events/
│   │   └── mention.js      — @mention handler (triage + respond)
│   ├── services/
│   │   ├── sheets.js       — Google Sheets read/write/search
│   │   ├── groq.js          — Groq/LLM client (fix suggestions + digest)
│   │   └── dedup.js        — Duplicate detection logic
│   ├── jobs/
│   │   └── weekly-digest.js — Cron job for Monday summary
│   └── config.js           — Env var loading + validation
├── package.json
├── .env.example
└── .gitignore
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Google Sheets API down/rate-limited | Reply in thread: "Couldn't log this issue — please try again shortly." |
| Groq API down | Log issue to sheet, reply with confirmation, skip fix suggestion with note |
| Duplicate detection uncertain | Log as new, mention "This might be related to issue #X" |
| Weekly digest with no open issues | Post "No outstanding issues this week" |
| Bot mentioned outside maintenance channel | Ignore (filter by `SLACK_CHANNEL_ID`) |
| Empty @mention (no description) | Reply asking user to describe the issue |

## Deployment

- **Platform:** Self-hosted on MacBook Air via PM2
- **Mode:** Slack Socket Mode (no public URL required)
- **Process management:** PM2 with `pm2 startup` for auto-restart on reboot
- **Sleep prevention:** Disable sleep or use `caffeinate -s` to keep the machine awake
- **Scheduling:** In-process via `node-cron`
