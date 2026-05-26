# Gender Aliases — Port into fh-community-bot

**Date:** 2026-05-26
**Status:** Approved (design phase complete; pending implementation plan)

## Goal

Port the functionality of `~/Projects/gender-aliases` (Python slack-bolt Socket Mode bot) into this Lambda-based Slack bot so it lives alongside the existing maintenance-request feature. Users typing `!bros` / `@sis` / etc. in any channel the bot has joined trigger a Slack ping of all channel members mapped to that gender in a Google Sheet.

## Non-goals

- Replacing or modifying the existing maintenance-request flow.
- Standing up new infrastructure (no new Lambda, queue, table, or stack).
- Migrating the gender data store away from Google Sheets.

## Source feature recap (from gender-aliases)

| Behavior | Source |
|---|---|
| Triggers | `!bros`, `!brothers`, `@bros`, `@brothers`, `!sis`, `!sisters`, `@sis`, `@sisters`, `!refresh-genders`, `@refresh-genders` |
| Match regex | `(?:^|\s)[!@](bros\|brothers\|sis\|sisters)\b`, case-insensitive |
| Refresh regex | `(?:^|\s)[!@]refresh-genders\b` |
| Data source | Google Sheet, columns `user_id`, `gender ∈ {male, female}`, header row 1 |
| Cache | In-memory + disk JSON, TTL 7 days |
| Member lookup | `conversations.members` paginated (limit 200) until cursor exhausted |
| Response | `<@caller> pinged <gender>s: <@u1> <@u2> ...` |
| Empty case | `No <gender> members configured for this channel.` |
| Refresh response | `Refreshed gender map. <N> entries loaded.` |

## Decisions (locked during brainstorming)

1. **Single Slack app, single Lambda.** Add handler to existing `WorkerFn`; no new infra.
2. **Data source:** new tab `Gender Map` on the existing `GOOGLE_SHEET_ID`. Reuses OAuth refresh-token auth path; no new secret.
3. **Triggers:** keep gender-aliases originals (`!bros`/`@sis` and `@`-prefixed variants).
4. **Cache:** in-memory module-scope only. No disk, no DynamoDB, no S3. TTL 7 days. Refilled on cold start or after `!refresh-genders`.
5. **Channel scope:** triggers fire in **any channel the bot is a member of**. Does not honor the `SLACK_CHANNEL_IDS` allowlist (which remains gating the maintenance handler).

## Architecture

```
Slack event
  └─> ReceiverFn (HTTP, sig verify, prefilter) ──> EventQueue (SQS)
                                                       │
                                                       ▼
                                                   WorkerFn
                                                       │
                                              dispatchSlackEvent
                                              ┌────────┴────────┐
                                              ▼                 ▼
                              gender regex match?      else (existing path)
                                       │                       │
                                       ▼                       ▼
                              gender.handler            mention.handler
                                       │                  (unchanged)
                          ┌────────────┼─────────────┐
                          ▼            ▼             ▼
                  genderMap.getMap()  conversations.members  chat.postMessage
                  (in-memory cache,
                   7-day TTL,
                   sheets fallback)
```

## Components

### New: `src/services/genderMap.js`

Reads the `Gender Map` tab and caches the result.

**Exports:** `createGenderMapService({ sheetsClient, spreadsheetId, ttlMs, tabName })`

**Returns:**
- `getMap()` → `Promise<{ [userId]: 'male' | 'female' }>`. Returns cached map if within TTL; otherwise fetches sheet, parses, caches, returns. Bad rows (missing/blank `user_id`, gender not in `{male, female}`) are skipped.
- `invalidate()` → clears cache, forces next `getMap()` to refetch. Returns the new entry count.

**Cache:** module-scope JS object `{ fetchedAt: number, data: object }`. No locks (Lambda invocations are single-threaded per container; concurrent invocations get separate containers).

**Sheet range:** `'<tabName>'!A2:B`.

### New: `src/events/gender.js`

**Exports:** `createGenderHandler({ genderMapService })`

**Returns:** `async function handleGender({ event, say, client })`

**Flow:**
1. Match `event.text` against trigger regex and refresh regex.
2. If refresh regex matches:
   - Call `genderMapService.invalidate()`, then `getMap()` to repopulate.
   - Reply `Refreshed gender map. <N> entries loaded.` on success; `Refresh failed: <err>` on exception.
   - Return.
3. Determine target gender from regex captures (`bros|brothers` → `male`; `sis|sisters` → `female`). Multiple matches: prefer the first; if both genders appear in one message, no-op (or pick whichever appeared first — match Python's `if matches & MALE: ... elif matches & FEMALE` which prefers male — replicate that exactly).
4. `genderMapService.getMap()`; on failure reply `Could not load gender map: <err>`, return.
5. Paginate `client.conversations.members({ channel, cursor, limit: 200 })` until no `next_cursor`. On failure reply `Could not list channel members: <err>`, return.
6. Filter members by `map[uid] === target`. If empty: reply `No <gender> members configured for this channel.`, return.
7. Post `<@caller> pinged <gender>s: <@u1> <@u2> ...` to `event.channel` (top-level, **not** threaded).

**Reply channel:** top-level (no `thread_ts`). Matches gender-aliases source behavior.

### Modified: `src/lambda/dispatch.js`

Two new pieces:
1. **Trigger regex constants** (exported for testing): `GENDER_TRIGGER_RE`, `GENDER_REFRESH_RE`.
2. **Routing logic** in `dispatchSlackEvent`. Before current `shouldSkip` filter, check if the event is a `message` whose text matches either gender regex. If so, call `genderHandler({ event, say, client })` and return — bypass the maintenance handler entirely. Otherwise current behavior (mention/thread routing).

`shouldSkip` itself does not need changes — the gender route runs before `shouldSkip` is consulted.

### Modified: `src/lambda/receiver.js`

Currently enqueues every event into SQS. To bound queue volume now that we are accepting `message.channels` events:

- If `event.type === 'message'`, enqueue only if its text matches the gender regex (either trigger) **or** the existing mention/thread predicate already used by `shouldSkip` (mention pattern OR `thread_ts` present + not bot + not subtype).
- Other event types unchanged.

This keeps the receiver as the cheap "drop chatter early" layer, so the SQS+worker path stays low-volume.

**Trade-off acknowledged:** the gender regex now lives in two places (receiver prefilter and dispatch router). Acceptable — both import from a single `src/lib/gender-triggers.js` source of truth.

### New: `src/lib/gender-triggers.js`

Exports `GENDER_TRIGGER_RE`, `GENDER_REFRESH_RE`, `matchesGenderEvent(text)` (boolean — true if either regex hits). Used by receiver and dispatch.

### Modified: `src/lambda/clients.js`

Wire `genderMapService` and `genderHandler` into deps and pass to dispatcher.

```js
const genderMapService = createGenderMapService({
  sheetsClient,
  spreadsheetId: config.googleSheetId,
  ttlMs: 7 * 24 * 3600 * 1000,
  tabName: 'Gender Map',
});
const genderHandler = createGenderHandler({ genderMapService });
cached = { client: slack, handler: mentionHandler, genderHandler };
```

Worker passes both handlers into `dispatchSlackEvent`.

### Modified: `src/lambda/worker.js`

Pass `genderHandler` through to `dispatchSlackEvent`.

## Data: sheet schema

New tab on existing `GOOGLE_SHEET_ID`:

- Tab name: `Gender Map` (configurable later if needed; not env-driven in v1).
- Row 1: header (`user_id`, `gender`).
- Row 2+: data.
- Column A: Slack user ID (e.g. `U01ABC123`).
- Column B: literal string `male` or `female` (case-insensitive on read; normalized lowercase in cache).

OAuth identity for `GOOGLE_REFRESH_TOKEN` must have read access — it already does (same spreadsheet ID as the maintenance tab).

## Config

No new required env vars. Optional, with defaults baked in:
- `GENDER_SHEET_TAB` — default `Gender Map`
- `GENDER_CACHE_TTL_DAYS` — default `7`

Loaded in `src/config.js`. Not required in `template.yaml` because they have defaults; can be added as overridable parameters later if needed.

## Slack app prerequisites (out-of-band, manual)

Existing app must be updated; not part of this codebase change:
- **OAuth scopes added:** `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`.
- **Event Subscriptions:** add `message.channels` (and `message.groups` if private channels needed).
- Reinstall the app to apply scopes.

Document these in README under a new section.

## Error handling

| Case | Behavior |
|---|---|
| Sheet fetch fails on cache miss | Reply `Could not load gender map: <err>`. No retry; user can `!refresh-genders` after fixing. |
| `conversations.members` fails | Reply `Could not list channel members: <err>`. |
| Empty target list | Reply `No <gender> members configured for this channel.` |
| Both `!bros` and `!sis` in one message | Resolve to `male` (matches gender-aliases precedence). |
| `!refresh-genders` and a gender trigger in one message | Refresh wins (regex check order: refresh first). |
| Bot itself in member list with a gender mapping | Included in mentions (matches Python source — no filtering). |

## Testing

Unit tests, mirroring existing test layout (`tests/lib`, `tests/services`, `tests/events`):

- `tests/lib/gender-triggers.test.js` — regex matrix: positive (`!bros`, `@brothers`, ` !sis`, `!SISTERS`, `!refresh-genders`), negative (`bros` without prefix, `!brosx`, `!sissy`, mid-word).
- `tests/services/genderMap.test.js` — parse valid rows, skip malformed, TTL respected, `invalidate()` forces refetch.
- `tests/events/gender.test.js` — full handler: success path posts mentions, empty filter posts empty message, sheet error posts error reply, members error posts error reply, refresh path invalidates + replies count, both-genders-in-one-message resolves to male, no-op on plain chatter.
- `tests/lambda/dispatch.test.js` — extend: gender event routes to gender handler, gender + thread_ts still routes to gender (top-level reply), non-gender thread/mention still routes to mention handler.
- `tests/lambda/receiver.test.js` — extend: `!bros` plain message enqueues, ordinary chatter does not.

No integration tests against real Slack/Sheets — matches existing pattern.

## Out of scope

- Re-running the bot in Socket Mode (gender-aliases' original transport). The Events API + Lambda transport is reused as-is.
- Adding non-binary or arbitrary tag support. The data model is intentionally `male | female` to match the source; expanding it is a future feature.
- Per-channel gender maps. The map is global across all channels.
- Bot-user filtering (excluding the bot itself from `@-mentions` when it's a member with a mapping). Matches source behavior.
- Migrating off `GOOGLE_SHEET_ID` / OAuth refresh token to a service account.

## Open questions deferred to implementation

- Whether `extractSeverity`-style inline parsing belongs in `gender.js` or stays in `lib/`. Likely fine to keep regex helpers in `lib/gender-triggers.js`.
- Exact prefilter shape in `receiver.js` — may need a small refactor of the existing implicit filter (currently `shouldSkip` is in `dispatch.js`, not the receiver). Implementation plan will tighten this.
