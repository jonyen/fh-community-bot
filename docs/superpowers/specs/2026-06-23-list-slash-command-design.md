# `/list` Slash Command for the Reservations Bot — Design

**Date:** 2026-06-23
**Status:** Approved, pending implementation plan

## Summary

Add a `/list` Slack slash command that lists room reservations from the OneStop
master sheet over a date window, parsed from natural language. Examples:

- `/list all reservations tomorrow` → every room reservation tomorrow.
- `/list reservations for MPR` → FH MPR's reservations over the next 7 days.

This extends the existing reservations feature
([`2026-06-23-reservations-bot-design.md`](./2026-06-23-reservations-bot-design.md)).
It reuses the same single Slack app (`@fh_maintenance`), receiver, Groq parser,
and sheet service. No new Slack app or bot handle (the user opted to keep one
bot; reservation replies still post as "Reservations (beta)").

## Goals

- A `/list` slash command that returns matching reservations as an **ephemeral**
  Slack reply (only the requester sees it).
- Natural-language args parsed by Groq: an optional **room** and an optional
  **date**.
- **Window**: an explicit date (e.g. "tomorrow") lists that single day; with no
  date, default to **today through today + 7 days**.
- **Scope**: the OneStop master sheet only (rooms). Resource/venue calendars are
  excluded.

## Non-goals

- A separate `@reservations` Slack app / bot handle (explicitly declined).
- Listing resource or venue **calendar** events (sheet-only for this command).
- Multi-day natural-language windows ("next week", "this weekend") as a
  first-class feature — they resolve to whatever single date Groq returns. See
  Limitations.
- Changing `/reserve` or `/check`.

## Behavior

| Input | Room filter | Window |
|---|---|---|
| `/list all reservations tomorrow` | none (all rooms) | tomorrow (single day) |
| `/list reservations for MPR` | FH MPR | today … today + 7 days |
| `/list MPR friday` | FH MPR | that Friday (single day) |
| `/list` (empty) | none | today … today + 7 days |

- The reply is an ephemeral message posted as username **"Reservations (beta)"**.
- Each line: `• <Ddd M/D> <start>–<end> — <room/location> — <what>`.
- Empty result → "No reservations found for <window/room>."
- An unrecognized room phrase lists **all** rooms in the window (the room filter
  only applies when the phrase resolves to a canonical room) — and the reply
  notes the phrase wasn't a known room.

## Architecture

Unchanged plumbing. Slack → ReceiverFn (slash payload, already parsed and
enqueued) → SQS → WorkerFn → `dispatchSlackEvent`. The `/list` command joins the
existing reservation slash branch in `dispatch.js` and routes to the reservation
handler's `handleSlash`.

## Components

- **`src/lambda/dispatch.js`** (modify) — add `/list` to the reservation
  slash-command condition (`/reserve` | `/check` | `/list`).
- **`src/events/reservations.js`** (modify) — `handleSlash` forces
  `intent = "list"` when `envelope.command === "/list"`; a list result with no
  resolved room calls the new all-rooms listing path; the reply is ephemeral.
- **`src/services/reservations.js`** (modify) — add
  `listReservations({ room, fromIso, toIso })`:
  - `room` is a canonical room name or `null` (all rooms).
  - Walk each day in `[fromIso, toIso]`, select that day's week tab
    (`selectTabForDate`), read events once per tab (dedup tabs already read),
    keep events whose date falls in the window; if `room` is set, keep only
    events whose `roomMatcher.match(location) === room`.
  - Return items sorted by date then start: `{ dateIso, startTime, endTime, location, what }`.
  - Generalizes the existing `listRoom` (which can be reimplemented in terms of
    this, or left as-is and `listReservations` added alongside).
- **`src/services/groq.js`** — no change; `parseReservationRequest` already
  returns `{ intent, target, date, ... }`. The handler overrides `intent` for
  `/list`.

## Window resolution

In the handler, after parsing:

```
const refDate = now();                          // a Date
const fromIso = parsed.date || isoDate(refDate);                  // today if no date
const toIso   = parsed.date || isoDate(addDays(refDate, 7));      // +7 days if no date
```

When `parsed.date` is present, `from === to` (single day). When absent, the
window is today … today + 7 days. `isoDate`/`addDays` are small local helpers
(UTC-noon anchored, consistent with existing date handling).

## Error handling

- Groq parse failure (`null`): treat as "list everything in the default 7-day
  window" rather than erroring — `/list` with no usable args is still a sensible
  "what's coming up" query.
- Sheet read failure: ephemeral "couldn't read the schedule right now."
- Days with no week tab are skipped silently (outside the maintained range).
- 3-second Slack ack preserved — work happens in the worker; the slash payload
  is acked by the receiver immediately.

## Testing (Vitest)

- `listReservations` all-rooms across a multi-tab window (e.g. a weekday + a
  weekend tab), sorted by date+start.
- `listReservations` filtered to a single room.
- Empty window → empty array.
- No-date default → today … +7 days window (assert the day range walked).
- Tab dedup (a window spanning days in the same tab reads it once).
- Handler: `/list` forces list intent; ephemeral reply with username
  "Reservations (beta)"; formatted lines; empty-result message.
- `dispatch.js`: a `/list` slash command routes to `reservationHandler.handleSlash`.

## Limitations

- Multi-day NL windows ("next week", "this weekend") are not first-class: Groq
  returns a single `date`, so such phrases list only the one day Groq picks (or
  fall to the 7-day default if it returns none). A future change can extend
  `parseReservationRequest` to return an explicit `fromDate`/`toDate` range.
- Sheet-only: events that live solely in resource/venue calendars are not listed.

## Rollout

- Register the `/list` command in the Slack app (Slash Commands → Create New
  Command → Request URL = the receiver Function URL), same as `/reserve` and
  `/check`. No new env vars; gated implicitly by the existing
  `RESERVATIONS_SHEET_ID` wiring.
