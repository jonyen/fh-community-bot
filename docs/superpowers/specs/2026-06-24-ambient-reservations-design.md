# Ambient Reservations in #reservations — Design

**Date:** 2026-06-24
**Status:** Approved, pending implementation plan

## Summary

Make a configured Slack channel (e.g. `#reservations`) a one-stop place for
reservations: the bot reads **every** human message there (no `@mention`
required), understands it with Groq, and responds intelligently — answering
availability/listing questions, making room bookings, asking a follow-up when a
request is missing information, and staying silent on non-reservation chatter.

Extends the reservations feature
([`2026-06-23-reservations-bot-design.md`](./2026-06-23-reservations-bot-design.md)).
The existing `@mention` and slash-command interfaces (`/reserve`, `/check`,
`/list`) are **kept as-is** and unchanged; this adds the ambient channel as an
additional, primary interface.

## Goals

- In the configured channel, react to plain messages with no `@mention`.
- Route by **intent** understood from natural language (Groq), not keywords.
- **Complete** request → act/answer (check / list / reserve).
- **Incomplete** reservation request → reply in a thread asking only for the
  missing pieces; the user's thread reply is combined and re-parsed (real
  multi-turn).
- **Non-reservation** message → stay completely silent (no noise).
- `reserve` success still broadcasts publicly in-channel (existing behavior).

## Non-goals

- Removing or changing `@mention` / slash-command handling (kept as-is).
- Listening on more than one channel (single `RESERVATIONS_CHANNEL_ID`).
- Resource (equipment) booking — still recognized but not live.
- Persisting conversation state outside Slack (the thread is the source of
  truth, per the existing architecture).

## Behavior

For a non-bot message in `RESERVATIONS_CHANNEL_ID`:

1. **Skip noise cheaply:** ignore bot messages, non-`file_share` subtypes
   (edits/joins), and obvious junk (greetings/acks like "thanks", "lol", "ok")
   via a small heuristic guard — avoids an LLM call on chatter.
2. **Resolve context:** if the message is in a thread, fetch the thread
   (`conversations.replies`), concatenate the human (non-bot) messages so a
   follow-up reply is understood together with the original request.
3. **Parse intent:** Groq `parseReservationRequest` returns
   `intent ∈ {check, list, reserve, none}` plus slots (target, date, start, end,
   what, who). `none` → **ignore silently**.
4. **Route:**
   - `list` → always answerable (defaults: all rooms, next 7 days) → reply with
     the day-grouped table.
   - `check` / `reserve` → if the required slots are present, act; otherwise ask
     a follow-up listing only what's missing.
   - Unmanaged room phrase → "I don't manage … — I can only handle known rooms."
5. **Reply** in-channel, threaded under the triggering message
   (`thread_ts = event.thread_ts || event.ts`). `reserve` success broadcasts to
   the channel (mentioning the requester), as today.

**Required slots:**
- `reserve`: room, date, start, end (what optional).
- `check`: room, date, start, end.
- `list`: none (defaults apply).

**Follow-up wording:** one message, e.g.
"Happy to book that — which room?" / "What date and time?" — listing only the
missing fields. When the user replies in the thread, step 2 re-reads the thread
and re-parses; once complete, the bot proceeds.

## Architecture

Unchanged plumbing: Slack → ReceiverFn → SQS → WorkerFn → `dispatchSlackEvent`.

- **`RESERVATIONS_CHANNEL_ID`** — new config (single channel). The feature is
  off when unset. Needed by BOTH Lambdas: the receiver (to decide enqueue) reads
  `process.env` directly; the worker reads it via `loadConfig`.
- **`receiver.js`** `shouldEnqueueEvent` — additionally enqueue every non-bot
  `message` event whose `channel === RESERVATIONS_CHANNEL_ID` (top-level and
  threaded), so ambient messages reach the worker.
- **`dispatch.js`** — when `reservationHandler` is set and a `message` event
  (not `bot_id`) is in `RESERVATIONS_CHANNEL_ID`, route to
  `reservationHandler.handleChannelMessage` and return — this channel is owned
  by reservations (checked before the gender/maintenance branches). `app_mention`
  events keep using the existing mention routing.
- **`events/reservations.js`** — new `handleChannelMessage({ event, client })`:
  junk guard → thread context → Groq parse → route (reuses `replyForParsed`,
  `replyForList`, and the broadcast path) → follow-up on missing slots.
- **`services/groq.js`** — extend `parseReservationRequest`'s prompt to classify
  `intent: "none"` for non-reservation messages.
- **`config.js`** + **`template.yaml`** — add `RESERVATIONS_CHANNEL_ID` (worker
  env + receiver env).

## Components & interfaces

- `parseReservationRequest(text, referenceDateIso)` → adds `none` as a valid
  `intent`; returns `null` only on parse/API failure (unchanged).
- `createReservationHandler` gains `handleChannelMessage({ event, client })`.
- A small pure helper `missingSlots(parsed)` → array of missing required slot
  names for the parsed intent (testable in isolation).
- A small pure helper `isIgnorableChatter(text)` → boolean junk guard (mirrors
  the existing `isObviouslyNotMaintenance` style in `groq.js`).

## Error handling

- Groq parse failure (`null`) in the ambient channel → **silent** (don't guess
  or spam); a person can rephrase. (Unlike slash, where a null parse prompts.)
- `conversations.replies` failure → fall back to the single message's text.
- A reservation write failure / broadcast failure → same guards as today (sheet
  is truth; a failed notification never triggers a retry).
- 3-second Slack ack preserved (work happens in the worker).
- Bot never replies to its own or other bots' messages (`bot_id` filter).

## Testing (Vitest)

- `parseReservationRequest` returns `intent: "none"` for chatter (mocked Groq).
- `isIgnorableChatter` skips greetings/acks; passes real requests.
- `missingSlots`: reserve/check require room+date+start+end; list requires none.
- `handleChannelMessage`: complete `reserve` → books + broadcasts; complete
  `check`/`list` → answers; incomplete → threaded follow-up listing only missing
  slots; `none`/null → no reply; bot messages ignored.
- Thread re-parse: a threaded reply triggers `conversations.replies` and the
  combined text is parsed.
- `dispatch.js`: a plain message in `RESERVATIONS_CHANNEL_ID` routes to
  `handleChannelMessage`; a message elsewhere does not; existing routing intact.
- `receiver.js`: a non-bot message in the channel is enqueued; a bot message is
  not; existing enqueue rules intact.

## Config / rollout

- Set `RESERVATIONS_CHANNEL_ID` (the `#reservations` channel id) as a GitHub
  Actions variable; deploy passes it to both Lambdas.
- Invite the bot to `#reservations` so it can read messages and post replies.
- No new Slack scopes beyond what the bot already has for channel messages +
  `conversations.replies` (`channels:history`, `chat:write`); confirm at rollout.
