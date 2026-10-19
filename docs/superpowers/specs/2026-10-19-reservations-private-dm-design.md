# Private Reservations in DM, with Item Search — Design

**Date:** 2026-10-19
**Status:** Draft, pending review

## Summary

Today `/reserve` posts the member's request publicly in #reservations and the
whole conversation (questions, conflicts, lookups) happens in that public
thread. This change makes every request private:

1. **`/reserve` moves the conversation to the member's DM with the bot.** The
   request, the bot's follow-up questions, conflicts and lookup answers all
   happen there. Nobody else sees them.
2. **#reservations shows two living digests a week instead of per-booking
   posts:** one for the weekdays (Mon–Thu) and one for the weekend (Fri–Sun).
   The bot edits the matching one in place when it books something, so the
   channel shows who holds what without a stream of confirmations.
3. **A new "find" query** answers "what speakers are there?" or "something for a
   picnic" with only the matching items, by meaning, not spelling. There is no
   separate `/reserve-list` command.

## Why

- The catalog has well over a hundred bookable items (rooms, kitchen, tech,
  sports, outreach, accessories, vehicles). A member usually knows roughly what
  they need ("a speaker") but not what the bot calls it. A full list is too long
  to be useful.
- Lookups and half-finished bookings are noise in #reservations. Members asking
  in public is also a reason not to ask at all.
- One command is easier to learn than two. The parser already sorts requests
  into book / check / list, so "find" is a fourth kind, not a new tool.

## Goals

- `/reserve <anything>` works from any channel or DM, and every reply goes to
  the member's DM with the bot.
- Follow-ups ("I still need: date", "Which one did you mean…?") are answered by
  typing in the DM, like a normal chat. No threads needed.
- Find: `/reserve what speakers do you have?` lists matching items with their
  exact names, grouped by category, so the member can book one by name.
- Bare `/reserve` (no text) replies privately with the usage examples and each
  category with its item count, e.g. "Tech (23)".
- The member gets the ✅ confirmation in their DM, with the same content as
  today (items, day, time, title, booking link, tech-set note).
- #reservations stays quiet: no per-booking posts. Edits to the living digests
  don't notify anyone.

## Non-goals

- Checking which matches are free in a find answer. `/reserve is X free <time>`
  already does that.
- Editing or cancelling bookings (unchanged from the hub design).
- An @-mention entry point. A mention is always visible in the channel, which
  defeats the privacy goal.
- Pre-posting digests for future weeks. A booking for a later week shows only
  in the member's DM until that week's digests are posted.
- **My call:** no scheduled refresh. Bookings made directly in the sheets or
  calendars appear the next time the bot edits that digest, or when it is next
  posted. A refresh every few hours can be added later.

## Anti-goals

- Any request text, conflict, or lookup answer appearing in #reservations.
- A message in #reservations for every booking.
- A find answer that dumps the whole catalog. It must stay short enough to read
  in one screen.
- Booking twice from one request (the CLOSED marker must keep working).

## Decided (by the user)

- One command, `/reserve`, handles bookings and all lookups including find.
- Lookups and bookings are private.
- #reservations has a weekday digest and a weekend digest, edited in place as
  bookings are made, instead of a post per booking.
- Follow-ups happen in a DM with the bot (not "resend the whole /reserve").

## How it works (my calls, open to the builder unless marked)

### Conversation shape (decided: no threads in the DM)

The DM is a one-to-one chat, so it is treated as one running conversation.
Members never need to use threads.

- `/reserve <text>` **always starts a new request.** The bot posts to the DM
  with `chat.postMessage({ channel: <userId> })` (needs only `chat:write`; the
  response carries the DM channel id): a plain message "📅 You asked: <text>"
  with the existing `REQUEST_EVENT_TYPE` metadata. That message is the start
  marker.
- **A plain DM message continues the open request**, if one is open. The bot
  reads DM history (`conversations.history`) back to the newest start marker
  and parses everything since as one transcript, the same way a thread is
  re-read and re-parsed whole today.
- **A plain DM message when nothing is open starts a new request.** The bot
  posts a start marker for it (it can't add metadata to the member's own
  message), then handles it.
- **A request is closed** once it is booked, refused (conflict, past date,
  unknown item, backend error) or answered (any check / list / find reply).
  The closing bot message carries `CLOSED_METADATA`, as today. Questions that
  need an answer ("I still need: date", "Which one did you mean…?") do not
  close it.
- **Stale requests close themselves. My call:** if the newest message after
  the start marker is more than 2 hours old, the next message starts fresh.
- **Escape hatch:** "start over" or "cancel" (as the whole message, any case)
  closes the open request with a short acknowledgement.
- Thread replies in the DM, if a member uses one anyway, are handled the same
  way as plain messages: they read the DM history, not the thread.
- If `/reserve` was run outside the DM, the member gets an ephemeral
  "Continuing in your DM with me" with a link to the DM (existing
  `tellPrivately`).

### Routing

- DM events arrive as `message` with `channel_type: "im"`. Two places change:
  - `shouldEnqueueEvent` in `src/lambda/receiver.js` drops any message without
    `thread_ts` today. It must let `channel_type: "im"` messages through.
  - `dispatch.js` must send them to the reservations handler **before** the
    gender handler and the maintenance fall-through. Today a threaded DM message
    would reach the maintenance handler.
- Slash command routing is unchanged (`/reserve`, `/reservations-disconnect`).
- **My call:** the old public-thread path in #reservations stops being a request
  path. Thread replies in #reservations are ignored, including replies to old
  pre-change request posts. The channel then holds only confirmations and the
  digest.

### Find

- The parser gets a fourth intent, `find`, with `items` set to every catalog
  label that fits the member's description. The prompt already includes the full
  catalog. Labels are checked back against the catalog as today, so a
  hallucinated name is dropped.
- `parseReservationRequest` caps output at 512 tokens, so a large find returns
  truncated JSON. Raise the limit enough for the cap below.
- The reply groups matches by category and gives exact labels. **My call:** cap
  at 25 items; past that, say how many more there are and ask the member to be
  more specific.
- No matches: say so and show the bare-`/reserve` category counts.
- "What's available Saturday?" with no item description stays a `list` (what is
  booked), not a find.

### Booking confirmation (DM)

- On success the bot replies in the DM with the ✅ line (as today, minus
  the public broadcast), carrying `CLOSED_METADATA`.
- It then edits the living digest that covers the booking's date, if that
  digest has been posted (see below). A failed edit is logged, never rethrown:
  the booking stands, and SQS must not retry it into a second booking.

### Living digests in #reservations

- **Weekday digest:** posted Monday 8:00 AM New York time, covering Mon–Thu.
  It replaces today's single weekly digest.
- **Weekend digest (decided):** covers Fri–Sun, posted Friday 8:00 AM.
- Content: that period's bookings across all sources, by day and category, as
  `buildDigest` formats them today.
- Each digest post carries Slack message metadata (e.g. event type
  `reservation_digest` with `{ from, to }`). To edit, the bot reads recent
  #reservations history, finds the post whose range covers the date, rebuilds
  the text from the backends and calls `chat.update`. Nothing new is stored.
- After a booking, the digest is rebuilt from the backends rather than patched
  by appending a line, so it also picks up direct bookings since the last edit.
- `buildDigest` splits long text into several messages today. A living digest
  must stay one message: if it would exceed the limit, the builder picks how
  to shorten it (e.g. trimming per-day lists with "+N more").
- The digest Lambda's failure alarm and operator DM on unreadable sources stay
  as they are.

### Slack link on the booking (my call)

- Today the request post's permalink goes into the RMS calendar event
  description (`rms.js`). A DM permalink is useless to anyone else, so the
  permalink is dropped from the description. "Requested by" and the Slack
  `<@user>` stay. Rooms and kitchen never used it.

### Connect-Google flow

- The connect prompt (button) is posted as a normal message in the DM.
  It no longer needs to be ephemeral, since the DM is private.
- `authStore` pending rows store the DM channel. `resume` replies in the DM,
  closes the request and edits the matching living digest, the same as a
  direct booking.

### Slack app changes (the user does these in the Slack app settings)

- Add bot scope `im:history` (read DM messages). The token today lacks it.
  `im:write` is not needed: the bot posts to the DM by user id.
- Subscribe to the bot event `message.im`.
- App Home → Messages tab on, with "Allow users to send messages" ticked.
- Reinstall the app to the workspace so the new scopes take effect.
- Note: in a DM, the bot appears under the Slack app's own name. The
  "FH Reservations" persona (`chat:write.customize`) still sets the message
  name and icon.

## Constraints

- Deploys on push to `main` via `.github/workflows/deploy.yml` (SAM stack
  `fh-maintenance-bot`, us-east-1).
- The receiver must still ack slash commands within 3 s; work stays on the SQS
  worker as today.
- The parser is Claude Haiku on Bedrock (`src/services/llm.js`); the catalog is
  built from `runtime-config/resource-calendars.json` at deploy.
- The code may deploy before the Slack app changes land. Until then,
  `/reserve` still answers in the DM (only `chat:write` is used), but DM replies
  don't reach the bot, so follow-ups don't work. Make the app changes right
  after the deploy.

## Left to the builder

- Exact wording of replies, usage text and the category-count line.
- Whether the find cap is enforced in the prompt, in code, or both (code must
  enforce it).
- Test layout. Existing tests in `tests/events/reservations*.test.js` and
  `tests/lambda/dispatch.test.js` cover the paths that change.
