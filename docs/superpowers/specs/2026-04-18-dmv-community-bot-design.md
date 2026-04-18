# DMV Community Bot Design Spec

## Overview

Consolidate three separate projects — fh-maintenance-bot, gender-aliases, and ffx-bball-bot — into a single repo (`dmv-community-bot`) sharing one Slack app, one SAM stack, and one GitHub Actions deploy pipeline. Gender-aliases is rewritten from Python to Node.js. This reduces Slack workspace app usage from 3 to 1.

## Architecture

```
Slack Events (HTTP)          SMS (Pinpoint)        EventBridge (cron)
       |                          |                Tue+Thu 8am ET
       v                          v                       |
  API Gateway              SNS Topic                      v
  POST /slack/events                              bball-post-handler
  POST /slack/commands            |
       |                          v
       v                    sms-handler
  slack-handler
  (routes by event type)
       |
       +-- app_mention -----------> maintenance issue processing
       +-- message (trigger words) -> gender-aliases lookup + ping
       +-- message (maint thread) --> maintenance thread reply
       +-- reaction_added/removed --> basketball attendance tracking
       +-- slash command /ball ----> basketball schedule/post/edit/delete
       +-- url_verification -------> challenge response
```

## Lambda Functions (3)

### 1. slack-handler

Receives all Slack HTTP events and slash commands via API Gateway. Routes based on event type:

**Routing logic:**

```
if (body.command === "/ball") → basketball slash command handler
if (body.type === "url_verification") → return challenge
if (event.type === "reaction_added" or "reaction_removed") → basketball reaction handler
if (event.type === "app_mention" && channel in MAINTENANCE_CHANNEL_IDS) → maintenance handler
if (event.type === "message") {
  if (hasTriggerWord(text)) → gender-aliases handler
  if (isMaintenanceThread(event)) → maintenance thread reply handler
}
```

**Two API Gateway routes:**
- `POST /slack/events` — event subscriptions (mentions, messages, reactions)
- `POST /slack/commands` — slash commands (`/ball`)

Both routes go to the same Lambda. The handler distinguishes them by checking for `body.command` (slash commands use URL-encoded form body) vs `body.type` (events use JSON).

**Signature verification:** Shared across all paths. Uses the existing `verifySignature` from ffx-bball-bot (HMAC-SHA256, 5-min timestamp window, timing-safe comparison).

### 2. sms-handler

Existing SMS handler — unchanged from fh-maintenance-bot. Triggered by SNS topic from Pinpoint inbound SMS. Handles maintenance issue reporting via text.

### 3. bball-post-handler

Existing scheduled post handler from ffx-bball-bot. Triggered by EventBridge Scheduler (Tue+Thu 8 AM ET). Posts roll-call messages to basketball channel(s) with weather.

## Features

### Maintenance (from fh-maintenance-bot)

Behavior is unchanged:
- `@bot <issue>` in maintenance channels → classify, dedup, log to Google Sheets, AI suggestion
- Severity prompt flow (inline or conversational)
- List/close/resolve commands (Slack only)
- Thread replies append as notes
- SMS reporting via Pinpoint (full two-way conversation)
- DynamoDB for conversation state
- CC `<@U0000000000>` for medium/critical (Slack only)

### Gender Aliases (rewritten from Python to Node.js)

**Trigger detection:**
- Regex: `(?:^|\s)[!@](bros|brothers|sis|sisters)\b` (case-insensitive)
- `!bros` / `@bros` / `!brothers` / `@brothers` → ping male members
- `!sis` / `@sis` / `!sisters` / `@sisters` → ping female members
- `!refresh-genders` / `@refresh-genders` → force cache refresh

**Behavior:**
1. Detect trigger word in message text
2. Look up gender mappings from a Google Sheet (sheet ID in config, separate from maintenance sheet)
3. Fetch channel members via Slack API (paginated, 200/page)
4. Filter members by matching gender
5. Reply in channel: `<@caller> pinged {gender}s: <@user1> <@user2> ...`
6. If no matches: `No {gender} members configured for this channel.`

**Cache:**
- DynamoDB-backed cache (key: `CACHE#gender-aliases`, same table as conversations)
- 7-day TTL
- Lazy refresh: checked on each trigger, refreshed if stale
- Force refresh via `!refresh-genders` command

**Google Sheets format:**
- Column A: Slack user ID (e.g., `U01ABC123`)
- Column B: gender (`male` or `female`, case-insensitive)
- Data starts at row 2 (row 1 is headers), range: `A2:B`

### Basketball (ported from ffx-bball-bot)

Behavior is unchanged — direct port of existing Node.js code:

**Scheduled posts (bball-post-handler):**
- EventBridge fires on schedule (default: Tue+Thu 8 AM ET, America/New_York timezone)
- Posts to all channels in `BBALL_CHANNELS` env var
- Message format: header + roster + weather line
- Weather from NOAA API (Fairfax, VA coordinates, noon forecast)
- Failure DMs sent to `U0000000000`

**Reaction handling (in slack-handler):**
- Tracks reactions on bot's own messages
- Categories: In (basketball, +1, white_check_mark), Out (x, -1, nope), Maybe (anything else)
- Priority: In > Out > Maybe (if user reacts with multiple)
- Updates message in-place with roster counts
- Filters: only reacts on messages authored by the bot user

**Slash command `/ball` (in slack-handler):**
- `/ball` → usage help
- `/ball <message>` → post custom roll-call to current channel
- `/ball edit <message>` → edit most recent bot message in channel
- `/ball delete` → delete most recent bot message in channel
- `/ball schedule` → show current schedule
- `/ball schedule <natural language>` → update schedule (e.g., `every Tue, Thu at 8am`)
- `/ball schedule pause` → disable schedule
- `/ball schedule resume` → enable schedule
- `/ball info` → show deployed commit SHA and GitHub run number
- Schedule parser: converts natural language to EventBridge cron expressions
- Schedule changes persist across deploys (deploy script reads live schedule from EventBridge)

## Project Structure

```
dmv-community-bot/
├── src/
│   ├── handlers/
│   │   ├── slack.js              -- shared Slack event router + signature verification
│   │   └── sms.js                -- SMS handler (from maintenance bot)
│   ├── features/
│   │   ├── maintenance/
│   │   │   ├── issue-processor.js
│   │   │   ├── mention.js        -- Slack mention/command handling (list, close, etc.)
│   │   │   └── dedup.js
│   │   ├── gender-aliases/
│   │   │   ├── aliases.js        -- trigger detection + member pinging
│   │   │   └── sheet-cache.js    -- DynamoDB-backed gender cache with 7-day TTL
│   │   └── basketball/
│   │       ├── post-rollcall.js  -- scheduled message posting + weather
│   │       ├── weather.js        -- NOAA weather fetching
│   │       ├── reactions.js      -- reaction tracking + message update
│   │       ├── categorize.js     -- reaction emoji categorization
│   │       ├── slash-command.js  -- /ball command handling
│   │       ├── schedule-parser.js -- natural language → cron
│   │       └── format-message.js -- roll-call message formatting
│   ├── shared/
│   │   ├── slack.js              -- Slack API helpers (postMessage, getReactions, etc.)
│   │   ├── verify-signature.js   -- HMAC signature verification
│   │   └── config.js             -- env var loading + validation
│   ├── services/
│   │   ├── sheets.js             -- Google Sheets client (shared OAuth2 creds)
│   │   ├── groq.js               -- AI (maintenance only)
│   │   ├── conversation.js       -- DynamoDB state
│   │   └── pinpoint.js           -- SMS sending
│   └── lambda/
│       ├── slack.js              -- Slack Lambda entry point (wiring)
│       ├── sms.js                -- SMS Lambda entry point (wiring)
│       └── bball-post.js         -- Scheduled post entry point (wiring)
├── tests/
│   ├── features/maintenance/
│   ├── features/gender-aliases/
│   ├── features/basketball/
│   ├── handlers/
│   ├── shared/
│   └── services/
├── scripts/
│   └── deploy.sh                 -- deploy wrapper (preserves live schedule)
├── template.yaml
├── samconfig.toml
├── .github/workflows/deploy.yml
├── docs/
│   └── deployment.md
├── package.json
└── .gitignore
```

## Shared Slack API Module (`src/shared/slack.js`)

Ported from ffx-bball-bot's `shared/slack.js`. Provides:
- `postMessage`, `updateMessage`, `deleteMessage`
- `getHistory`, `getChannelHistory`, `getReactions`
- `getUserInfo`
- `notifyFailure` (DMs `U0000000000` on errors)
- `parseChannels` (comma-separated string → array)
- `getConversationMembers` (paginated channel member list — added for gender-aliases)

The maintenance Slack handler switches from `@slack/web-api` to these shared helpers, eliminating that dependency.

## Signature Verification (`src/shared/verify-signature.js`)

Ported from ffx-bball-bot's `verifySignature.js`. Handles:
- HMAC-SHA256 verification
- 5-minute timestamp window for replay protection
- Timing-safe comparison via `crypto.timingSafeEqual`
- Missing header detection

Replaces the inline signature verification in the current maintenance Slack handler.

## Config / Environment Variables

```
# Shared
SLACK_BOT_TOKEN          — Bot OAuth token (xoxb-...)
SLACK_SIGNING_SECRET     — Slack signing secret
SLACK_BOT_USER_ID        — Bot's own user ID (for reaction filtering)
GOOGLE_CLIENT_ID         — Google OAuth2 client ID
GOOGLE_CLIENT_SECRET     — Google OAuth2 client secret
GOOGLE_REFRESH_TOKEN     — Google OAuth2 refresh token
DYNAMODB_TABLE           — DynamoDB table name (SAM ref)

# Maintenance
MAINTENANCE_CHANNEL_IDS  — Comma-separated maintenance channel IDs
MAINTENANCE_SHEET_ID     — Google Sheet ID for maintenance issues
GROQ_API_KEY             — Groq API key
PINPOINT_APP_ID          — Amazon Pinpoint app ID
PINPOINT_NUMBER          — Pinpoint origination phone number

# Gender Aliases
GENDER_SHEET_ID          — Google Sheet ID for gender mappings

# Basketball
BBALL_CHANNELS           — Comma-separated basketball channel IDs
SCHEDULE_NAME            — EventBridge schedule name (SAM ref)
SCHEDULE_GROUP           — EventBridge schedule group (default: "default")
GIT_SHA                  — Deployed commit SHA (set by CI)
GITHUB_RUN_NUMBER        — GitHub Actions run number (set by CI)
```

Note: `SLACK_CHANNEL_IDS` is renamed to `MAINTENANCE_CHANNEL_IDS` for clarity now that there are multiple features using Slack.

## SAM Resources

- **SlackFunction** — API Gateway with two routes: `POST /slack/events`, `POST /slack/commands`. Policies: DynamoDB CRUD, EventBridge Scheduler get/update, IAM PassRole (for schedule updates).
- **SmsFunction** — SNS trigger. Policies: DynamoDB CRUD, Pinpoint SendMessages.
- **BballPostFunction** — EventBridge Scheduler trigger (Tue+Thu 8 AM ET). No special policies (just Slack API calls via env var token).
- **ConversationsTable** — DynamoDB with TTL enabled. Used for maintenance conversations + gender-aliases cache.
- **SmsTopic** — SNS for Pinpoint inbound SMS.
- **PostScheduleRole** — IAM role for EventBridge to invoke BballPostFunction.
- **PostSchedule** — EventBridge Scheduler schedule.

## GitHub Actions (`deploy.yml`)

Same structure as current, updated for new repo and params:
- Triggers: push to `main`, `workflow_dispatch`
- OIDC auth to AWS
- `npm ci` → `npm test` → `sam build` → deploy script
- Deploy script preserves live EventBridge schedule expression across deploys (from ffx-bball-bot's `deploy.sh`)
- Parameters passed via `--parameter-overrides` from GitHub Secrets and Variables

**Variables:** `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `MAINTENANCE_CHANNEL_IDS`, `MAINTENANCE_SHEET_ID`, `GENDER_SHEET_ID`, `BBALL_CHANNELS`, `PINPOINT_APP_ID`, `PINPOINT_NUMBER`, `SLACK_BOT_USER_ID`

**Secrets:** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GROQ_API_KEY`

## Dependencies

```json
{
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.0.0",
    "@aws-sdk/client-pinpoint": "^3.0.0",
    "@aws-sdk/client-scheduler": "^3.0.0",
    "@aws-sdk/lib-dynamodb": "^3.0.0",
    "googleapis": "^171.4.0",
    "openai": "^6.33.0"
  },
  "devDependencies": {
    "vitest": "^4.1.3"
  }
}
```

No `@slack/web-api` — all Slack API calls go through the shared `slack.js` helper using `fetch`.

## Migration Path

This is a new repo, not a modification of existing repos. Steps:

1. Create `dmv-community-bot` repo on GitHub
2. Initialize with the project structure above
3. Port maintenance bot code (restructure into `features/maintenance/`)
4. Port ffx-bball-bot code (restructure into `features/basketball/`)
5. Rewrite gender-aliases in Node.js (`features/gender-aliases/`)
6. Build shared Slack router and API helpers
7. Build unified SAM template
8. Build deploy workflow + deploy script
9. Configure single Slack app with all required scopes and event subscriptions
10. Deploy, test end-to-end
11. Decommission old repos/infra (GCP VM, old SAM stacks)

## Slack App Configuration (Manual)

One Slack app needs these scopes:
- `app_mentions:read` (maintenance)
- `channels:history`, `channels:read` (all features)
- `groups:history`, `groups:read` (gender-aliases in private channels)
- `chat:write` (all features)
- `reactions:read`, `reactions:write` (basketball, maintenance)
- `users:read` (gender-aliases, basketball, maintenance)
- `commands` (basketball `/ball`)

Event subscriptions:
- `app_mention`
- `message.channels`
- `message.groups`
- `reaction_added`
- `reaction_removed`

Slash commands:
- `/ball` → `POST /slack/commands`

## What's NOT in Scope

- Manager notification replacement (SMS/email for medium/critical) — separate feature
- Weekly digest — was already removed
- GCP infrastructure teardown — manual after migration verified
- Old repo archiving — manual
