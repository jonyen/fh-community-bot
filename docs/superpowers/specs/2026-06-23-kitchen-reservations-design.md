# Kitchen Reservations for the FH Community — Design

**Date:** 2026-06-23
**Status:** Draft, pending user review

## Summary

Add a **kitchen reservation** capability to the `fh-community-bot` Slack app,
backed by the *FH Kitchen Management* Google Sheet
(`FH Kitchen Management | 2026 | Arie Chen`,
`1xUA0EG95241Ndb3HBOLw-iYGxU9nBTswzFn8ob49o5c`).

This is a **separate, distinct booking model** from the rooms/resources
reservations bot ([`2026-06-23-reservations-bot-design.md`](./2026-06-23-reservations-bot-design.md)).
It reuses that bot's architecture, Google auth, and Slack triggers, but has its
own sheet shape, write semantics, and conflict rule.

Users can **check** kitchen availability, **list** kitchen reservations over a
window, and **make** a kitchen reservation (with the appliances they need).

## Goals

- Check: "is the kitchen free Sat 5–7pm?" → free/full answer.
- List: "who's using the kitchen this weekend?" → matching reservations.
- Reserve: fill a kitchen slot for a date/time with selected appliances.
- **Slot-count conflict only**: allow a booking if **fewer than 3 groups**
  overlap that time frame; reject otherwise. (Mirrors the sheet's own rule:
  *"No more than 3 ministry groups at same cooking time frame please."*)

## Non-goals

- **Appliance-level contention** (whether a specific numbered appliance is
  free). v1 tracks slot count only; appliances are recorded, not arbitrated.
- Editing/cancelling existing kitchen reservations.
- Reshaping the kitchen sheet or its rolling-date formulas.
- Room/resource reservations (covered by the other spec).

## Key facts discovered during design

The sheet was inspected directly with the bot's existing Google refresh token.

- **One spreadsheet, one relevant tab**: `FH-Kitchen-RSVP`
  (other tabs `WorkRequest`, `FORMULA` are ignored).
- **Header is on row 2** (0-indexed). Rows 0–1 are instructions, including the
  3-group rule. Data starts at row 3 (rows 3–5 are `SAMPLE` examples).
- **Columns** (24): `Date | Name | Phone Number | Start Time | End Time` then
  appliance/station columns: `Kitchen Island (3)`, `White Counter w/ Outlets`,
  `Brown Counter w/ Outlets`, `Freezer (# shelf)`, `Fridge (# shelf)`,
  `Toaster Oven`, `Air Fryer`, `Microwave`, `Large Rice Cooker (#)`,
  `8-cup Rice Cooker (# of 2)`, `Instapot (#)`, `Soup Warmer (#)`,
  `Skillets (#)`, `Griddles (#)`, `Roasters (#)`, `Induction Stove (#)`,
  `# of Outlets`, `Other Items`, `Notes`.
- **Cell types**: appliances are **TRUE/FALSE** checkboxes, some are **counts**
  (`4`), shelf-based ones use `--`.
- **Pre-allocated slot grid**: exactly **3 empty slot-rows per date**, already
  present (e.g. `Mon, 06/22` occupies three rows). A booking **fills an existing
  empty slot-row** — it does **not** append or insert a row.
- **Rolling dates via formula**: column A's dates cascade from a single "today"
  cell; past dates are periodically cleared and reused. The bot must **not**
  overwrite column A — only the slot fields (B onward) of an empty row.
- **Date format**: `Mon, 06/22` (`Ddd, MM/DD`, no year).

## Architecture

Identical plumbing to the reservations bot: Slack → ReceiverFn (3s ack) → SQS →
WorkerFn → handler. A new handler (or an extension of the reservations handler)
routes kitchen intents. Replies post in-thread, optionally as a
`"Reservations"` / `"Kitchen"` username override.

## Modules

- **`src/services/kitchen.js`** — kitchen-specific logic:
  - read `FH-Kitchen-RSVP`, parse with the **row-2 header** and skip
    `SAMPLE`/instruction rows.
  - group rows by date; identify **filled vs empty** slot-rows (a row is
    "filled" when `Name` and/or times are set).
  - overlap + slot-count check (count filled slots whose `[start,end)` intersect
    the request; reject when the count is already ≥ 3).
  - locate a **target empty slot-row** for the date and build the values to
    write into columns **B..X** (never column A).
  - listing over a date window.
- **`src/services/sheets.js`** (extend, shared) — generic helpers for
  metadata, ranged reads, and a **single-row update** (`values.update` on a
  specific A1 range), used here instead of row insertion.

## Conflict logic (slot-count only)

1. Parse all filled slot-rows for the requested date.
2. Count those whose time interval **intersects** the requested `[start, end)`.
3. If the count is **≥ 3**, reject (kitchen full for that time frame); reply
   lists the overlapping reservations.
4. Otherwise, write into the first **empty** slot-row for that date.
5. If **no empty slot-row** exists for the date (all 3 used / date not yet in
   the rolling window), reply that the date is unavailable — the bot does **not**
   create rows or extend the date range.

## Reserve write semantics

- Target = first empty slot-row for the date (by row index within that date's
  three rows).
- Write `Name`, `Phone Number`, `Start Time`, `End Time`, and set the requested
  appliance columns to `TRUE` (others left as-is / `FALSE`), plus `Notes`.
- Use a **bounded `values.update`** on that row's `B..X` range. **Never touch
  column A** (formula-driven date).
- Times formatted `h:mm AM/PM`; matches existing cells.

## Triggers / UX

- **`@mention`** natural language for check/list/reserve (Groq parses intent +
  date/time + appliance list).
- Optionally a **`/kitchen`** slash command for structured booking.
- Appliance selection in NL ("I need the kitchen Sat 5–7, with the air fryer and
  two rice cookers") → mapped to the appliance columns; unmatched appliance
  names are surfaced, not silently dropped.

## Config (env vars / SSM)

- `KITCHEN_SHEET_ID` — the kitchen spreadsheet id.
- `KITCHEN_SHEET_TAB` — default `FH-Kitchen-RSVP`.
- Optional `KITCHEN_APPLIANCE_ALIASES` — NL alias → column-name map.
- Handler is wired only when `KITCHEN_SHEET_ID` is present (gated like the
  gender handler on `GENDER_SHEET_ID`).

## Auth

Reuses the same Google OAuth2 client as the rest of the bot (Sheets scope is
already present — kitchen is sheet-only, **no Calendar scope needed** for this
spec). No new credential.

## Error handling

- Read/parse failures degrade gracefully ("couldn't check the kitchen right now").
- A write failure never half-fills a row; surface the error.
- 3-second Slack ack preserved (work happens in the worker).

## Testing (Vitest)

- Row-2 header parsing; skipping instruction/`SAMPLE` rows.
- Filled-vs-empty slot detection.
- Date grouping with the `Ddd, MM/DD` format.
- Overlap + slot-count rule (0/1/2 overlapping = allow, 3 = reject; touching vs
  nested intervals).
- "No empty slot for date" path (no row creation).
- Appliance NL → column mapping (incl. aliases, unknown appliance).
- Single-row update writes B..X only and leaves column A untouched (mock client).

## Open questions / TODOs

- **Year inference** for the no-year `Ddd, MM/DD` dates — derive from the rolling
  window / current date; confirm across a year boundary.
- **"Filled" heuristic**: confirm the exact signal that a slot-row is occupied
  (`Name` non-empty vs any appliance TRUE vs times set).
- **Appliance count columns** (`Large Rice Cooker (#)`, etc.): v1 records the
  user's requested value as text; no quantity arbitration.
- Whether to also expose a **`/kitchen`** slash command or keep it @mention-only.
