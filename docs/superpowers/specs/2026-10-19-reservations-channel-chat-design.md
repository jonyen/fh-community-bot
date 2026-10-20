# Reservations by Chatting in #reservations — Design

**Date:** 2026-10-19
**Status:** Approved
**Replaces:** the DM conversation in [`2026-10-19-reservations-private-dm-design.md`](./2026-10-19-reservations-private-dm-design.md)

## Summary

`/reserve` is friction, and a private conversation needs a lot of state. This
change makes **#reservations itself** the place to ask and book. A member writes
a plain message in the channel. The bot answers questions in a thread, and
answers booking requests with a **card** in a thread that has **Book** and
**Edit** buttons.

Members who want privacy book directly in the calendar or sheet. The digests
already pick those bookings up.

## Decided (by the user)

- Requests are plain top-level messages in #reservations. No @mention needed.
- `/reserve` is removed. There is no alias.
- Everything happens in the channel. There is no private path through the bot.
- The bot reads every top-level message, and replies only to questions and
  booking requests. It stays silent on chatter.
- Booking requests get a card with Book and Edit buttons.
- Booking confirmations stay in the thread. The channel sees bookings in the
  living digest only.
- Connected Google accounts stay. Bookings are written as the member.

## Goals

- Ask or book by typing one message. Book with one click after that.
- No back-and-forth conversation. Each message is handled on its own, and the
  card plus the Edit modal fill any gaps.
- Members see what the bot understood (item, day, time) before anything is
  written.
- People can talk in threads (for example, to work out a conflict with the
  holder) without the bot getting in the way.

## Non-goals

- Cancelling or editing bookings from Slack (unchanged; a later change).
- Changing the backends, the adapters, the catalog or the digests.
- Changing how bookings are attributed. Connected Google accounts stay as they
  are, apart from where the connect prompt and `resume` reply (see Book).

## Flow

### 1. Message in

- The receiver enqueues top-level, human, non-subtype messages in
  `RESERVATIONS_CHANNEL_ID`. Today `shouldEnqueueEvent` drops top-level
  messages unless they mention someone.
- Thread replies in #reservations are dropped. They belong to people.
- A message that @mentions the bot arrives twice (`app_mention` and
  `message`). Only the `message` is handled, as today.

### 2. Parse

The existing parser (`parseReservationRequest`) returns `book`, `check`,
`list`, `find` or `other`, with items, date, start, end and purpose.

- `other`: no reply.
- A parse failure (LLM down): reply in the thread "I couldn't read that, please
  try again." Only when the message looks like a request (see Chatter, below).

### 3. Questions (`check`, `list`, `find`)

The bot answers in a thread under the message, as today, minus the DM.
The find cap (25) and its wording stay.

### 4. Booking requests (`book`)

The bot runs the conflict check and posts a card in a thread under the
message:

```
📅 Tech Set 2 · Sat 10/24 · 2:00–4:00 PM · Youth night
✅ Free
[ Book ]  [ Edit ]
```

| State | Card shows | Buttons |
|---|---|---|
| Complete and free | ✅ Free | Book, Edit |
| Taken | ❌ Taken 2:00–3:30 PM by @holder (Fall rally) | Edit |
| Missing fields | Missing: date | Edit |
| Several items match | "Which one?" with the candidates | Edit (item is a select) |
| Past date | That date has passed | Edit |

- The parsed request is stored in the card's button `value` (JSON, well under
  Slack's 2,000-character limit). The card is its own state. Nothing else is
  stored.
- Only the person who wrote the request can press Book or Edit. Anyone else
  gets an ephemeral "Only @requester can book this." This matches the CREA
  draft rule.

### 5. Book

- Pressing **Book** goes through the worker. The worker re-runs the conflict
  check, writes through the adapter, and replaces the card with the ✅
  confirmation (items, day, time, title, backend link, tech-set note).
- The confirmation stays in the thread. It is not broadcast (decided by the
  user): the channel sees the booking in the living digest only.
- If the slot filled since the card was posted, the card changes to the
  Taken state. Nothing is written.
- **Double clicks and SQS redelivery:** the booking claim keyed on the card's
  message `ts` makes the second press a no-op. Today `claimBooking` lives in
  `authStore` and is only present when connect is configured. It must work
  without connect too.
- If connect is configured and the member isn't connected, the existing
  connect prompt is posted ephemerally in the thread, and `resume` replaces the
  card instead of replying in the DM.
- After a booking, the living digest covering that date is rebuilt, as today.

### 6. Edit

- **Edit** opens a modal pre-filled from the button value: item (typeahead
  select over the catalog), date picker, start and end time pickers, purpose,
  and the kitchen appliance fields when a kitchen item is picked.
- The receiver opens the modal itself (`views.open` needs the `trigger_id`
  within 3 seconds). It has everything it needs in the button value and the
  bundled catalog, so it needs no LLM and no Google call.
- The typeahead is an `external_select`. The receiver answers its
  `block_suggestion` requests by filtering the bundled catalog JSON.
- Submitting the modal does not book. The worker re-runs the conflict check and
  updates the original card with the new details and state, so the member
  still presses Book. **My call:** one consistent path to a write, and the
  modal never has to report a booking result within 3 seconds.
- The modal's `private_metadata` holds the card's channel and `ts`.

## Chatter

- The parser already returns `other` for chatter.
- A new `isIgnorableChatter` helper in `src/lib/reservation-request.js` skips
  obvious non-requests before the LLM call: very short messages, emoji only,
  "thanks", "ok". (The old OneStop bot had one in `reservation-intent.js`,
  removed in `4a7ae35`; `git show 4a7ae35^:src/lib/reservation-intent.js`
  has it for reference.)
- **My call:** when the parser is unsure between `other` and a request, it
  returns `other`. A missed request is cheap (the member asks again). A bot
  reply to chatter in a public channel is not.

## What gets removed

- The DM conversation: `src/lib/dm-conversation.js`, the start marker and
  CLOSED metadata, the 2-hour stale rule, "start over", DM routing in
  `dispatch.js` and the `channel_type: "im"` branch in `shouldEnqueueEvent`.
- `/reserve` (decided by the user): `handleCommand`, its usage text, its
  dispatch route and its receiver parsing. `/reservations-disconnect` stays
  while connected Google accounts stay.
- Slack app: the `message.im` event and `im:history` scope are no longer
  needed. `message.channels` (already subscribed) delivers #reservations
  messages.

## Slack app changes

- Interactivity: add `block_suggestion` handling. The Options Load URL is the
  receiver's Function URL (same as the Request URL).
- Remove the `/reserve` slash command.

## Units

- `src/lambda/receiver.js`: enqueue top-level #reservations messages; open the
  Edit modal; answer `block_suggestion` from the catalog.
- `src/lambda/dispatch.js`: route `block_actions` and `view_submission` for the
  reservation card and modal; drop the DM branch.
- `src/lib/reservation-card.js` (new): build the card blocks for each state,
  and encode and decode the button value.
- `src/lib/reservation-modal.js` (new): build the modal from a request and read
  a request back from `view.state.values`.
- `src/events/reservations.js`: `handleMessage` (channel only), `handleCardAction`
  (Book), `handleModalSubmit`; remove the DM conversation code.

## Testing

- Receiver: top-level #reservations message is enqueued; thread reply and bot
  message are not; Edit opens a modal within the handler; `block_suggestion`
  returns matching catalog labels.
- Card: each state renders the right text and buttons; button value round
  trips; oversize value fails a test, not Slack.
- Flow: question gets a thread answer; book request gets a card and writes
  nothing; Book writes once and replaces the card; second press and SQS
  redelivery write nothing; slot filled before Book shows Taken; someone else
  pressing Book gets the ephemeral note; modal submit updates the card and
  writes nothing.
- Chatter fixtures (`thanks!`, `see you there`, conflict negotiation phrasing)
  get no reply.
