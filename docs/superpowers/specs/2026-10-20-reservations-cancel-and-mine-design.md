# Cancel and "my reservations" in #reservations

**Status:** Approved
**Date:** 2026-10-20
**Builds on:** [2026-10-19 reservations channel chat](2026-10-19-reservations-channel-chat-design.md) (cards with Book and Edit)

## Why

Members book by posting in #reservations and pressing Book on the card the bot replies with. Two things are missing:

1. **There is no way out.** A member who changes their mind before booking leaves an open card behind. A member who no longer needs a booking has to find it in the right sheet or calendar and delete it by hand, and most don't know where it lives.
2. **There is no way to see your own bookings.** The bot can list what is booked for an item or a day, but not "what do I have booked?". Bookings are spread across three places (the rooms sheet, the kitchen sheet, RMS resource calendars), some made through the bot and some typed in directly.

Success: a member asks "what do I have booked?", sees all of their upcoming bookings in one private reply, and can cancel any of them with one press plus a confirmation.

## Goals

- A **Cancel** button on every open card (before booking).
- A **Cancel booking** button on the ✅ card after a booking is made.
- A **"my reservations"** reply, listing the asker's upcoming bookings from all three backends, including bookings typed directly into the sheets or made directly in Google Calendar, each with its own Cancel button where the bot can cancel it.

## Non-goals

- Changing a booking in place (move the time, swap a room). Cancel and book again.
- Cancelling on someone else's behalf. Only the person who booked can cancel (the user's decision). No admin override.
- Showing other people's bookings in the "mine" reply. The existing check/list replies already do that.
- Notifying anyone when a booking is cancelled, beyond the card update and the digest refresh.

## Anti-goals (would make this a failure even if it works)

- **Deleting the wrong booking.** Any cancel that removes a row or event that is not the one the member saw is the worst outcome. Every cancel re-reads the target and checks it still matches before deleting; if it doesn't, nothing is deleted.
- **Leaking someone's bookings to the channel.** The "mine" reply is private (ephemeral).
- **Making Management's rooms sheet worse to work with**, for example by leaving half-blank rows or reordering it.

## Decisions made with the user

- Two kinds of cancel: before booking (close the card) and after booking (undo the booking).
- Only the person who booked can cancel. Anyone else pressing the button gets the same private "Only <@U> can …" note the other card buttons give.
- "My reservations" is part of this change.
- Bookings typed directly into the rooms and kitchen sheets appear in "my reservations". They are matched to the member by **best-guess name matching**, and they are **cancellable** too.

## How it behaves

### Cancel before booking

Every open card (any state: free, taken, missing, ambiguous, past, mixed) gets a **Cancel** button after Book and Edit. Only the requester can use it. Pressing it closes the card (buttons removed, `CLOSED_METADATA`) with the text `🚫 Cancelled by <@U>.` Nothing is written anywhere. No confirmation dialog, since nothing is lost: the member can post again.

### Cancel after booking

The ✅ card keeps one button, **Cancel booking**. It uses Slack's built-in `confirm` dialog on the button, naming what will be removed (items, day, time). Only the booker can use it.

On confirm, the bot locates the booking, checks it still matches, and undoes it:

| Backend | Undo |
|---|---|
| RMS | Delete the calendar event (`events.delete`, `sendUpdates: "all"` so the resource releases the slot). Uses the member's Google clients if the event is on the member's calendar, the bot's otherwise. |
| Rooms sheet | Write `Canceled` in the row's Status column (H). The row stays. |
| Kitchen sheet | Clear the name, phone, time and appliance cells (B–P) of the row, leaving the pre-dated row in place for someone else. |

The card then becomes `🚫 Booking cancelled by <@U>.` with the original summary line kept above it for the record, and the living digest refreshes for that date.

If the booking can't be found or no longer matches (someone edited it), the bot deletes nothing and updates the card to say so, with a link to the sheet or calendar to fix it by hand. If the delete call fails, same: nothing assumed, link given.

A booking that has already ended can't be cancelled; the button is left off once the end time has passed, and a stale press after that answers privately "That booking has already ended."

Cards booked before this change have no stored location and get no Cancel booking button. Those bookings are still reachable through "my reservations".

### "My reservations"

A top-level message in #reservations asking for one's own bookings ("what do I have booked?", "my reservations", "show my bookings") is a new intent, `mine`, recognised by the existing LLM parser. Chatter filtering and the redelivery check work as for other messages.

The reply is **ephemeral** in the channel (only the asker sees it). It lists the asker's bookings from today through 60 days ahead, sorted by date and time, one line each in the existing summary style (items · day · time · title), with a source tag when the match was a guess (for example `· from the rooms sheet, matched by name`). Each line that can be cancelled has its own **Cancel** button with a `confirm` dialog; the dialog for a name-matched row quotes the row exactly as typed (title, name, date, time) so the member can spot a wrong match before confirming.

If nothing is found: "I don't see any upcoming bookings under your name." followed by links to the rooms sheet, kitchen sheet and calendar, since a booking under a nickname may not match.

After a cancel from this list, that line is replaced with the 🚫 text (the ephemeral message is replaced through its `response_url`; ephemeral messages can't be `chat.update`d).

### Whose booking is it

| Source | How it is matched to the member | Cancellable |
|---|---|---|
| Booked through the bot, any backend | Exact: the bot's own ledger (below), and for RMS also the `Slack: <@U>` line it writes in the event description | Yes |
| RMS event the member made directly in Google Calendar | Organizer or creator email equals the member's Slack profile email | Yes, if the member has connected Google (the bot can't delete events on someone else's calendar); otherwise listed with an "Open in Calendar" link |
| Rooms or kitchen row typed in by hand | Best-guess name match (below); for the kitchen also the phone number | Yes, behind the confirm dialog that quotes the row |

**Name matching (best guess).** Compare the sheet's name cell (rooms column F, kitchen column B) against the member's Slack `real_name` and `display_name`, after normalising both: lowercase, strip accents, punctuation and anything in parentheses, collapse spaces. A row matches when any of:

- the normalised names are equal;
- the sheet name contains the member's full real name as whole words (for example "Jon Yen - Youth");
- first and last name match with the middle dropped or the order reversed;
- the sheet has first name plus last initial ("Jon Y") and the member's real name has that first name and initial.

First name alone does not match: it is too common in a church community to trust for a delete. For the kitchen, a row also matches when its phone cell and the member's Slack profile phone have the same last 10 digits.

### The booking ledger

The rooms and kitchen sheets are owned by Management and Arie, so the bot can't add a column to them for a Slack ID. Instead the bot records every booking it makes in the existing DynamoDB table (`fh-community-reservations-auth`, hash key `pk` only): who booked it, backend, items, date, start, end, title, and the locator (RMS: calendar id and event id; rooms: the values it wrote; kitchen: the row number and values it wrote). Entries expire through the table's TTL a day after the booking ends.

Sheet rows are always **found by content at cancel time**, not by row number alone, because Management may sort or insert rows in the rooms sheet. The kitchen row number is stable (pre-dated rows) but its contents are still checked before clearing.

The ✅ card's Cancel booking button carries enough to find the ledger entry (or, for RMS, the event directly).

## Calls made in writing this up (not discussed with the user)

- **Which Google account cancels.** A cancel uses the same account rules as Book: when connected accounts are configured, the cancel is written as the member, and an unconnected or revoked member gets the same connect prompt, with the cancel resuming after they connect (the existing pending/resume path, extended to cancels). A 403 gets the same "no edit access" reply as Book. Without connect configured, the bot's account does it, as Book does.
- **RMS: whole event or one resource.** Events the bot made with no human attendees are deleted. For any other event (made directly in Google Calendar, or with human guests), Cancel removes only the member's resource attendees and patches the event, so human guests' meetings survive. "Mine" merges lines for the same event across resource calendars into one line, and its Cancel releases all of that event's resources. For a recurring event, Cancel affects only that one occurrence.
- **What "still matches" compares.** Rooms: title, date, start, end, name and rooms. Kitchen: name, date, start, end. Status, notes and appliance columns are not compared, so a row Management has approved, or Arie has annotated, can still be cancelled by the member who booked it.
- **"Mine" horizon.** Today through 60 days ahead. Longer horizons cost many more calendar reads per request; 60 days covers what people plan around. Beyond the cap of 20 lines, a closing line says how many more there are, with links.

## Rooms sheet: mark, don't delete (user's decision)

A cancelled rooms booking is not removed. The bot writes `Canceled` in the row's Status column (H), leaving the rest of the row for Management's records. `rooms.js` treats `canceled` and `cancelled` like Denied/Declined everywhere (conflicts, lists, digest, "mine"). A row already marked canceled can't be cancelled again; a redelivered cancel finds it marked and says it is already cancelled.

## Constraints

- Slack's 3-second rule: button presses are acked by the receiver and done by the worker, as Book is today. The confirm dialog is client-side and needs no round trip.
- Slack button `value` is at most 2,000 characters; an ephemeral message is at most 50 blocks, so the "mine" list caps at the first 20 or so bookings with a "and N more, see the sheet/calendar" line.
- A cancel is an SQS event like Book. A redelivered cancel must not delete a second, different booking; re-reading the target and checking it still matches covers this (the second attempt finds nothing and says so).
- Copy follows the existing card style: emoji lead, `·` separators, plain sentences.

## Left to the builder

- Exact wording beyond the strings above, block layout, and button ordering details.
- How the ledger is keyed within a hash-key-only table (for example one item per member holding a small list, pruned of ended bookings).
- How RMS lookups for "mine" are batched across resource calendars (the adapter already lists with bounded concurrency).
- Whether the before-booking Cancel and the after-booking Cancel share an action id with a mode in the value, or use two action ids.
- Tests: each backend's undo, each match rule (including the first-name-only non-match), stale and redelivered presses, someone else pressing, the edited-since case, and the empty "mine" reply.
