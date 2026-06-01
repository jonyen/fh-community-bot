# Fold ffx-bball-bot into fh-community-bot

**Date:** 2026-06-01
**Status:** Approved (design)

## Goal

Collapse two separate Slack bots into **one Slack app, one SAM stack, one
GitHub repo**. After the fold, the surviving `fh-community-bot` repo serves
three feature sets behind a single Slack app:

1. **fh-maintenance** — `@mention` → maintenance-issue tracking (existing)
2. **gender aliases** — gender-trigger replies + `/refresh-genders` (existing)
3. **bball roll-call** — twice-weekly Fairfax basketball post + RSVP-via-reaction
   roster + `/ball` command (folded in from `ffx-bball-bot`)

The `ffx-bball-bot` repo and its CloudFormation stack are retired.

## Decisions (locked)

- **Git history:** clean copy. ffx files land as new commits; ffx history
  stays only in the archived repo.
- **Slack app:** keep **fh's** existing Slack app, token, and signing secret.
  Add ffx's event subscriptions, slash command, and OAuth scopes to it.
- **Code integration:** rewrite ffx handlers onto fh's `@slack/web-api`
  `WebClient`. Delete ffx's fetch-based `shared/slack.js` and its
  `verifySignature.js`. One Slack-call style, one signature verifier.
- **Schedule control:** **scheduled post only.** Keep the Tue/Thu auto-post.
  Drop the runtime `/ball schedule` subcommand (view/update/pause/resume). The
  schedule expression lives in the SAM template default and changes via
  redeploy. No scheduler IAM on the worker, no live-expression preservation in
  deploy.

## Architecture after the fold

### Lambdas

| Lambda | Trigger | Role | Change |
|--------|---------|------|--------|
| `ReceiverFn` | Function URL (sync) | Verify Slack signature, enqueue to SQS | reaction events already pass its gate (`type !== "message"` → enqueue); `/ball` already enqueues via the generic slash path. Effectively no code change. |
| `WorkerFn` | SQS (async) | Dispatch envelopes to handlers | **Extended**: route `/ball` and `reaction_added`/`reaction_removed`; gains new env vars. No scheduler IAM. |
| `PostMessageFn` | EventBridge Scheduler | Post the roll-call message | **New**, ported from ffx. No Slack ingress. |
| `PostSchedule` (`AWS::Scheduler::Schedule`) + `PostScheduleRole` (IAM) | — | Tue/Thu 8am ET (`cron(0 8 ? * TUE,THU *)`, `America/New_York`) | **New**, ported from ffx template. |

### Sync → async conversion

ffx's reaction and `/ball` handlers respond synchronously to Slack's HTTP
request today. A single Slack app has **one** Event Subscriptions URL, so
reactions must flow through fh's receiver → SQS → worker pipeline. Therefore:

- Receiver acknowledges `200` immediately (already its behavior).
- Worker performs the work asynchronously.
- `/ball` ephemeral replies (usage help, `/ball info`, error messages) are
  posted via Slack `response_url` (the envelope already captures it). Actual
  message posts/edits/deletes go through the `WebClient`.
- Reaction handling needs no response — it just updates the bot's roster
  message.

`src/events/slashRefresh.js` is the existing precedent for this async +
`response_url` pattern.

### Request flow

```
Slack Events API ─┐
Slack /ball       ├─► ReceiverFn (Function URL) ─► verify sig ─► SQS ─► WorkerFn ─► dispatch
Slack /refresh    ┘                                                                   ├─ mention handler
Slack reactions  ─┘                                                                   ├─ gender handler
                                                                                      ├─ slashRefresh handler
                                                                                      ├─ ball handler        (NEW)
                                                                                      └─ reaction handler    (NEW)

EventBridge Scheduler (Tue/Thu 8am ET) ─► PostMessageFn ─► chat.postMessage   (NEW, separate path)
```

## Code layout

New / ported files under `src/`:

```
src/events/ball.js          createBallHandler({ client, weather, botUserId, channels,
                                                 gitSha, runNumber })
                            handle({ envelope }) — post / edit / delete / info
                            (NO schedule subcommand)
src/events/reaction.js      createReactionHandler({ client, botUserId })
                            handle({ event }) — recategorize roster, chat.update
src/lambda/postMessage.js   scheduled roll-call entry point + its own deps slice
src/lib/formatMessage.js    ← ffx src/shared/formatMessage.js   (pure, verbatim)
src/lib/scheduleParser.js   ← ffx src/shared/scheduleParser.js  (pure, verbatim) †
src/lib/categorize.js       ← ffx src/reactionHandler/categorize.js (pure, verbatim)
src/services/weather.js     ← ffx src/postMessage/weather.js    (fetch-based, verbatim)
```

† `scheduleParser.js` is only consumed by the dropped `/ball schedule`
subcommand. **Do not port it** unless a use surfaces. Listed here so the
mapping from ffx is complete. (Decision: drop it.)

**Deleted from the ffx source (not ported):**
- `src/shared/slack.js` — every method maps onto `WebClient`:
  `chat.postMessage`, `chat.update`, `chat.delete`, `conversations.history`,
  `reactions.get`, `users.info`. `notifyFailure` reuses the client to DM the
  failure user.
- `src/reactionHandler/verifySignature.js` — fh's `src/lambda/slack-signature.js`
  is the one verifier.
- `src/shared/scheduler.js` — not needed (schedule control dropped).
- `src/slashCommand` schedule branch — dropped.

## Wiring & configuration

### `src/lambda/clients.js` (`getDeps`)
Add to the DI graph:
- `weatherService` (from `src/services/weather.js`)
- `ballHandler = createBallHandler({ client, weather, botUserId, channels, gitSha, runNumber })`
- `reactionHandler = createReactionHandler({ client, botUserId })`

`PostMessageFn` uses a focused deps slice (client + weather + channels +
botUserId) — it does not need the gender/groq/sheets graph.

### `src/config.js`
Add env vars:
- `SLACK_BOT_USER_ID` — required for reaction filtering and roster categorization.
- `BBALL_CHANNEL_IDS` — ffx's `SLACK_CHANNELS`, **renamed** to avoid collision
  with fh's existing `SLACK_CHANNEL_IDS`.
- `GIT_SHA`, `GITHUB_RUN_NUMBER` — surfaced by `/ball info` (default `unknown`).

`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are shared (single app).

### `src/lambda/dispatch.js`
Add routing branches; leave existing branches untouched:
- `slash_command` + `command === "/ball"` → `ballHandler`
- `reaction_added` / `reaction_removed` → `reactionHandler`

## Infrastructure (`template.yaml`)

- **New parameters:** `SlackBotUserId`, `BballChannels`, `GitSha` (default
  `unknown`), `GithubRunNumber` (default `unknown`).
- **`WorkerFn` env additions:** `SLACK_BOT_USER_ID`, `BBALL_CHANNEL_IDS`,
  `GIT_SHA`, `GITHUB_RUN_NUMBER`. No new IAM policies.
- **New resources:** `PostMessageFn` (+ its `LogGroup`), `PostScheduleRole`,
  `PostSchedule`. Ported from ffx `infra/template.yaml`, adjusted for fh's
  `src/` code layout and runtime (`nodejs22.x`, arm64).
- `PostMessageFn` env: `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`,
  `BBALL_CHANNEL_IDS`.

## Dependencies

- No new npm dependency. (`@aws-sdk/client-scheduler` is **not** needed —
  schedule control dropped. Weather uses native `fetch`.)

## Deploy (`.github/workflows/deploy.yml`)

Extend the single existing fh workflow with new `--parameter-overrides`:
- `SlackBotUserId=${{ secrets.SLACK_BOT_USER_ID }}`
- `BballChannels=${{ vars.BBALL_CHANNEL_IDS }}`
- `GitSha=${{ github.sha }}`
- `GithubRunNumber=${{ github.run_number }}`

No schedule-expression preservation step (not needed — template default is the
source of truth).

## Tests

- Pure-logic ffx tests port near-verbatim: `categorize`, `formatMessage`,
  `weather`.
- Handler tests (`reactionHandlerHandler`, `slashCommandHandler`,
  `postMessageHandler`) are **rewritten** to mock the injected `WebClient`
  instead of the deleted fetch-based `slack.js`, and to assert the async
  (`response_url`) behavior for `/ball` ephemerals.
- Drop tests for removed code: `slack.test.js`, `verifySignature.test.js`,
  `scheduleParser.test.js`, and any `/ball schedule` assertions.
- The pre-deploy `npm test` gate must stay green.

## Migration (one-time, manual — destructive steps flagged)

These steps are done by the operator in the Slack and AWS consoles, in order:

1. **Slack app (keep fh's app):**
   - Point the app's Event Subscriptions Request URL at the fh `ReceiverFn`
     Function URL (already the case if fh is live).
   - Subscribe to `reaction_added` and `reaction_removed` (in addition to the
     existing `message.*` / `app_mention`).
   - Add the `/ball` slash command → same `ReceiverFn` URL.
   - Union the OAuth scopes ffx needs onto fh's app:
     `reactions:read`, `users:read`, `channels:history` (verify against the
     ffx app's current scope list before cutover).
   - Reinstall the app if scopes changed.
2. **Schedule cutover (avoid double-posting):**
   - Read the live `ScheduleExpression` from the old `ffx-bball-bot` schedule;
     set it as the `PostSchedule` default (or a deploy override) in the fh
     stack.
   - Deploy the fh stack with the new bball resources.
   - **Delete or disable the old `ffx-bball-bot` CloudFormation stack** so its
     EventBridge schedule no longer fires. Until this is done, both stacks
     would post the roll-call. ⚠️ Destructive — confirm the fh post works first.
3. **Repo:** archive the `ffx-bball-bot` GitHub repo. Optionally remove the
   local `../ffx-bball-bot` checkout.

## Out of scope / YAGNI

- `/ball schedule` runtime control (view/update/pause/resume) — dropped.
- `scheduleParser.js`, `scheduler.js`, `@aws-sdk/client-scheduler` — not ported.
- Preserving ffx git history — clean copy chosen.
- Unrelated refactoring of existing fh code.
