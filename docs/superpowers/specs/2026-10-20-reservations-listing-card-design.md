# A listing card for browsing what can be reserved

**Status:** Approved
**Date:** 2026-10-20
**Builds on:** [channel chat cards](2026-10-19-reservations-channel-chat-design.md), [cancel and "mine"](2026-10-20-reservations-cancel-and-mine-design.md)

## Why

A member who doesn't already know what the building has can't book it. Right now the bot answers "what speakers are there?" with one line of text, but there is no way to see everything that can be reserved: 11 rooms, the kitchen, and the calendar-booked equipment and vehicles (tech, sports, outreach, accessories, vehicles), which together run to dozens of items.

Success: a member types "list items to reserve", finds the thing they want by paging or searching, presses Reserve, picks a time, and books it, without ever having to know the item's exact name.

## Goals

- A **listing card**: every bookable item, split into pages, with a search box and a category filter.
- A **Reserve** button on each item. Pressing it turns the same card into a **reserve view** for that one item: date, start, end, title, a free/taken line, and Book.
- A booking made this way posts the usual **public ✅ card** in the channel.
- The bot's name in #reservations becomes **"Reservations"**.

## Non-goals

- Replacing the typed request flow. Typing "book Tech Set 2 Saturday 2–4" still gets the normal card in a thread.
- Booking several items at once from the listing card. Reserve is per item; several items is still a typed request or the Edit pop-up.
- Showing availability across the whole list (a free/taken mark next to every item). Availability is checked only in the reserve view, for one item and one time.
- Item photos, descriptions or capacities. The catalog doesn't have them.

## Anti-goals

- **Leaking the listing into the channel.** The listing card and the reserve view are visible only to the person who asked.
- **A second, different way of booking.** Book from the reserve view must go through the same booking path as the card's Book: same backends, same Google account and connect rules, same ownership, same ledger, same digest refresh, same ✅ card with Cancel booking.
- **Losing the member's place.** Back from the reserve view returns to the same search, category and page.

## Decisions made with the user

- Triggered by asking in #reservations: "list items to reserve", "list reservations" and similar.
- Paginated, with search.
- Reserve turns the listing card into the reserve view, in place (mockup option A), rather than opening a pop-up.
- The bot posts as "Reservations", not "FH Reservations".
- The listing card is private to the person who asked.
- A booking made from it posts the usual public ✅ card in the channel.

## How it behaves

### Asking for it

A new intent, `browse`, recognised by the existing LLM parser: the member asks to see what can be reserved ("list items to reserve", "what can I reserve?", "show me everything", "list reservations" with no day or item named). It is handled like other top-level messages in #reservations (chatter filter, redelivery check).

If the message also names a search ("list speakers to reserve", "what tech can I book?"), the parser returns it in a new `search` field (the words as the member wrote them), and the card opens with that search run. "What speakers are there?" stays the existing `find` intent and its one-line answer.

The reply is an ephemeral message in the channel (not in a thread), visible only to the asker.

### The listing card

```
📅 Reservations                       APP · Only visible to you
📋 Things you can reserve · 64 items
[ 🔍 Search, e.g. "tech", "youth" (press Enter) ]  [ All categories ▾ ]
L120                · Rooms        [Reserve]
MPR                 · Rooms        [Reserve]
Kitchen             · Kitchen      [Reserve]
...
[◀ Prev]           Page 1 of 7            [Next ▶]
```

- Items in catalog order (rooms, kitchen, then calendar items by category), each with its category.
- **Search** is a text box; pressing Enter runs it (Slack can't filter a card as you type). It first matches the words against item names, room aliases (for example "multipurpose room", "240") and category names, case-insensitively. Item names are often not what people type ("speaker", "van", "volleyball" match no name), so **when nothing matches literally, the bot asks the model which items fit the words**, the same way the `find` intent works, and shows those. An empty search shows everything.
- The card stores the search **words**, not the resulting items, and re-runs the search on each page change. The model's answer for a given search is cached briefly (in memory or the auth table) so paging doesn't call the model again for every page.
- **Category** dropdown: "All categories" plus each category that has items. It combines with the search.
- About 8 items per page. Prev and Next appear only when there is a page in that direction. Changing the search or category returns to page 1.
- No matches: "Nothing matches "<search>"." with the category counts line (`categoryCounts`) so the member can try a category instead.
- The header count reflects the current filter ("12 items match "tech"").

### The reserve view

Pressing Reserve replaces the listing card (same ephemeral message, through `response_url`) with:

```
📅 Reserve Tech Set 2
[📆 date ▾] [🕑 start ▾] [🕓 end ▾]
[ Title, e.g. Youth night ]
✅ Free Sat Oct 24, 2–4pm          (once date, start and end are picked)
[Book]  [◀ Back to list]
```

- Date picker, start and end time pickers, a title box. For the kitchen, the appliances too, as the Edit pop-up asks them.
- Each time a picker changes, the bot re-checks that one item for that date and time, and shows ✅ free, ❌ taken (by whom, with the existing mentions), or the same past/invalid notes the card gives (end before start, a time already past).
- Pressing **Book** before date and times are picked, or when the time is taken, answers in the card ("Pick a date and times first." / "That time is taken.") rather than booking. Book re-checks availability itself; the line on the card is only a preview.
- **Book** runs the existing booking path (`finishBooking` and what it calls), with the same Google account rules: when connect is configured and the member isn't connected, the connect prompt appears and the booking resumes after they connect.
- On success:
  - the bot **posts a ✅ card publicly in the channel**, top-level, with the same text and Cancel booking button a typed booking ends with (a typed booking edits its card in a thread; this one is a new top-level post, since there is no public card to edit);
  - the private card changes to "✅ Booked. It's posted in the channel." with a Back to list button.
- **Back to list** restores the listing card at the same search, category and page.

### After connecting Google, and failures

When Book needs the member to connect Google first, the pending row records a new kind (`listing`) with the item, date, times, title, appliances and requester. After they connect, the booking resumes and:

- success posts the public top-level ✅ card, as above. The private card is not updated: its `response_url` may have expired (30 minutes), and the public card is the record.
- taken, failed, or no-edit-access results go to the member **privately** (a new ephemeral in the channel), never as a public post.

A Book that fails outright (not taken, an error) replies in the private card and books nothing.

### Duplicates

- A redelivered "list items to reserve" may produce a second private listing card. This is accepted, as for "mine".
- A double press of Book, or a redelivered Book, must not book twice. The claim is keyed on the member, item, date, start and end (for example `listing:<U>:<item>:<date>:<start>:<end>`), with a short TTL, using the existing claim mechanism.

### The living digest

Top-level ✅ posts push the digest further up the channel. `livingDigest.refresh` today only scans the last 100 messages to find it. It must keep finding the current digest however busy the channel gets (for example by storing the digest's ts when it is posted, or paging further back).

### The bot's name

`BOT_PERSONA.username` becomes "Reservations" (icon unchanged, :calendar:). This renames everything the bot posts in #reservations, including cards and the living digest. Maintenance replies keep "FH Maintenance". Messages already posted keep their old name; Slack doesn't rename them.

## Constraints

- Slack's 3-second rule: interactions are acked by the receiver and done by the worker, as Book is today. Picker changes in the reserve view are interactions too.
- Ephemeral messages can't be `chat.update`d; every change goes through the interaction's `response_url` with `replace_original`.
- The listing card's state (search, category, page, and in the reserve view the item and the chosen values) must ride in the message itself (block ids, button values, `private_metadata`-like fields), since there is no server-side session. Button values are at most 2,000 characters.
- An ephemeral message is at most 50 blocks; a page of 8 items plus controls fits comfortably.
- Copy follows the existing card style: emoji lead, `·` separators, plain sentences.

## Calls made in writing this up (not discussed with the user)

- **"list reservations" goes to browse only when nothing else is named.** "List reservations for Saturday" or "list reservations for Room 101" stays the existing `list` intent (what's booked). Only a bare request to see what can be reserved becomes `browse`.
- **The reserve view is one item.** Matches "Reserve" on a row; multi-item stays with typed requests.
- **Search falls back to the model.** Literal name, alias and category matching first; the model only when nothing matches literally, so common searches are instant and "speaker" still finds the speakers.
- **Top-level public ✅ post** rather than a thread under a short parent post. One message per booking, same as the card people already know.
- **Results after connecting Google are private** except the public ✅ card.
- **Duplicate private listings are accepted**; duplicate bookings are not.
- **Availability is checked live as pickers change**, not only on Book, so the member sees "taken" before pressing.
- **Page size 8.**
- **After booking, the private card offers Back to list** so the member can book something else without asking again.
- **The rename applies to all of #reservations**, not just the listing card, so the bot has one name in the channel.

## Left to the builder

- Exact block layout, block and action ids, and how state is encoded in the message.
- Whether the time pickers use Slack's `timepicker` or a static select of half hours.
- Whether picker changes are debounced (for example only re-check when date, start and end are all set).
- Tests: paging boundaries, search + category combined, no matches, Back restoring state, Book from the reserve view producing the public ✅ card and the ledger entry, taken and past times, the connect prompt path, someone pressing a stale card.
