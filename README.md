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

## Gender Aliases

Users can ping channel members by gender by typing `!bros` / `!brothers` / `@bros` / `@brothers` (pings members mapped to `male`) or `!sis` / `!sisters` / `@sis` / `@sisters` (pings `female`). The slash command `/refresh-genders` reloads the map from the sheet.

The bot inserts each mention list at the trigger token's position, preserving the rest of the message:

- `@bros hello` → `<@u1> <@u2> ... hello`
- `hello @bros` → `hello <@u1> <@u2> ...`
- `@bros and @sis, hello` → `<@u1> <@u2> and <@v1> <@v2>, hello`
- Bare `!bros` → mentions only.

Ephemeral system notices (visible only to the caller) are sent under the name **Gender Aliases** with a 👥 avatar:

- `/refresh-genders` slash command result (`Refreshed gender map. N entries loaded.` or `Refresh failed: ...`) posts via Slack's `response_url`.
- "No `<gender>` members configured for this channel." when no match — posts via `chat.postEphemeral`.

The bot posts the reply with the original sender's display name and avatar (via `chat:write.customize`), so the message looks like it came from the caller. If that scope is missing, the bot falls back to posting under its own identity.

Triggers fire in any public or private channel the bot is a member of. They do **not** honor `SLACK_CHANNEL_IDS` (that allowlist still gates the maintenance handler only).

### Gender Map sheet

Create a separate Google Sheet for the gender map (kept distinct from the maintenance spreadsheet). Set its ID as `GENDER_SHEET_ID`. The default tab name is `Gender Map`; override with `GENDER_SHEET_TAB`. The sheet must be shared with the same Google identity that issued `GOOGLE_REFRESH_TOKEN` (Viewer access is enough).

If `GENDER_SHEET_ID` is unset, gender triggers are inert (the handler is not wired up) and the bot only responds to maintenance @mentions.

Sheet layout (4 columns):

| UID | gender | gpmail               | slack_id   |
|-----|--------|----------------------|------------|
| 25  | male   | andrew@example.com   | U01ABC123  |
| 51  | female | billy@example.com    | U02DEF456  |

- Row 1: header. Data starts at row 2.
- Column A (`UID`): internal directory ID — not read by the bot.
- Column B (`gender`): literal `male` or `female` (case-insensitive on read).
- Column C (`gpmail`): email — used by `scripts/backfill-slack-ids.js` to populate column D.
- Column D (`slack_id`): Slack user ID (`U...`). This is the column the bot uses to match against `conversations.members`.

Rows with a blank `slack_id` or with `gender` outside `{male, female}` are skipped.

To backfill `slack_id` from `gpmail`, run `node scripts/backfill-slack-ids.js` locally (requires `users:read.email` scope on the bot token).

The map is cached in memory for 7 days per warm Lambda container (override with `GENDER_CACHE_TTL_DAYS`). Cold starts always refetch. `!refresh-genders` invalidates the cache and refetches immediately.

### Slack app prerequisites

Before the gender feature works in production, update the Slack app config:

- **OAuth scopes (bot):** add `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `users:read.email` (for the `scripts/backfill-slack-ids.js` script), and `chat:write.customize` (to post replies as the original sender). Reinstall the app afterwards.
- **Slash command:** create `/refresh-genders` under Slack app config → Slash Commands. Set the Request URL to the same Receiver Function URL used for Event Subscriptions. No usage hint is required.
- **Event Subscriptions:** subscribe to `message.channels` (public) and `message.groups` (private) bot events, in addition to `app_mention`.
- Invite the bot to each channel where these triggers should work.

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
