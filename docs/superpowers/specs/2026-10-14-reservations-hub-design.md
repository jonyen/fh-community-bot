# Reservations Hub in #reservations — Design

**Date:** 2026-10-14
**Status:** Draft, pending review

## Summary

FH has four reservation systems, each with its own owner and link (listed on the
OneStop "Links" tab). Members have to know which one to use. This design makes
the Slack channel **#reservations** the single front door:

1. **Book in natural language.** A member writes "book Tech Set 2 Sat 2–4pm for
   youth night" in #reservations. The bot parses it, checks for a conflict, and
   writes the booking straight into the correct backend.
2. **Feed.** Every booking made through Slack is announced in the channel.
3. **Weekly digest.** Every Monday at 8:00 AM the bot posts the week's
   reservations (Mon–Sun) across all sources, including bookings made directly
   in the docs and calendars.

The four backends stay the system of record. Owners change nothing about how
they work.

This is a **fresh build**. The old OneStop bot (removed in `4a7ae35`) is
reference only; its code is not restored.

## Goals

- One place to book rooms, kitchen, tech, and sports/outreach/accessories.
- **First come, first served.** No approver. If the slot is free, it is booked.
- **On conflict, write nothing.** Tell the requester who holds the slot so they
  can work it out with that person.
- Check and list in natural language: "is the MPR free Wed 7pm?", "who has the
  pickleball set this weekend?"
- Weekly digest (Monday 8:00 AM) of the week's reservations across all sources.
- If the digest cannot read a source, DM the operator.

## Non-goals

- Owner approval flows.
- Editing or cancelling bookings from Slack (v1 is create + read).
- Announcing bookings made directly in a doc or calendar in real time (no
  polling or diffing; the weekly digest covers them).
- Venues and vehicles RMS calendars (`DMV Venues-*`, `DMV-Vehicles-*`). Rooms are
  booked through the room request sheet, not venue calendars.
- The OneStop event schedule (`1byXFO7A…`). It is a schedule, not a booking
  system.
- Suggesting alternative free slots.

## Sources (verified 2026-10-14 with the bot's Google token)

| Category | Owner | Backend | Write |
|---|---|---|---|
| Rooms | Management | `DMV Team \| Management Workspace \| 2026` (`1F70ce8Gd1JEvjXTsBIeV0PBi85Ii3ggf2z1tFIh1Eg4`), tab **Upcoming Room Requests** (gid `1580896517`) | Append a row |
| Kitchen | Arie Chen | `FH Kitchen Management \| 2026` (`1xUA0EG95241Ndb3HBOLw-iYGxU9nBTswzFn8ob49o5c`), tab **FH-Kitchen-RSVP** (gid `2109987656`) | Fill an empty pre-dated slot row |
| Tech | Alan Chow | RMS resource calendars `DMV Tech Equipment-G-Tech Set 1..4` | Calendar event with the resource as attendee |
| Sports & Outreach | Joe Pagan | RMS `DMV Sports Equipment-*` (56), `DMV Outreach Supplies-*` (20) | Same as Tech |
| Accessories | none | RMS `DMV Accessories-*` (27) | Same as Tech |

Token scopes: `calendar`, `spreadsheets`, `drive.file`. The bot has `reader`
access on the resource calendars.

### Rooms: Upcoming Room Requests

- Header row 1: `Event Name | Event Date | Event Start Time | Event End Time |
  Ministry Group | Submitted By | Room | Status | Notes`.
- Dates look like `Tue, 6/23/26`. Times are mixed (`6:00:00 PM`, `9:00 PM`); the
  parser accepts both. The bot writes `h:mm AM/PM`.
- A Room cell can hold several rooms separated by newlines (`Youth Room\nA2K Room`).
- Status values seen: blank, `In Review`, `Approved`. Management manages this
  column by hand.
- **Write:** append a row. Status is left **blank** so Management's own review
  process is untouched. Submitted By is the requester's Slack display name. Notes
  carries the purpose plus a tag `[slack:<thread_ts>]`.
- **Conflict:** another row on the same date, overlapping the time, and sharing
  at least one room, unless its Status is `Declined` or `Denied`. The holder is
  that row's Submitted By and Event Name.
- Room names and aliases (`MPR` → `FH MPR`, `L120`, `Makerspace`, `Staff Suite`,
  `Glass Room`, `Youth Room`, `A2K Room`, `Dining Room`, `FH Parking Lot`, …)
  come from the existing `RESERVATION_ROOMS` repo variable, which may need
  updating to match the names used in this sheet.

### Kitchen: FH-Kitchen-RSVP

- Row 2 holds the rule: "No more than 3 ministry groups at same cooking time
  frame please."
- Header row 3: `Date | Name | Phone Number | Start Time | End Time | Kitchen
  Island (3) | White Counter w/ Outlets | Brown Counter w/ Outlets | Freezer (#
  shelf) | Fridge (# shelf) | Toaster Oven | Air Fryer | Microwave | Large Rice
  Cooker (#) | 8-cup Rice Cooker (# of 2) | Instapot (#)`.
- The sheet has 3 pre-dated rows per day (`Thu, 09/03`). Arie rolls the dates
  forward by hand, so future dates may not exist yet.
- **Write:** fill the first empty row (blank Name) for the date: Name, Phone,
  Start, End, and the appliance cells the request mentions (checkboxes `TRUE`,
  counts as numbers). Phone comes from the DMV Team Directory if the requester
  is found there; otherwise it is left blank.
- **Conflict:** 3 or more existing rows on that date whose times overlap the
  request. The holders are those rows' Name and Phone.
- **No row available** (all 3 rows for the date are filled but under the
  overlap limit, or the date has no rows): write nothing. Reply with Arie's sheet
  link and say why.

### RMS calendars: tech, sports, outreach, accessories

- The catalog is the existing `RESOURCE_CALENDARS` repo variable (display name →
  resource calendar ID), already bundled as `runtime-config/` JSON (see the
  reservation-config-delivery memory). Categories come from the name prefix.
- **Write:** create an event on the bot's calendar with the resource as an
  attendee. Summary: `<purpose> — <requester>`. Description: requester name, and
  a Slack permalink to the request.
- The tech rules say reserve "for the ENTIRE time you will hold onto the
  speaker". The bot's confirmation repeats this for Tech Sets.
- **Conflict:** `freebusy.query` on the resource calendar. The holder is the
  overlapping event's organizer. If that organizer is the bot, the holder is the
  requester named in the event description. The bot @mentions the holder when
  `users.lookupByEmail` finds them, otherwise shows the name.
- **Risk to verify first:** the bot must be able to book a resource it only has
  `reader` access to. This works only if the bot's Google account is in the
  Acts 2 Network Workspace domain and the resource auto-accepts. The first
  implementation task is a live test booking (then delete). If it fails, RMS
  writes fall back to replying with the calendar link.

## Slack flow

All in channel `RESERVATIONS_CHANNEL_ID` (existing variable, `C0BCSJNECRL`).
Uses the existing receiver → SQS → worker pipeline.

1. **Message in.** A top-level message, or a reply in a bot thread, in
   #reservations.
2. **Parse.** Claude Haiku on Bedrock (`src/services/llm.js`) returns typed
   JSON: `intent` (`book` | `check` | `list` | `other`), `category`, `items[]`,
   `date`, `start`, `end`, `purpose`, `ministry`, `appliances{}`. Relative dates
   are resolved against America/New_York.
3. **Clarify.** If a required field for `book` is missing, or the item matches
   more than one resource, the bot asks in the thread. The thread reply is
   parsed together with the original message.
4. **Ignore.** `other` (ambient chatter) gets no reply.
5. **Book.**
   - Free: write to the backend. Reply in the thread with `reply_broadcast:
     true`, so the confirmation also appears in the channel. That is the feed:
     `✅ Tech Set 2 · Sat 10/17 2:00–4:00 PM · Youth night · @requester`, plus
     a link to the backend.
   - Conflict: write nothing. Reply in the thread: `❌ Tech Set 2 is taken Sat
     2:00–3:30 PM by @holder (Fall rally). Please check with them.`
6. **Check / list.** Read only, reply in the thread.

## Weekly digest

- EventBridge Scheduler → new `digestFunction` (same code base). Schedule
  `cron(0 8 ? * MON *)` with time zone `America/New_York`, so it stays at 8:00 AM
  across DST. It covers Monday through Sunday of the current week.
- It reads all sources in parallel: Rooms, Kitchen, RMS calendars (one
  `events.list` per resource, or `freebusy` plus `events.list` for busy ones
  only, to stay under quota).
- It posts one message to #reservations, grouped by day, then by category, one
  line per reservation: time, item, who. It skips days and categories with
  nothing booked. If nothing is booked at all, it posts "No reservations this
  week." A long week is split across thread replies to stay under Slack's
  message size limit.
- **Source failure:** the digest still posts what it could read. For each
  source that failed, it DMs `ESCALATION_USER_ID` (`U05SWHWFTEH`) with the
  source name and the error. It also logs an error metric so the existing
  alarm path sees it.

## Errors

- A bad or missing config value never throws at load time (same rule as
  `loadJsonConfig`). The affected category answers "not configured" instead.
- Backend write fails: reply in the thread with the error and the backend link.
  The booking is not announced.
- Bedrock call fails: reply "I couldn't read that, please try again". The
  existing Bedrock failure alarm (#57) fires.
- Race between check and write (two requests for the same slot): accept it in
  v1. The bot re-reads just before writing to make the window small.

## Configuration

New repo variables:

- `ROOM_REQUESTS_SHEET_ID`, `ROOM_REQUESTS_TAB` (`Upcoming Room Requests`)
- `KITCHEN_SHEET_ID`, `KITCHEN_TAB` (`FH-Kitchen-RSVP`)
- `TEAM_DIRECTORY_SHEET_ID` (`13nNARlOqKXmzNBOw4hc0chu_RiO7pilmFwUqmZwAT98`)

Reused: `RESERVATIONS_CHANNEL_ID`, `RESOURCE_CALENDARS`, `RESERVATION_ROOMS`,
`ESCALATION_USER_ID`.

Obsolete: `RESERVATIONS_SHEET_ID` (old OneStop sheet `163Qo6…`) and
`VENUE_CALENDARS`. Delete them after launch.

## Units

Each source is one adapter with the same interface, so the Slack flow and the
digest do not know which backend they talk to:

```
listReservations({ date, items? }) -> [{ item, start, end, holder, title }]
findConflicts({ date, start, end, items }) -> [{ item, start, end, holder, title }]
book({ date, start, end, items, purpose, requester, ... }) -> { link }
```

- `src/services/reservations/rooms.js`
- `src/services/reservations/kitchen.js`
- `src/services/reservations/rms.js` (all 4 RMS categories)
- `src/lib/reservation-parse.js`: LLM prompt + JSON validation
- `src/lib/reservation-catalog.js`: item name → category + adapter, alias match
- `src/events/reservations.js`: Slack message flow
- `src/lambda/digest.js`: scheduled digest

## Testing

- Vitest unit tests per adapter with a fake Google client: parsing of real row
  shapes (ragged rows, multi-room cells, mixed time formats), overlap rules,
  kitchen 3-group limit, empty-row selection, write payloads.
- Parser tests with a mocked LLM: fixture messages → expected JSON, missing
  fields → clarify question, chatter → `other`.
- Flow tests: book ok, conflict, clarify, ambiguous item, backend error.
- Digest tests: grouping by day and category, empty week, one source failing →
  post + DM.
- Manual smoke test on real backends with a far-future test date, then clean up.
