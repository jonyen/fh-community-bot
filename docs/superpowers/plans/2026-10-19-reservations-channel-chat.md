# Reservations by Chatting in #reservations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members ask and book with plain top-level messages in #reservations; questions get a thread answer, booking requests get a card with Book and Edit.

**Architecture:** The worker parses each top-level #reservations message and replies in its thread. A booking request becomes a card whose button `value` carries the request, so the card is its own state. The receiver opens the Edit modal and answers its item typeahead itself (3-second limits). Modal submits and Book presses go through SQS to the worker. `/reserve` and the DM conversation are removed.

**Tech Stack:** Node 22 ESM, Vitest, Slack Web API (Block Kit), AWS SAM.

**Spec:** `docs/superpowers/specs/2026-10-19-reservations-channel-chat-design.md`

## Global Constraints

- Reply persona: `BOT_PERSONA` (`FH Reservations`, `:calendar:`).
- Confirmations stay in the thread. No `reply_broadcast`.
- Only the requester can Book or Edit. Others get an ephemeral `Only <@U> can book this.`
- A written booking never rethrows (SQS must not retry it into a second booking).
- Connected Google accounts keep working; the connect prompt is ephemeral in the thread.
- Button `value` ≤ 2,000 chars; modal `private_metadata` ≤ 3,000 chars.

## Decisions beyond the spec

- **Double clicks:** block_actions are grouped by user in the FIFO queue, so one member's presses run one at a time. Before booking, the worker re-reads the card (`conversations.replies`) and acts only if the card still has a Book button with the pressed value. A closed or edited card makes the press a no-op. `claimBooking` (when connect is configured) still guards SQS redelivery after a crash, keyed `card:<channel>:<cardTs>`.
- **Redelivered messages:** before replying to a message, the worker reads its thread. If the bot already replied, it does nothing.
- **Kitchen appliances in the modal:** shown only when the card's request already names the Kitchen when Edit is pressed. Switching to the Kitchen inside the modal books without appliances.
- Thread replies in #reservations are dropped in the receiver, not just the worker.

## Review Focus

1. Pressing Book twice quickly → one booking; second press does nothing.
2. Pressing Book on an old card after Edit changed it → nothing (stale value).
3. Someone other than the requester presses Book or Edit → ephemeral note, no modal, no booking.
4. Modal with end before start, or no item → inline modal error, card unchanged.
5. SQS redelivery of the same channel message → no second card.

---

### Task 1: Card and modal builders

**Files:**
- Create: `src/lib/reservation-card.js`, `src/lib/reservation-modal.js`
- Test: `tests/lib/reservation-card.test.js`, `tests/lib/reservation-modal.test.js`

**Interfaces (Produces):**
- `reservation-card.js`: `BOOK_ACTION = "reservation_book"`, `EDIT_ACTION = "reservation_edit"`, `CARD_EVENT_TYPE = "reservation_card"`;
  `encodeCard({ user, req }) -> string` (compact JSON: `u, i` (labels), `d, s, e, t, m, a`; title cut to 150 chars);
  `decodeCard(value, catalog) -> { user, req } | null` (`req` shaped like `normalizeRequest` output: `intent: "book"`, items resolved with `findItem`, `ambiguous: []`, `unmatched: []`);
  `cardMessage({ user, req, assessment }) -> { text, blocks, metadata }` where `assessment = { state: "free"|"taken"|"missing"|"ambiguous"|"past"|"mixed", conflicts, missing, ambiguous }`; Book button only for `free`.
  `closedMessage(text) -> { text, blocks, metadata: CLOSED_METADATA }`.
  `openBookValue(message) -> string | null`: the Book button value on a posted card, or null.
- `reservation-modal.js`: `MODAL_CALLBACK = "reservation_edit_modal"`, `ITEM_ACTION = "reservation_items"`;
  `buildEditModal({ user, req, channel, threadTs, cardTs }) -> view` (multi_external_select items, datepicker, two timepickers, title input, appliance inputs when Kitchen is among items);
  `readEditModal(view, catalog) -> { user, channel, threadTs, cardTs, req }`;
  `modalErrors(view) -> { [block_id]: message } | null` (no item; end not after start);
  `itemOptions(catalog, query) -> option[]` (case-insensitive substring, ≤ 100).

- [ ] Write tests: card text per state (free shows `✅ Free` and Book+Edit; taken lists holders and only Edit; missing says `Missing: date`), encode/decode round trip, oversized title trimmed, value < 2,000 for a 6-item kitchen request, `openBookValue` on closed card is null; modal round trip, errors for end ≤ start and no items, appliances only for Kitchen, `itemOptions` filters and caps.
- [ ] Run, see FAIL. Implement. Run, see PASS. Commit.

### Task 2: Reservations handler — channel messages, cards, Book, modal submit

**Files:**
- Modify: `src/events/reservations.js`, `src/lib/reservation-format.js` (drop `REQUEST/ASK/NOTE_EVENT_TYPE`)
- Delete: `src/lib/dm-conversation.js`, `tests/lib/dm-conversation.test.js`
- Test: rewrite `tests/events/reservations.test.js`, `tests/events/reservations-connect.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces: `createReservationsHandler(...)` returns `{ channelId, handleMessage, handleCardAction, handleModalSubmit, resume, disconnect }`.
  - `handleMessage({ event, client })`: top-level human messages in `channelId` only.
  - `handleCardAction({ payload, client })`: block_actions; ignores other action ids.
  - `handleModalSubmit({ payload, client })`: view_submission with `MODAL_CALLBACK`.
  - Pending connect rows store `request: { req, requester, backend, cardTs }`.

- [ ] Tests: question answered in thread; chatter (`other`) silent; parse failure → "Sorry, I couldn't read that. Please try again." in thread; book → card posted in thread, nothing written; redelivered message (bot already in thread) → nothing; Book by requester writes once, replaces card with ✅ text and CLOSED metadata, refreshes digest; Book on stale card → nothing; Book by someone else → ephemeral; slot taken at Book → card shows taken, nothing written; claim refused → "I may already have booked this…"; modal submit updates card, writes nothing; connect: not connected → ephemeral prompt in thread, pending carries cardTs; resume updates the card.
- [ ] Run, see FAIL. Implement. Run, see PASS. Commit.

### Task 3: Routing — receiver and dispatch

**Files:**
- Modify: `src/lambda/receiver.js`, `src/lambda/dispatch.js`, `src/config.js` (export `loadReservations`), `template.yaml` (ReceiverFn env)
- Create: `src/lambda/reservation-interactions.js`
- Test: `tests/lambda/receiver.test.js`, `tests/lambda/dispatch.test.js`, `tests/lambda/reservation-interactions.test.js`

**Interfaces:**
- `handleReservationInteraction(payload, { catalog, openView }) -> { handled: boolean, response?: object }`:
  - block_suggestion for `ITEM_ACTION` → `{ handled, response: { options } }`.
  - block_actions with `EDIT_ACTION` by the requester → `openView({ trigger_id, view })`, `{ handled: true }`; otherwise `{ handled: false }` (enqueue).
  - view_submission for `MODAL_CALLBACK` with errors → `{ handled: true, response: { response_action: "errors", errors } }`; valid → `{ handled: false }` (enqueue).
- Receiver: enqueues top-level human messages in `RESERVATIONS_CHANNEL_ID`, drops thread replies there, drops DMs; enqueues `view_submission` as `{ type: "view_submission", payload }`; no more slash parsing for `/reserve` (slash envelope kept for other commands).
- Dispatch: `block_actions` also → `reservationsHandler.handleCardAction`; `view_submission` → `handleModalSubmit`; `/reserve` route and DM branch removed.
- ReceiverFn env: `SLACK_BOT_TOKEN`, `RESERVATIONS_CHANNEL_ID`, `ROOM_REQUESTS_SHEET_ID`, `KITCHEN_SHEET_ID`.

- [ ] Tests as listed. Run, FAIL, implement, PASS, commit.

### Task 4: Docs

- README #reservations section, feature line; RUNBOOK DM section replaced with channel/interactivity notes; Slack app changes (remove `/reserve`, `message.im`, `im:history`; set Options Load URL).
- [ ] Commit.
