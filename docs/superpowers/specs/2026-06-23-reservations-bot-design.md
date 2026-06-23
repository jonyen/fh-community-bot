# Reservations Bot for the FH Community — Design

**Date:** 2026-06-23
**Status:** Draft, pending user review

## Summary

Add a reservations capability to the existing `fh-community-bot` Slack app.
Users can **check availability**, **list upcoming reservations**, and **make
reservations** across two sources of truth:

- **Rooms** live in the *DMV OneStop* master-calendar Google Sheet
  (`DMV Fairfax/CP Members OneStop | 2026`), one row per event.
- **Resources** live in **Google Calendars**, one calendar per resource,
  mapped by env var.

The bot reads both sources to answer availability/listing questions, and writes
new reservations to the appropriate source (sheet for rooms, calendar for
resources). Bookings that collide with an existing entry are **rejected** (no
write); the conflict is reported back.

## Goals

- **Check availability**: "is the MPR free Wed 6–9pm?" → free/busy answer.
- **List reservations**: "when is the MPR being used next week?" → list of
  matching events over a date window (may span multiple week tabs).
- **Make a reservation**: book a room (sheet row) or a resource (calendar event).
- **Reject on conflict**: never double-book; report the conflicting entry.
- Fit the existing receiver → SQS → worker architecture and Google auth.
- Reuse the existing single Google OAuth2 client (add the Calendar scope).

## Non-goals

- Editing or cancelling existing reservations (create + read only for v1).
- Reshaping the OneStop sheet model or its weekly-tab convention.
- Auto-syncing the sheet and the calendars to each other.
- Suggesting alternative free slots (reject-only; no suggestions).
- Managing the room/resource catalog in-app (catalog comes from env vars).
- Booking external/non-managed locations (`National Mall`, `Online`, `various`).

## Key facts discovered during design

The OneStop sheet (`163Qo6xAr0DZvBv3MdPsE3aQCX7BurRROA7FcRJFHcOw`) was inspected
directly using the bot's existing Google refresh token.

- **Distinct spreadsheet** from the bot's issues sheet (`GOOGLE_SHEET_ID`) →
  needs a new `RESERVATIONS_SHEET_ID`.
- **Weekly tabs.** Schedule tabs are named by date range + part-of-week:
  - Weekday: `6/22-6/26 M-F`
  - Weekend: `6/27-6/28 S-Su`
  - Selector regex: `^(\d{1,2}/\d{1,2})-(\d{1,2}/\d{1,2}) (M-F|S-Su)$`.
  - Many non-schedule tabs exist (`BULLETIN`, `Links`, `Rotations`, `IH`,
    `Config`, `Category/Legend`, `M-F Temp`, `S-Su Temp`, cleaning tabs,
    `DRAFT …`). All ignored — only tabs matching the regex are schedule tabs.
- **Row-per-event**, header at row 0. Columns (12):
  `DATE | START TIME | END TIME | TRIBE | MINISTRY | WHAT | LOCATION | IN CHARGE | WHO | TECH | CHILDCARE | NOTES`.
- **Blank rows separate days.** Rows are **ragged** (trailing empty columns
  omitted by the Sheets API).
- **DATE** has **no year**: `6/22 Mon` (`M/D Ddd`). Year is implied by the tab /
  current period.
- **Times**: `9:00 PM` style. Some are **blank** (TBD events), some are
  **garbage** (`END="c"`), all-day is `12:00 AM`–`11:59 PM`.
- **LOCATION is wild free text** and mostly *not* a bookable internal room:
  `Childcare Room`, `Staff Suite \nzoom` (embedded newline), `Staff suite`,
  `Management office`, `FH MPR`, `FH Makerspace`, alongside `DC`,
  `Capital One Cafe (Georgetown)`, `National Mall`, `Online`, `various`, `-`.
  → Conflict detection must be limited to a **canonical internal-room list**.

## Capabilities

| Capability | Trigger | Reads | Writes |
|---|---|---|---|
| Check availability | `/check`, `@mention` NL | sheet + calendars | — |
| List reservations | `@mention` NL, `/check` | sheet + calendars | — |
| Make reservation | `/reserve`, `@mention` NL | sheet + calendars | sheet **or** calendar |

## Architecture

Unchanged from the existing bot:

```
Slack ──▶ ReceiverFn (3s ack) ──▶ EventQueue (SQS) ──▶ WorkerFn
                                                          │
                                  ┌───────────────────────┤
                                  ▼                        ▼
                         Sheets / Calendar API         Groq (NL parse)
```

`worker.js`/`dispatch.js` routes reservation slash commands and matching
`@mention` text to a new reservation handler, alongside the existing mention and
gender handlers. The Slack reply is posted in-thread, optionally with a
`"Reservations"` username override (same mechanism the gender handler uses to
post as `"Gender Aliases"`).

## Modules

- **`src/services/calendar.js`** — wraps `google.calendar({ version: "v3", auth: oauth2Client })`.
  - `listEvents(calendarId, timeMin, timeMax)` — for availability + listing.
  - `freeBusy(calendarId, timeMin, timeMax)` — overlap check.
  - `insertEvent(calendarId, event)` — create resource reservation.
- **`src/services/reservations.js`** — core orchestration (pure where possible):
  - classify request target: managed **room** vs **resource** vs unmanaged.
  - tab selection from a date (parse the week-range tab names).
  - room-location normalization + canonical match.
  - overlap detection over parsed event rows.
  - listing over a date window (across multiple week tabs).
  - build the row to write / the calendar event to insert.
  - format the Slack reply (available / conflict / list).
- **`src/services/sheets.js`** (extend) —
  - `listScheduleTabs()` — spreadsheet metadata, filter by the tab regex.
  - `readWeekTab(tabName)` — values for a tab.
  - `insertReservationRow(tabName, rowIndex, values)` — chronological insert.
- **`src/events/slashReserve.js`** — handles `/reserve` and `/check` payloads.
- **NL parsing** via existing `groqService`: map free-text @mention to
  `{ intent: check|list|reserve, target, date|window, start, end, what, who }`.

## Room matching

1. `RESERVATION_ROOMS` env var defines the canonical bookable rooms +
   optional aliases (exact list deferred to implementation — a config TODO).
2. Normalize any `LOCATION`: lowercase, replace newlines/runs of whitespace with
   a single space, trim. Compare against canonical names + alias map.
3. On `/reserve`, an **unrecognized** room is rejected with the known-room list.
   Availability/listing for an unrecognized location reports it as *unmanaged*.

## Overlap logic

- Two entries conflict when **same date**, **same canonical room**, and the
  `[start, end)` intervals **intersect**.
- All-day rows (`12:00 AM`–`11:59 PM`) block the whole day.
- Rows with **blank or unparseable** times are **skipped** for overlap and
  **flagged** in the reply ("N entries with unknown times not checked").
- `reject-only`: any conflict ⇒ no write, reply lists the conflicting entry.

## Listing / query

- Resolve the NL window ("next week", "this weekend") to a `[from, to]` date
  range. Pass the window mapping logic through Groq with the current date.
- Map the range to the schedule tabs it covers (M-F and/or S-Su tabs), read
  each, filter rows by canonical room (and/or other criteria), merge calendar
  events for resources, sort by date+start, return the list.

## Write strategy (rooms)

- Select the week tab for the reservation's date (parse range tab names).
- Find the **chronological insertion point** within that tab's day block (first
  row whose date/start is later than the new one) and **insert a row there**
  (`spreadsheets.batchUpdate` insertDimension + values update), so the master
  calendar stays ordered. Ragged-row safe (pad to 12 columns).
- DATE written as `M/D Ddd` to match the existing format; times as `h:mm AM/PM`.

## Triggers / UX

- **`/reserve`** — structured slash command. Required fields and arg syntax
  finalized in the plan; minimum is date + start + end + room + what
  (validation modeled on real rows, where those five are consistently present
  for managed-room events).
- **`/check`** — availability/listing slash command, no write.
- **`@mention`** — natural language for all three intents; Groq parses intent +
  slots, then routes into the same core. Ambiguous/missing slots → the bot asks
  a follow-up in-thread (thread is source of truth, per existing pattern).

## Config (env vars / SSM)

- `RESERVATIONS_SHEET_ID` — the OneStop spreadsheet id.
- `RESERVATION_ROOMS` — canonical room list (+ aliases), JSON or delimited.
- `RESOURCE_CALENDARS` — JSON map `{ "<resource>": "<calendarId>" }`.
- All optional; the reservation handler is only wired when they are present
  (mirrors how the gender handler is gated on `GENDER_SHEET_ID`).

## Auth

Reuse the single OAuth2 client in `src/lambda/clients.js:24`. The Calendar API
needs the `https://www.googleapis.com/auth/calendar` scope, which the current
refresh token does **not** carry. **Re-issue the refresh token with Calendar
added** to the existing scope list, via the existing re-issue workflow
(commit `b610479`, `scripts/google-token-ci.js` / `get-google-token.js`).
No second credential.

## Error handling

- Google/Groq failures degrade gracefully: a read failure replies "couldn't
  check right now", a write failure never leaves a partial booking.
- Unparseable times / unrecognized rooms are surfaced, not silently dropped.
- 3-second Slack ack preserved: all real work happens in the worker.

## Testing (Vitest, matching `tests/`)

- Tab-name parsing + selection (range → tab, weekday vs weekend, ignore set).
- DATE/time parsing incl. blanks, garbage (`"c"`), all-day, embedded newline in
  LOCATION.
- Room normalization + alias matching.
- Overlap detection (touching, nested, all-day, disjoint).
- Reject-on-conflict (no write performed).
- Chronological insertion index within a ragged day block.
- Listing across multiple week tabs + merged calendar events.
- Calendar service with a mocked googleapis client (freeBusy / insert).
- NL parse → slot extraction with a mocked Groq client.

## Open questions / TODOs

- **Exact `RESERVATION_ROOMS`** list + aliases — decided during implementation.
- **`/reserve` required-field set** and arg grammar — finalized in the plan.
- **Resource catalog**: which resources exist and their calendar ids
  (`RESOURCE_CALENDARS`) — needed before the calendar path is usable.
- **Year inference** for the no-year DATE column: derive from the week tab /
  current date; confirm behavior across a year boundary.
- **Bot persona**: confirm replying as a `"Reservations"` username override.
