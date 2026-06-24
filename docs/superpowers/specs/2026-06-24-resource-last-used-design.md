# Resource "Last Used" Lookup — Design

**Date:** 2026-06-24
**Status:** Approved, pending implementation plan

## Summary

Let people ask the bot who/when a resource was last used — "who used the
speaker set last?", "when was Tech Set 1 last used?", "where's the popcorn
machine?" — and get an answer read from that resource's Google Calendar. When
the resource name is ambiguous or unrecognized, the bot infers from the real
catalog and, if still unsure, asks the user to pick from actual resources.

Extends the reservations feature; works in the ambient `#reservations` channel
and via `@mention`/slash. No booking is involved — this is read-only history.

## Verified prerequisite (met)

The deployed bot token now has the Calendar scope and the bot's
`*.acts2.network` account can read the DMV resource calendars (Calendar API
enabled in GCP project `902419579839`). A probe of `Tech Set 1`, the `FH MPR`
venue, and `Popcorn Machine` returned real events with titles and organizers.
Resource-calendar event **titles already carry who/what** (e.g.
`"DC ISMP MTR Event #2 | Michael Chen"`).

## Goals

- A natural-language **history** query → the most recent past event on the
  matched resource's calendar.
- Answer with the **event title** and **when** (per decision: title-only — the
  title already names the person/purpose).
- **Disambiguation:** unknown/ambiguous resource phrase → infer from the real
  catalog; 0 matches → say so; 1 → answer; 2+ → ask the user to choose from
  actual resources, and resolve their threaded reply.
- Read-only; no writes, no booking.

## Non-goals

- Resource booking (still recognized-but-not-live; separate work).
- Reporting the event organizer/email (decision: title-only).
- Venue/room history (this is for equipment **resources** in `RESOURCE_CALENDARS`).
- Multi-resource answers ("list everything used last week").

## Behavior

For a `history` request (ambient channel, mention, or slash):

1. **Classify** via Groq: `intent: "history"`, `target` = the resource phrase.
2. **Resolve** the phrase against the resource catalog with a candidate matcher:
   - **0 candidates** → "I don't track a resource called '<phrase>'."
   - **1 candidate** → use it.
   - **2+ candidates** → reply asking the user to choose, listing the real
     candidate names ("Did you mean: Tech Set 1, Tech Set 2, Tech Set 3, or
     Tech Set 4?"). The user's thread reply re-enters and re-resolves (reusing
     the ambient thread-combine path).
3. **Read** the resource calendar's most recent event up to now.
   - **An event exists** → "<resource> was last used on <Ddd M/D, YYYY> —
     <event title>."
   - **No events** → "No recorded usage for <resource>."
4. **Reply** in-channel, threaded under the triggering message (and ephemerally
   for slash, matching the existing pattern).

## Architecture

Unchanged plumbing. New logic composes onto existing services.

- **`src/services/groq.js`** — add `history` to the reservation-intent prompt
  (who/when/where a resource was last used; do NOT confuse with `reserve`/`check`).
- **`src/lib/reservation-rooms.js`** — add `createResourceCandidateMatcher` (or a
  `matchAll` on the existing matcher) that returns ALL catalog titles a query
  could mean (normalized exact, alias, then word-boundary/substring), for
  disambiguation. The existing single-result `match` stays for booking paths.
- **`src/services/calendar.js`** — add `lastEvent(calendarId, { lookbackDays })`:
  list events with `timeMin = now − lookback`, `timeMax = now`, `singleEvents:
  true`, `orderBy: "startTime"`, and return the **last** (most recent) item as
  `{ summary, startIso, endIso }`, or `null` when none. (events.list has no
  descending order, so we take the last of an ascending window; default
  lookback ≈ 18 months.)
- **`src/services/reservations.js`** — add `resourceLastUsed(query)` returning a
  tagged result: `{ status: "unknown" }` (0 matches), `{ status: "ambiguous",
  candidates }` (2+), or `{ status: "ok", resourceName, lastUse | null }` (1).
  Needs the resource catalog (titles → calendar ids, already injected as
  `resourceCalendars`) and `calendarService`.
- **`src/events/reservations.js`** — handle `intent: "history"` in the channel
  handler (and mention/slash) → call `resourceLastUsed` → format the reply
  (answer / no-usage / unknown / ambiguous-ask). The ambiguous-ask is a normal
  threaded message; the user's reply re-parses via the existing thread-combine.

## Data flow

`message → Groq (history, target) → resourceLastUsed(target) →
[unknown | ambiguous(candidates) | ok(resourceName,lastUse)] → formatted reply`.

`lastUse` from `calendarService.lastEvent` = the most recent event ≤ now within
the lookback window.

## Error handling

- Calendar read failure (scope/access/network) → "Couldn't reach the calendar
  for <resource> right now." (never throws out of the worker).
- Groq parse failure / `none` → silent in the ambient channel (existing rule).
- A resource with no calendar id mapped → treated as `unknown`.
- Lookback window with no events → "No recorded usage" (distinct from an error).

## Testing (Vitest)

- Groq prompt: a `history` response passes through (mocked).
- Candidate matcher: exact/alias/word-boundary; returns `[]`, one, or many;
  "tech set" → all four Tech Sets; "popcorn" → the popcorn machine; "spaceship"
  → `[]`.
- `calendar.lastEvent`: picks the **most recent** of an ascending window; `null`
  when empty; passes the right `timeMin/timeMax/singleEvents/orderBy` (mocked
  client).
- `reservations.resourceLastUsed`: 0 → unknown; 1 → ok with `lastUse`; 1 with no
  events → ok + `lastUse:null`; 2+ → ambiguous with candidate names.
- Handler: history + ok → "last used on … — <title>"; no-usage message;
  unknown message; ambiguous → asks listing candidates; calendar error →
  graceful message; threaded disambiguation reply re-resolves.

## Rollout

- No new env vars; uses the existing `RESOURCE_CALENDARS`.
- Already-verified: Calendar API enabled + token scope/access. (Re-mint already
  saved to `.env` + the `GOOGLE_REFRESH_TOKEN` GitHub secret.)
