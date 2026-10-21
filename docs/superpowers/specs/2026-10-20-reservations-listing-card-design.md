# A listing card for browsing and reserving, with a tray for several items

**Status:** Approved (revised: tray, repeats and combined post)
**Date:** 2026-10-20
**Builds on:** [channel chat cards](2026-10-19-reservations-channel-chat-design.md), [cancel and "mine"](2026-10-20-reservations-cancel-and-mine-design.md)

## Why

A member who doesn't already know what the building has can't book it. Right now the bot answers "what speakers are there?" with one line of text, but there is no way to see everything that can be reserved: the rooms on the Management doc, the kitchen, and well over a hundred calendar-booked equipment items and vehicles.

Members also book in bulk: several things for one event (a room, a tech set, coolers), and the same thing every week (the MPR for MBS every Saturday and Sunday). Today each is its own typed request and its own card, and rooms, the kitchen and equipment can't be booked together.

Success: a member types "list items to reserve", finds what they need by paging or searching, adds each item to a tray with its own day, time, title and repeat, presses **Reserve all** once, and sees one public post with what was booked and what couldn't be.

## Goals

- A **listing card**: every bookable item, split into pages, with a search box and a category filter.
- A **tray** on the card: **+ Add** puts an item in it; each tray line has its own date, start, end, title, repeat (and kitchen appliances), edited one line at a time on the card.
- **Repeats**: weekly on chosen weekdays, until a date.
- **Reserve all** books every line and date that is still free, in whichever backend each item lives (rooms sheet, kitchen sheet, RMS calendars), and reports what couldn't be booked because someone already has it.
- **One combined public post** in the channel per Reserve all.
- The bot's name in #reservations becomes **"Reservations"**.

## Non-goals

- Replacing the typed request flow. Typing "book Tech Set 2 Saturday 2–4" still gets the normal card in a thread.
- Repeat patterns other than weekly on chosen days (every other week, first Sunday of the month). They can be added later.
- Availability next to every item in the listing. Availability is shown per tray line.
- Item photos, descriptions or capacities. The catalog doesn't have them.

## Anti-goals

- **Leaking the listing or the tray into the channel.** Both are visible only to the member.
- **A second, different way of writing bookings.** Each booking Reserve all makes goes through the same path a card's Book uses: same adapters, same Google account and connect rules, same ledger entry, same digest refresh. "What do I have booked?" and its Cancel see these bookings like any other.
- **Booking something the member didn't see as free without saying so.** Anything not booked is named in the result, with who has it.
- **Flooding the channel.** One public post per Reserve all, however many bookings it made.

## Decisions made with the user

- Triggered by asking in #reservations: "list items to reserve", "list reservations" and similar.
- Paginated, with search.
- The card changes in place (no pop-up): a line's form replaces the listing view on the same card, and Back returns.
- Several items at once, each customised on its own (its own date, time, title, repeat). The collection lives on the card as a tray (mockup option A).
- Rooms, the kitchen and equipment can all go in the same tray. Rooms are reserved by the bot writing rows to the Management doc (the rooms sheet), as today.
- Repeats are needed (the known case: MPR for MBS every Saturday and Sunday).
- The listing card is private to the member who asked.
- When some lines or dates are taken at Reserve all, the bot books everything else that is free and says which couldn't be booked because they were already claimed.
- Cancelling a repeat asks whether to drop the whole series or just one date.
- The result is one combined public post in the channel.
- The bot posts as "Reservations", not "FH Reservations".

## How it behaves

### Asking for it

A new intent, `browse`: the member asks to see what can be reserved ("list items to reserve", "what can I reserve?", "list reservations" with no day or item named). It is handled like other top-level messages in #reservations (chatter filter, redelivery check). If the message also names a search ("list speakers to reserve"), the parser returns it in a new `search` field (the member's words) and the card opens with that search run. "What speakers are there?" stays the existing `find` intent.

The reply is an ephemeral message in the channel, not in a thread.

### The listing view

```
📅 Reservations                                   APP · Only visible to you
📋 Things you can reserve · 140 items
[ 🔍 Search, e.g. "tech", "youth" (press Enter) ]  [ All categories ▾ ]
MPR                 · Rooms        [✓ Added]
Tech Set 2          · Tech         [+ Add]
Kickball            · Sports       [+ Add]
...
[◀ Prev]                 Page 1 of 18                   [Next ▶]
── Your tray (2) ─────────────────────────────────────────
MPR · Sat Oct 24 · 2–4 PM · MBS · every Sat, Sun until Dec 20 · 18 dates · ⚠️ 2 taken   [Edit]
Tech Set 2 · Sat Oct 24 · 1:30–4:30 PM · Youth night · ✅ free                          [Edit]
[Reserve all]  [Clear]
```

- Items in catalog order, each with its category. An item already in the tray shows **✓ Added** (pressing it opens its tray line).
- **Search** is a text box; Enter runs it. It first matches the words against item names, room aliases (for example "multipurpose room", "240") and category names, case-insensitively. Item names are often not what people type ("speaker", "volleyball" may match no name), so **when nothing matches literally, the bot asks the model which items fit the words**, as the `find` intent does, and shows those. An empty search shows everything. The model's answer for a search is cached briefly so paging doesn't call it again.
- **Category** dropdown: "All categories" plus each category that has items; it combines with the search.
- 8 items per page. Prev/Next only when there is a page that way. A new search or category returns to page 1.
- No matches: `Nothing matches "<search>".` with the category counts line.
- The tray section appears once the tray has a line.

### A tray line's form

**+ Add** (or **Edit** on a tray line) replaces the listing view with that line's form:

```
📅 Tech Set 2 · Tech
[📆 date ▾] [🕑 start ▾] [🕓 end ▾]
[ Title, e.g. Youth night ]
Repeat: (•) No  ( ) Weekly on [Sun][Mon][Tue][Wed][Thu][Fri][Sat]  until [📆 ▾]
✅ Free Sat Oct 24, 1:30–4:30 PM        (or ⚠️ 2 of 18 dates taken: Sun Nov 8 (@alan), Sat Nov 21 (Youth))
[Save]  [Remove]  [◀ Back to list]
```

- Kitchen lines also show the appliances, as the Edit pop-up does.
- **+ Add** pre-fills from the line added just before it (date, times, title, repeat), since items for one event usually share them. The first line starts empty.
- Each change re-checks that line: every date it covers, for that item and time. It shows free, the taken dates with who has them, or the same notes the card gives (end before start, a date or time already past).
- **Save** keeps the line (even if incomplete or partly taken) and returns to the listing view at the same search, category and page. **Remove** drops it. **Back** returns without saving changes.
- A repeat's first date is the line's date. "Weekly on Sat, Sun until Dec 20" from Sat Oct 24 is every Saturday and Sunday from Oct 24 to Dec 20.

### Reserve all

- Refused, with the reason in the card, when any line is missing a date, times or title, or the tray is over its limits (below).
- Otherwise every date of every line is re-checked and **each free one is booked** through the normal booking path, as the member (connect rules apply; see below). Several items on the same date, time and backend may be written as one booking where the backend already supports several items (RMS events take several resources; a rooms row takes several rooms); that is the builder's call.
- Taken dates are skipped, never written.
- **Anything else that isn't booked is reported the same way**, with its reason instead of a holder: the kitchen sheet has no row for that date yet ("kitchen sheet not open for that date yet"), the calendar declined the resource, calendar booking is switched off, or a write error. These dates stay in the tray and appear under "Not booked" in the public post.
- **No edit access (forbidden)** for a backend stops the rest of that backend's dates (they would all fail) and reports them with the existing "ask <owner> for access" text; other backends carry on. **A revoked Google grant** partway through stops the run there: what was already booked is posted, the rest stays in the tray, and the member gets the connect prompt; after connecting, Reserve all continues with what's left.
- **Kitchen repeats are allowed**; dates whose kitchen row doesn't exist yet show as "not open yet" in the form's check, before Reserve all.
- **Progress is recorded per date as it is written** (in the stored tray), so if the worker is cut off or the event is retried, the next run carries on from the first unwritten date rather than starting over or giving up, and the post and ledger are completed by whichever run finishes.
- RMS bookings poll for the resource's answer (about 1.5–12 s each), so Reserve all books calendar dates a few at a time in parallel (bounded concurrency, for example 4) and the worker's timeout is raised (for example to 300 s, with the queue's visibility timeout raised to match AWS's guidance of at least 6× the function timeout). The 60-date cap stays.
- The tray is cleared of everything that was booked. Lines with dates that couldn't be booked stay in the tray with only those dates, so the member can change them and try again.
- The private card shows the result and the remaining tray.

### The combined public post

One top-level post in the channel per Reserve all:

```
✅ @Deandra reserved:
• MPR · every Sat, Sun Oct 24 – Dec 20 (16 dates) · 2–4 PM · MBS
• Tech Set 2 · Sat Oct 24 · 1:30–4:30 PM · Youth night
⚠️ Not booked, already claimed:
• MPR · Sun Nov 8 · 2–4 PM (@alan · Fall rally)
• MPR · Sat Nov 21 · 2–4 PM (Youth · Game night)
```

- One line per tray line; repeats summarised with their date span and count.
- The "Not booked" part appears only when something was skipped.
- Each booked line has its own **Cancel** button (only the member who booked can use it). For a single date it is the usual Cancel booking with Slack's confirm dialog. For a **repeat series**, pressing Cancel asks the member privately: **cancel the whole series** (every date not yet ended) or **one date** (a dropdown of the series' upcoming dates), then confirms. The post's line is updated to show what was cancelled (for example "🚫 Sun Nov 29 cancelled" or "🚫 series cancelled").

### Repeat series afterwards

- A series is remembered as one unit: the ledger keeps one entry per series (its id, item, time, title and the refs of each booked date), so the 50-entry cap per member and "mine"'s 20-line cap count a series once.
- "What do I have booked?" shows a series as one line ("MPR · every Sat, Sun until Dec 20 · 14 dates left · 2–4 PM · MBS") with the same Cancel that asks series or one date. Series lines are shown whatever their span, not only within the 60-day window.
- Rows typed into the sheets by hand are not grouped into series; they stay one line each, as today.
- If nothing at all could be booked, there is no public post; the private card says so.

### Connecting Google

When booking as the member needs them to connect Google first (connect configured, member not connected or revoked), Reserve all books nothing and shows the connect prompt privately. The tray is kept. After they connect, Reserve all runs from the stored tray, posts the combined post publicly, and sends the member a private note with the result. Failure and "nothing booked" outcomes are private.

### The tray's storage and limits

- The tray is stored by the bot per member in the existing DynamoDB table (the auth/ledger table), not inside the card, so it survives the card being closed and can hold more than button values allow. It expires after 24 hours untouched.
- Asking for the listing again shows the existing tray.
- At most 10 lines; a repeat at most 6 months; at most 60 dates across the whole tray per Reserve all (the worker has 60 seconds, and the sheets have write quotas). Over a limit, the form or tray says which, and Reserve all is refused until it's trimmed.
- Without the table configured, the listing view works but **+ Add** is replaced by a hint to post a typed request.

### Duplicates

- A redelivered "list items to reserve" may produce a second private listing card. Accepted, as for "mine".
- A double press of Reserve all, or a redelivery, must not book twice. Each date is marked in the stored tray (conditional write) before it is written and marked done after, so a second run skips dates already started. A date left "started" but not "done" by a crash is reported as "may already be booked, please check" rather than written again, as a card's Book does today.

### The living digest

Top-level posts push the digest up the channel; `livingDigest.refresh` only scans the last 100 messages today. It must keep finding the current digest however busy the channel gets: page further back through history (for example up to 1,000 messages, stopping at messages older than the period's start minus a week), so the digest Lambda gains no new dependency. Reserve all refreshes each affected period once, not once per booking.

### The bot's name

`BOT_PERSONA.username` becomes "Reservations" (icon unchanged). This renames everything the bot posts in #reservations, including cards and the digest. Maintenance replies keep "FH Maintenance". Old messages keep their old name.

## Constraints

- Slack's 3-second rule: interactions are acked by the receiver and handled by the worker, as Book is today. Every picker change on the form is an interaction.
- Ephemeral messages can't be `chat.update`d; every change to the private card goes through the interaction's `response_url` with `replace_original`. A `response_url` lasts 30 minutes.
- An ephemeral message is at most 50 blocks; 8 items, a 10-line tray and the controls must fit.
- Button values are at most 2,000 characters and block ids 255.
- Copy follows the existing card style: emoji lead, `·` separators, plain sentences.

## Calls made in writing this up (not discussed with the user)

- "List reservations" opens the listing only when no day or item is named; "list reservations for Saturday" stays the existing `list`.
- Search falls back to the model only when nothing matches literally.
- **+ Add pre-fills from the previous line.**
- Weekly-on-days-until is the only repeat pattern, capped at 6 months. The user didn't name others.
- Limits: 10 lines, 60 dates per Reserve all, 24-hour tray expiry.
- **Unbooked dates stay in the tray** for another try.
- **Connecting Google holds the whole Reserve all** rather than booking the part the bot could book under its own account.
- The rename applies to all of #reservations.
- Duplicate private listings accepted; duplicate bookings not.
- Non-"claimed" failures are reported alongside claimed ones, each with its reason.
- Worker timeout raised and calendar bookings run a few at a time, rather than splitting Reserve all across queue messages.
- The digest is found by paging history, not by storing its ts.

## Left to the builder

- Block layout, block and action ids, how listing position (search, category, page) rides in the message.
- Whether same-date items in one backend are combined into one booking.
- How many availability lookups a repeat check makes (one range read per item is enough for the sheets and calendars).
- Whether time pickers are Slack `timepicker`s or half-hour selects.
- Tests: paging boundaries, search + category, the model fallback (and its failure), add/edit/save/remove/back, repeat expansion (including the until date and the 6-month cap), partly taken repeats, Reserve all across all three backends, the combined post with and without skips, Cancel on a single line and on a series (whole series and one date), series in "mine", the connect path, a double press, and an expired tray.
