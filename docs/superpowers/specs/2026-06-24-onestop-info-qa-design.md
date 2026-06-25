# OneStop Info Q&A — Design

**Date:** 2026-06-24
**Status:** Approved, pending implementation plan

## Summary

Let people get OneStop information by asking the bot in a new **`#onestop`**
channel instead of opening the *DMV Fairfax/CP Members OneStop* sheet
(`163Qo6xAr0DZvBv3MdPsE3aQCX7BurRROA7FcRJFHcOw`). A natural-language question is
answered **only** from the sheet's static reference tabs (codes, links, zoom
links, rotations, interhigh sites, cleaning assignments, categories).

`#onestop` **replaces `#reservations`** as the single front door: the same
ambient handler runs there and does both info Q&A and the existing reservation
actions (check/list/reserve/history). `#reservations` is retired — the bot's
configured channel id points at `#onestop`.

This is the first sub-project of a broader "OneStop bot" vision (info Q&A +
request management). Only the **info Q&A** half is specified here. Request
management is deferred — the existing reservations feature already partly covers
it and will be specced separately.

## Goals

- Answer FH/OneStop questions in `#onestop` from the sheet's reference
  tabs: "what's the door code?", "zoom link for AYM?", "who's on lockup this
  week?", "where does IH Cabin John meet?", "who runs the travel workspace?".
- Reuse the existing ambient handler + Groq routing; reservation actions are
  unchanged, just now living in `#onestop`.
- Never invent: answer strictly from the OneStop data, or say it isn't there.

## Non-goals

- **Request/ticket management** (deferred sub-project).
- Answering from the **live week-schedule** tabs — those are reservation
  queries, already handled by the reservations `check`/`list` flow.
- Editing the OneStop sheet (read-only feature).
- Embeddings / semantic search / new dependencies — the corpus is small enough
  to feed whole.
- Per-channel branching logic — `#onestop` is the only ambient channel (it
  replaces `#reservations`); the handler is unchanged save the new `info` route.

## OneStop sheet facts (verified live)

Title: `DMV Fairfax/CP Members OneStop | 2026 | (member access)`. The reference
("info") tabs people open the sheet to read, with their shape:

- **BULLETIN** (18×4) — `Date | From | Subject | Details` announcements, plus
  loose rows for **codes** (FH door code, FH copy-room lockbox code, online
  prayer link).
- **Links** (55×4) — `… | In Charge | Access Level | Notes` workspace/calendar
  links and who owns each.
- **Rotations** (29×6) — weekly duty rotations: DT Food / Lockup / Tech /
  SWS Food, by `Week of` range.
- **Zoom & WR & DT** (16×10) — zoom/meet links per group + lead.
- **IH** (15×24) — interhigh service sites: departure/start/end times, church
  name, staff, address, nearest youth team, attendance.
- **Category/Legend** (11×5) — the category taxonomy.
- **Cleaning Assignments** (40×5), **Summer Cleaning Assignments** (47×5).

Excluded tabs: the week schedule grids (`6/22-6/26 M-F`, `… S-Su`, `M-F Temp`,
`S-Su Temp`, `DRAFT …`), `Rotations - OLD` (471 rows), `Config` (1015 rows).

The whole allowlisted corpus is a few thousand short cells — it fits comfortably
in a single Groq context, so retrieval is "feed the whole corpus", no search.

## Architecture

Same plumbing as the reservations bot: Slack → ReceiverFn (3s ack) → SQS →
WorkerFn → `dispatchSlackEvent` → `handleChannelMessage`. The change is entirely
inside the channel handler's parse step and one new read-only service.

### Components

- **`src/services/onestopInfo.js`** — `createOneStopInfoService({ sheetsClient, sheetId, tabs, ttlMs, now })`:
  - `corpus(): Promise<string>` — fetch each allowlisted tab's values
    (`'<tab>'!A1:Z`), render to a compact text block per tab
    (`### <tab>\n` then each row as `cell | cell | …`, skipping empty rows),
    join the blocks, and cache the result for `ttlMs`. A tab that errors or is
    missing is skipped gracefully (the rest still answer). `now` is injected for
    testable TTL (mirrors the directory service).
  - `tabs` defaults to the allowlist:
    `["BULLETIN","Links","Rotations","Zoom & WR & DT","IH","Category/Legend","Cleaning Assignments","Summer Cleaning Assignments"]`.
    Overridable via `ONESTOP_INFO_TABS` (comma-separated) at wiring time.

- **`src/services/groq.js`** — two additions:
  - The reservation parse (`parseReservationRequest`) gains an **`"info"`**
    intent: a general FH/OneStop question that is **not** a reservation action
    (not check/list/reserve/history about a room or resource). The single parse
    call is the top-level router. The `SYSTEM_PROMPT_RESERVATION` enumerates
    `info` with examples ("what's the door code", "zoom link for AYM", "who's on
    lockup this week", "where does IH meet") and the rule: room/resource
    availability or booking stays check/list/reserve/history; anything else
    asking for OneStop reference info is `info`.
  - **`answerInfoQuestion(question, corpus): Promise<string>`** — a new method.
    System prompt: *You answer questions for an FH community from the provided
    OneStop reference data ONLY. Quote the specific value(s). If the answer is
    not present, say "I don't see that in OneStop." Never invent or guess.* The
    user message carries the corpus and the question. Returns the answer text,
    or a graceful fallback string on API failure.

- **`src/events/reservations.js`** — in `handleChannelMessage`, after `parsed`
  is obtained and the `none`/null guard, add: if `parsed.intent === "info"` and
  an `onestopInfoService` is present → `const corpus = await onestopInfoService.corpus();`
  → `const text = await groqService.answerInfoQuestion(originalText, corpus);`
  → reply via `say(...)` with the existing persona, then return. (Use the raw
  user text, not a re-render.) Reservation intents below are untouched.
  `createReservationHandler` gains an `onestopInfoService` param.

- **`src/config.js` / `src/lambda/clients.js` / `template.yaml` / `deploy.yml`**
  — no new sheet id: reuse `config.reservationsSheetId` (the OneStop sheet).
  Build `onestopInfoService` in `clients.js` when `reservationsSheetId` is set,
  reading an optional `ONESTOP_INFO_TABS` override; pass it into the handler.
  Add `ONESTOP_INFO_TABS` to the worker env (optional, default empty → code
  allowlist).

### Channel rename (`#reservations` → `#onestop`)

`#onestop` replaces `#reservations` as the bot's ambient channel. The channel
id already threads through `config.reservationsChannelId` → `receiver.js`
(ambient detection) → `dispatch.js` (route to the reservation handler). Rename
it to OneStop for clarity, with a backward-compatible env fallback so a deploy
between the GitHub-variable rename and the code rename never goes dark:

- **New env/param `ONESTOP_CHANNEL_ID`**, read as
  `process.env.ONESTOP_CHANNEL_ID || process.env.RESERVATIONS_CHANNEL_ID`.
- `config` exposes it as **`onestopChannelId`** (drop `reservationsChannelId`);
  thread the rename through `receiver.js`, `dispatch.js`, `worker.js`,
  `clients.js`.
- `template.yaml` gains `OneStopChannelId` (keep `ReservationsChannelId` as the
  fallback value during migration); `deploy.yml` passes
  `${{ vars.ONESTOP_CHANNEL_ID }}` (falling back to the old var).
- **Persona rename:** `BOT_USERNAME` `"Reservations (beta)"` → `"OneStop (beta)"`
  in `reservations.js` (the channel is now the unified front door, so the name
  should match). `icon_emoji` unchanged.

Manual rollout step: create `#onestop`, set GitHub variable
`ONESTOP_CHANNEL_ID` to its id, invite the bot. `#reservations` can be archived
once `#onestop` is live.

## Data flow

1. Non-bot `#onestop` message → `handleChannelMessage`.
2. `parseReservationRequest(text)` → `intent`.
3. `intent === "info"` → `corpus()` (cached) → `answerInfoQuestion(text, corpus)`
   → reply. Two Groq calls total, only on info questions.
4. Any reservation intent (`check/list/reserve/history`) → existing flow, one
   Groq call, unchanged.
5. `none` / unparseable → silent (unchanged).

## Error handling

- Corpus fetch failure → reply "Can't reach OneStop right now." (never throws
  out of the worker).
- A single bad/missing tab is skipped; the rest of the corpus still answers.
- `answerInfoQuestion` API failure → graceful fallback string, no throw.
- No-invent: the answer prompt constrains to the corpus; absent info →
  "I don't see that in OneStop."
- 3-second Slack ack preserved (worker does the work).

## Security / privacy

- BULLETIN holds door/lockbox codes and meeting links. `#onestop` is a
  members-only channel and the source sheet is "member access", so surfacing
  these to the channel matches the existing trust boundary. Accepted for v1; if
  the channel's membership ever broadens, revisit (e.g. redact a `codes` tab).
- Read-only: the feature never writes the sheet.

## Config / rollout

- No new sheet id — reuses `RESERVATIONS_SHEET_ID`
  (= `163Qo6xAr0DZvBv3MdPsE3aQCX7BurRROA7FcRJFHcOw`).
- New `ONESTOP_CHANNEL_ID` variable = the `#onestop` channel id (falls back to
  `RESERVATIONS_CHANNEL_ID` during migration). Create `#onestop`, invite the
  bot, set the variable; archive `#reservations` once live.
- Optional `ONESTOP_INFO_TABS` variable to override the tab allowlist without a
  code change.
- Gated on `reservationsSheetId` (same gate as the reservations feature).

## Testing (Vitest, deps mocked)

- `onestopInfo.corpus`: renders only allowlisted tabs; excludes a non-allowlist
  tab; skips empty rows; a tab whose fetch throws is skipped (others still
  render); caches within TTL (one fetch for two `corpus()` calls); refetches
  after TTL.
- `groq.parseReservationRequest`: a general info question returns
  `intent:"info"`; a room availability/booking question still returns
  `check/list/reserve/history` (router doesn't over-capture).
- `groq.answerInfoQuestion`: passes corpus + question to the model and returns
  its text; graceful fallback on API throw (mocked).
- Handler: an `info`-intent message calls `corpus()` then `answerInfoQuestion`
  and replies; reservation intents do NOT call the info service; corpus-fetch
  failure replies gracefully.
- Config/clients: `onestopInfoService` built when `reservationsSheetId` set,
  with the allowlist (and `ONESTOP_INFO_TABS` override honored).
- Channel rename: `config.onestopChannelId` reads `ONESTOP_CHANNEL_ID`, falls
  back to `RESERVATIONS_CHANNEL_ID` when the new var is unset; receiver/dispatch
  ambient-route on it.

## Open questions / TODOs

- **Router tuning**: the `info` vs `list` boundary ("what's booked in the MPR"
  is `list`; "what's the door code" is `info`) — covered by prompt examples;
  monitor for misroutes after rollout.
- **Freshness**: corpus TTL trades staleness vs API calls; a short TTL (e.g.
  5 min) keeps BULLETIN edits visible quickly. Final value set in the plan.
