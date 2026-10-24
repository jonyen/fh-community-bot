# fh-community-bot

A Slack bot for managing facilities maintenance issue reporting and tracking. Mention the bot in a Slack channel and it posts an in-thread report form; submitting the form logs the issue to Google Sheets.

## Features

- **Issue reporting** via Slack @mentions — the bot replies with an in-thread form (description, issue type: Lighting / Elevator / Pest Control / Electrical / Plumbing / HVAC / Janitorial / Other, severity: Minor / Medium / Critical); submission is logged to Google Sheets
- **Form pre-fill** — the description comes straight from the @mention, and the type and severity are read out of it by the LLM; a report the model won't commit on leaves those dropdowns empty rather than guessing wrong. Falls back to a keyword table when the model is unreachable
- **Duplicate detection** — two-pass strategy using keyword matching + LLM verification (warn-only: a possible duplicate is noted in the confirmation)
- **Issue management** — list open issues, close/resolve by ID or description
- **Photo attachments** — photos on a report or thread reply are copied to Google Drive and linked in the sheet's Photos column (internal links)
- **Reservations** — members book, check and list rooms, the kitchen and RMS equipment privately with `/reserve` in #reservations; booking requests go into a private tray booked with **Reserve all**. First come, first served. #reservations also holds the weekday and weekend digests (see below)

## Architecture

```
Slack ──HTTPS──▶ ReceiverFn (Lambda Function URL)
                        │
                        ▼
                  EventQueue (SQS FIFO, per user) ──▶ WorkerFn (Lambda)
                                              │
                                              ▼
                       Claude API · Google Sheets · Slack Web API
```

Two AWS Lambdas. SQS in between for the 3-second Slack ack budget. No VPC, no
database. The worker runs as concurrent, ephemeral Lambda containers, so
conversation state can't live durably in process memory. Report submission
avoids this entirely: the in-thread form message carries its own state, and the
`block_actions` payload Slack sends on Submit contains every field value. The
same endpoint receives both Events API posts and interactivity payloads
(enable **Interactivity** in the Slack app config with the same Request URL, and
set the **Options Load URL** to it too, for the reservation form's item search).

Slack redelivers a payload up to three times when it doesn't get a response
within those 3 seconds, which a cold start can miss. Duplicates are suppressed
in two places: the receiver acks but doesn't re-enqueue a retry whose
`X-Slack-Retry-Reason` is `http_timeout` (we did get it, we just answered
late), and the submit path refuses to write a second sheet row for a thread
that already has one — the hidden `SLACK_REF` column makes the thread ts the
idempotency key.

## Tech Stack

- AWS Lambda (Node 22, arm64), SQS, CloudWatch Logs
- AWS SAM for IaC
- GitHub Actions + OIDC for deploys
- [Slack Web API](https://slack.dev/) (Events API, not Socket Mode)
- [Google Sheets API](https://developers.google.com/sheets/api)
- Claude Haiku on the [Anthropic API](https://docs.anthropic.com/) — duplicate detection, form
  pre-fill, reservations parsing and the CREA rewrite. Calls use the `ANTHROPIC_API_KEY` repo
  secret (source of truth: Doppler `personal/prd` as `FHBOT_ANTHROPIC_API_KEY`) and bill to that
  key's Console credits; the model is the `LLM_MODEL_ID` repo variable (default `claude-haiku-4-5`).
  Every failed call emits `LlmCallFailed`, which the `fh-community-llm-failed` alarm posts to Slack.
  The pre-fill call goes through
  `createIssueClassifierService`, which depends only on a
  `classifyIssueReport(text, { types, severities })` method: pointing it at
  another provider means writing that one method in a new service and swapping
  the argument in `src/lambda/clients.js`.

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
| `ANTHROPIC_API_KEY` | Anthropic API key for the LLM calls |
| `LLM_MODEL_ID` | (Optional) Anthropic model id for the LLM calls |
| `GOOGLE_DRIVE_FOLDER_ID` | (Optional) Drive folder ID for uploaded issue photos |

To generate a Google refresh token:

```bash
node scripts/get-google-token.js <client_id> <client_secret>
```

## Photos

Users can attach photos to a maintenance report (or to any reply in the issue's thread). Each image is copied from Slack into a Google Drive folder and listed as a clickable link in the sheet's **Photos** column (column I), which grows as more photos are added in the thread.

The links are **internal**: the uploaded files are not made public (the Workspace org blocks "anyone with link" sharing), so they open for people who can already see the Drive folder / spreadsheet. There is no inline thumbnail — Google Sheets' `=IMAGE()` can only render publicly accessible images, which this setup intentionally avoids.

One-time setup:

1. **Regenerate the Google refresh token** with Drive access. `scripts/get-google-token.js` requests both the Sheets scope and `drive.file` (which lets the app manage only the files it creates). The `google-token` GitHub workflow does this entirely from CI. Update `GOOGLE_REFRESH_TOKEN` afterward.
2. **Enable the Google Drive API** in the Cloud project (it's separate from the Sheets API).
3. **Create a Drive folder** for issue photos, share it (and/or the spreadsheet) with the people who should see the photos, give the token's Google identity edit access, and set the folder ID as the `GOOGLE_DRIVE_FOLDER_ID` repo variable. If unset, photos upload to the account's Drive root.
4. **Add the `files:read` Slack OAuth scope** (needed to download uploaded files) and reinstall the app.

Run the `verify-drive` workflow any time to confirm the token can upload into the configured folder.

The Event Subscriptions already in place for the gender feature (`message.channels` / `message.groups`) also deliver the `file_share` events that carry photos, so no additional event subscriptions are needed.

## Filing with CREA (landlord)

A facilities lead (listed in `CREA_TICKET_USER_IDS`) reacts to a logged report (the original message or anything in its thread) with :ticket: 🎫 or :admission_tickets: 🎟️ and the bot posts a draft service issue in the thread for CREA LLC's Rent Manager tenant portal (`creallc.twa.rentmanager.com`). Nothing is filed until someone on the list hits **Send to CREA** on the draft. Only reports CREA is responsible for should get a ticket.

- The draft starts from the sheet row's description, rewritten by the model into a clear, factual request (`writeLandlordTicket` in `src/services/llm.js`). If the model fails, it starts from the description as written. The sheet keeps the original wording.
- The description is editable, and so is the title when the type is Other (the portal files every other type under the type's name). The text goes to CREA exactly as it stands in the draft; severity and the reporter's name are not sent. The type is re-read from the sheet when Send is pressed.
- The photos on the original report are attached. The portal only takes GIF, JPEG and PNG up to 5 MB, so anything else (iPhone HEIC, oversized images) is sent as a JPEG made from Slack's largest preview (about 1024px).
- Anyone on the list can send or cancel a draft, not only whoever reacted. Cancel deletes the draft so a later 🎫 starts over.
- The bot marks the report with 📨 (`:incoming_envelope:`) when it posts the draft. Slack won't let it add that reaction twice, so a second 🎫 on the same report does nothing while a draft is open or after it is sent.
- After sending, the draft is replaced with exactly what CREA received, and the sheet's NOTES column gets a "sent to CREA portal" line.
- On failure the draft comes back with the edits kept and the bot explains in the thread; hit Send again to retry.
- If the portal's reply isn't recognised, the bot asks someone to check Service Issues in the portal before resending.
- Anyone not on the list who adds 🎫 or presses a draft button gets a private note saying only the facilities leads can send to CREA.

Rent Manager's REST API would be cleaner, but CREA's instance isn't licensed for it ("You do not have licensing for this product"), so the bot logs in to the tenant portal and posts its HTML forms (`src/services/rentManagerTwa.js`).

Setup:

1. Store the portal login as repo secrets `CREA_TWA_USERNAME` / `CREA_TWA_PASSWORD`, and the contact phone the portal requires as repo variable `CREA_TWA_PHONE`. Set repo variable `CREA_TICKET_USER_IDS` to the comma-separated Slack member IDs allowed to file (empty means nobody). Optional variable `CREA_TWA_ALLOW_ENTRY` (`true`/`false`, default `false`) answers "Is technician allowed to enter if tenant is not present?".
2. Slack app: add the `reactions:read` bot scope, subscribe to the `reaction_added` bot event, and reinstall.
3. Check the login without filing anything: run the `crea-login-check` workflow (`gh workflow run crea-login-check`), or locally `doppler run -- node scripts/crea-twa-login-check.mjs`.

The feature is switched by repo variable `CREA_TICKETS_ENABLED` (`true`/`false`, default `false`). Unless it is `true` and the portal login is set, ticket reactions are ignored. Changing it takes effect on the next deploy.

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

The bot posts only the mention list — the user's message body is dropped:

- `@bros hello` → `<@u1> <@u2>`
- `@bros and @sis, hello` → `<@u1> <@u2> <@v1> <@v2>` (in encounter order)
- Bare `!bros` → `<@u1> <@u2>`

Replies are always posted by the **Gender Aliases** bot persona (username `Gender Aliases`, avatar 👥) via `chat:write.customize`.

Ephemeral notices (visible only to the caller) use the same persona:

- `/refresh-genders` slash command result (`Refreshed gender map. N entries loaded.` or `Refresh failed: ...`) — posts via Slack's `response_url`.
- "No `<gender>` members configured for this channel." when no match — posts via `chat.postEphemeral`.

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

- **OAuth scopes (bot):** add `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `users:read.email` (for the `scripts/backfill-slack-ids.js` script), and `chat:write.customize` (to post replies under the Gender Aliases persona). Reinstall the app afterwards.
- **Slash command:** create `/refresh-genders` under Slack app config → Slash Commands. Set the Request URL to the same Receiver Function URL used for Event Subscriptions. No usage hint is required.
- **Event Subscriptions:** subscribe to `message.channels` (public) and `message.groups` (private) bot events, in addition to `app_mention`.
- Invite the bot to each channel where these triggers should work.

## #reservations

The bot is the front door for FH's four reservation systems. Members book and
ask privately with `/reserve` in #reservations. Nobody else sees the request,
and every answer is visible only to the member who asked:

- `/reserve Tech Set 2 Sat 2-4pm for youth night`
- `/reserve is the MPR free Wednesday 7-9?`
- `/reserve who has the pickleball set this weekend?`
- `/reserve what do I have booked?`

What each kind of request gets:

- **Booking requests** go into the member's tray (see below) as one line per
  item, with the request's day, time and what it's for. The private listing
  card shows the tray with each line's availability. The member checks it,
  fixes anything with **Edit**, and presses **Reserve all**. Nothing is booked
  before that. A request naming no item, an item the bot doesn't know, or an
  ambiguous one gets a private reply asking which.
- **Questions** (is it free, who has it, what's booked, "what speakers are
  there?") are answered privately.
- `/reserve` alone, or `/reserve what can I reserve`, opens the listing card.
- **"What do I have booked?"** gets a private list: the member's bookings from
  today through 60 days ahead, at most 20 lines, each with its own **Cancel**
  (behind a confirm dialog). Bookings the bot made are matched exactly. Rows
  typed into the sheets by hand are matched by name (and, for the kitchen,
  phone), so those lines say `from the rooms sheet, matched by name` and the
  confirm dialog quotes the row as typed. Without connected accounts, a
  calendar event the member made themselves gets an **Open in Calendar** link
  instead of Cancel.
- Used in any other channel, `/reserve` says to use it in #reservations.

#reservations sees bookings in its digest; confirmations are not broadcast.

### Posting in the channel

A request or question posted as a plain message in #reservations gets no
answer in the thread. Instead the poster gets a private nudge to use
`/reserve`, with their own message as the example. Every time, but once per
message: a redelivery doesn't repeat it (claimed as
`once#nudge:<channel>:<ts>`). Chatter gets nothing, and thread replies are left
to people.

### Booking cards from before /reserve

Booking cards the bot posted in threads before this change still work:

- **Book** checks for a conflict again and writes the booking straight into the
  system that owns the item. The card is replaced by the confirmation.
- **Edit** opens a form pre-filled from the card. Submitting it updates the
  card; it does not book.
- **Cancel** on an open card closes it (`🚫 Cancelled by @member.`). Nothing
  is written.
- A booked card keeps a **Cancel booking** button. After a confirm dialog it
  releases the booking: a rooms row is marked `Canceled` in Status (the row
  stays), a kitchen row is cleared (the dated row stays), and a calendar event
  is deleted, or only its resources are removed when it has other guests. The
  card keeps its ✅ line and adds `🚫 Booking cancelled by @member.` A booking
  that was edited since, or has already ended, is not touched.
- Only the member who asked can press Book, Edit, Cancel or Cancel booking.

### Welcome

When someone joins #reservations, the bot tells them privately (an ephemeral
message, visible only to them) that everything goes through `/reserve`, with
examples for booking, asking and browsing. Every join, rejoins included; a
redelivery of the same join is dropped (`once#welcome:<user>:<event_ts>`).

The welcome and the nudge's redelivery check use the reservations table and
are off when it isn't configured. The welcome needs the
`member_joined_channel` bot event under Event Subscriptions in the Slack app.

### Browsing and reserving several things at once

Post `list items to reserve` (or `what can I reserve?`) in #reservations. The
bot replies with a private card, visible only to you, listing everything that
can be reserved: rooms, the kitchen, equipment and vehicles. Add words to start
with a search, such as `list speakers to reserve`.

- **Search and filter.** Type in the search box and press Enter. The bot first
  matches your words against item names, room nicknames and categories. If
  nothing matches, it asks the model which items fit. The category menu
  narrows the list further. The list shows 8 items per page. **Close** removes
  the card; your tray is kept.
- **The tray.** **+ Add** puts an item in your tray and opens its form on the
  same card: date, start, end and title (kitchen appliances also ask for the
  equipment). A new line starts with the details of the line before it. The
  form tells you right away whether the item is free, or who has it on which
  dates. **Save** keeps the line, **Remove** drops it, **Back** leaves without
  saving.
- **Repeats.** Choose **Weekly**, pick the days, and set an end date. The
  first date is the line's date, and a repeat can run up to 6 months.
- **Limits.** The tray holds up to 10 lines and up to 60 dates in one Reserve
  all. It is kept for 24 hours; if you leave it untouched longer, it clears.
  Asking for the list again shows your existing tray.
- **Reserve all.** The bot books every date that is still free, across the
  rooms sheet, the kitchen sheet and the calendars, and posts one combined
  message in the channel. The message lists what was booked and, under
  "Not booked", what wasn't and why (already claimed by someone, kitchen sheet
  not open for that date yet, a calendar that declined, and so on). Dates that
  weren't booked stay in your tray so you can change them and try again. A date
  marked "may already be booked, please check" is removed from the tray: look
  at the sheet or calendar before booking it again.
- **Cancelling.** Each booked line in the combined post has its own **Cancel**.
  For a repeat, the bot asks whether to cancel the whole series or one date.
  "What do I have booked?" shows a series as one line with the same choice.

Typed requests still work as before. The bot now posts in #reservations as
"Reservations".

The request rides in the card's buttons, so the bot stores nothing. A second
press, or a press on a card that was edited since, does nothing. Bookings are
first come, first served, with no approver. Members who want to book privately
use the sheet or calendar directly; the digests pick those bookings up.

| Category | Owner | Backend |
| --- | --- | --- |
| Rooms | Management | Management Workspace, tab *Upcoming Room Requests* (Status left blank for Management) |
| Kitchen | Arie Chen | FH Kitchen Management, tab *FH-Kitchen-RSVP* (max 3 groups at once) |
| Tech | Alan Chow | RMS resource calendars, Tech Set 1–4 |
| Sports, outreach, accessories | Joe Pagan (accessories: none) | RMS resource calendars |
| Vehicles | Brandon Lenz (Airstream), Mark Yeh (CP Transit) | RMS resource calendars |

`DigestFn` posts two digests to #reservations at 8:00 AM New York time: Monday
covers Monday–Thursday, and Friday covers Friday–Sunday. Each lists reservations
from all sources, including bookings made directly in the docs and calendars.
After each booking it makes, the bot edits the digest that covers that date in place.
If a source can't be read, the post says so and `ESCALATION_USER_ID` gets a DM.

### Booking as yourself (connected Google accounts)

Bookings are written as the member who asked, so calendars show the real
organizer and the sheets' edit history shows the real person. The first time a
member books, the bot sends them a private "Connect Google" button. They sign
in with their acts2.network account (it must match their Slack email) and
approve Calendar and Sheets access, and the booking finishes on its own. To
disconnect, use `/reservations-disconnect`.

Reads (check, list, the digest) still use the bot's Google token.

One-time setup:

1. In a GCP project owned by the acts2.network organization, set the OAuth
   consent screen to **Internal** and enable the Calendar and Sheets APIs.
2. Create a **Web application** OAuth client. Add the stack output
   `OAuthRedirectUri` as an authorized redirect URI.
3. Save its id and secret as GitHub secrets `GOOGLE_WEB_CLIENT_ID` and
   `GOOGLE_WEB_CLIENT_SECRET`, and redeploy.
4. In the Slack app, add the slash commands `/reservations-disconnect` and
   `/reserve` with the receiver's Function URL as their request URL.

Repo variables: `RESERVATIONS_CHANNEL_ID`, `ROOM_REQUESTS_SHEET_ID`,
`KITCHEN_SHEET_ID`, `RESOURCE_CALENDARS` (bundled as
`runtime-config/resource-calendars.json` at deploy because it is over the 4 KB
env limit), and optionally `RMS_BOOKING_ENABLED=false`. The bot must be a member
of #reservations, and the bot's Google account needs edit access to both sheets.

## Observability

**SLO: 99.5% of submitted issue reports reach the Google Sheet, monthly.**

The SLI is the `FhCommunityBot/IssueLogged` metric rather than Lambda success —
a worker that completes without writing a row is a failure by this definition,
because somebody filed an issue and nobody will see it.

- **Structured logs.** One JSON object per line. Every line from a Slack event
  carries the same `correlationId` (the SQS message id), which survives a DLQ
  redrive, so a replayed message logs under the same id as its first attempt.
- **Metrics** via CloudWatch Embedded Metric Format — carried inside the log
  line, so no `PutMetricData` call, no latency on the request path, no
  per-metric cost.
- **Alarms** publish to the `fh-community-alarms` SNS topic, relayed to Slack by
  a dedicated Lambda that deliberately avoids the bot's own code path.
  Subscribe an email address to the same topic for a path that survives a Slack
  outage.
- **Dashboard** `fh-community-bot`, defined in `template.yaml`.

| Alarm | Fires when |
| --- | --- |
| `dlq-not-empty` | Events failed 3× and landed in the DLQ |
| `queue-backlog` | Oldest event waiting over 5 minutes |
| `issue-write-failed` | An issue could not be written to the Sheet |
| `receiver-slow` | Receiver p99 above 2s against Slack's 3s deadline |
| `digest-failed` | The reservations digest errored and posted nothing |

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for diagnosis steps and the DLQ
redrive procedure.

## Project structure

```
src/
  config.js                  # env loading
  events/mention.js          # @mention business logic (Slack-runtime-agnostic)
  services/sheets.js         # Google Sheets CRUD
  services/llm.js            # LLM client (Claude API)
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
