# Cancel and "my reservations" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members can cancel a card before booking, cancel a booking after it is made, and ask "what do I have booked?" to get a private list of their upcoming bookings, each cancellable.

**Architecture:** Every reservation an adapter lists, and every booking it makes, carries a `ref`: a small plain object that says where the booking lives and what it looked like. Each adapter gets `cancel(ref, { clients })`, which re-reads the target, checks it still matches `ref`, and undoes it. A pure module decides whether a listed reservation belongs to a member (exact ids, email, phone, best-guess name). The handler wires refs into card buttons, the "mine" reply and the connect/resume path. A small per-member ledger in the existing DynamoDB table remembers bot-made bookings so a renamed member still sees them.

**Tech Stack:** Node 22 ESM, Vitest, Slack Web API (Block Kit, `confirm` objects, `response_url`), Google Sheets v4, Google Calendar v3, DynamoDB DocumentClient.

**Spec:** `docs/superpowers/specs/2026-10-20-reservations-cancel-and-mine-design.md`

## Global Constraints

- Only the person who booked can cancel. Anyone else gets an ephemeral `Only <@U> can cancel this.` (same shape as the existing "Only <@U> can book this.").
- Before-booking Cancel closes the card with `🚫 Cancelled by <@U>.` No confirm dialog. Nothing is written.
- After-booking cancel: button text `Cancel booking`, with a Slack `confirm` object naming items, day and time.
- Card after a booking is cancelled: the original ✅ summary line, then `🚫 Booking cancelled by <@U>.`
- RMS: delete the event when it has no human attendees besides the organizer; otherwise patch it to remove only the booking's resource attendees. `sendUpdates: "all"` on both. A recurring event's instance id cancels only that occurrence.
- Rooms: write `Canceled` in Status (column H). Never delete or clear a rooms row. `canceled` and `cancelled` are inactive like `denied`/`declined`.
- Kitchen: clear B–P of the row (name, phone, times, appliances); the dated row stays.
- "Still matches": rooms compare title, date, start, end, name (F) and rooms set; kitchen compares name, date, start, end; RMS compares event status not cancelled, and date and start. Status, notes and appliances are never compared.
- If it doesn't match or is gone: delete nothing, answer `I couldn't find that booking as it was; it may have been changed. Please check it here: <link>`.
- A booking whose end has passed: ephemeral `That booking has already ended.`
- Account rules: same as Book. With connect configured, sheet cancels and member-organized RMS events use the member's Google clients, and an unconnected or revoked member gets the connect prompt, the cancel resuming after they connect. An RMS event organized by the bot's own account is cancelled with the bot's client. Without connect, the bot's clients do everything.
- "Mine": intent `mine`, reply is ephemeral in #reservations, today through `addDaysIso(today, 60)`, sorted by date then start, at most 20 lines then `…and N more. Rooms: <link> · Kitchen: <link> · Calendar: <link>`. Empty: `I don't see any upcoming bookings under your name.` plus the same three links.
- Name matching (best guess): normalise = lowercase, strip accents, drop parenthesised text, drop punctuation, collapse spaces. Match on: equal; sheet name contains the full real name as whole words; first+last equal ignoring middle names or reversed order; sheet "First L" against real name first name + last initial. First name alone never matches. Kitchen also matches when the last 10 digits of the phone cell equal the last 10 of the Slack profile phone.
- Copy style: emoji lead, ` · ` separators, plain sentences.
- Button value ≤ 2,000 chars; ephemeral ≤ 50 blocks.

## Review Focus

1. **Two identical rooms rows** (same title, date, times, name, rooms, e.g. a duplicate paste): one cancel marks exactly one row, and a second cancel marks the other. — Task 2.
2. **A member with an empty Slack real name and display name** asking "mine": no name rule matches anything (empty never equals empty), no crash. — Task 1.
3. **SQS redelivers a cancel that already succeeded**: the second run finds the booking already cancelled and the card says so; nothing else is touched. — Tasks 2–4 (`already`), Task 6.
4. **One backend fails while listing "mine"** (a resource calendar 403s, or the kitchen sheet errors): the reply still lists what was found and adds `Some bookings couldn't be checked.` — Task 7.
5. **Name with accents and a group in parentheses** ("José Núñez (Youth)") against Slack real name "Jose Nunez". — Task 1.

---

### Task 1: Ownership matching and booking refs

**Files:**
- Create: `src/lib/reservation-owner.js`
- Test: `tests/lib/reservation-owner.test.js`

**Interfaces:**
- Produces:
  - `normalizeName(s: string): string`
  - `namesMatch(sheetName: string, member: Member): boolean`
  - `isMine(reservation, member: Member, ledgerKeys: Set<string>): boolean` — true when `refKey(reservation.ref)` is in `ledgerKeys`, or `reservation.holderUserId === member.userId`, or `reservation.holderEmail` equals `member.email` (case-insensitive), or (kitchen) phones match, or (rooms/kitchen) `namesMatch(reservation.holderName, member)`.
  - `refKey(ref): string` — stable identity: rms `rms:<eventId>`; rooms `rooms:<date>:<start>:<end>:<normalized title>:<normalized holder>`; kitchen `kitchen:<row>:<date>:<normalized name>` (the name keeps a reused row from matching the old booker).
  - `Member = { userId, realName, displayName, email, phone }`

- [ ] **Step 1: Write the failing tests**

```js
const M = { userId: "U1", realName: "Jon Yen", displayName: "jy", email: "jon@x.org", phone: "+1 (571) 555-0101" };
it("normalizes accents, parentheses and punctuation", () => {
  expect(normalizeName("  José  Núñez (Youth) ")).toBe("jose nunez");
});
it.each([
  ["Jon Yen", true], ["jon yen - youth", true], ["Yen Jon", true], ["Jon A. Yen", true], ["Jon Y", true], ["JY", true],
  ["Jon", false], ["Jonathan Yen", false], ["", false],
])("namesMatch(%s)", (sheet, want) => expect(namesMatch(sheet, M)).toBe(want));
it("matches accented sheet names to plain Slack names", () => {
  expect(namesMatch("José Núñez (Youth)", { ...M, realName: "Jose Nunez", displayName: "" })).toBe(true);
});
it("never matches when the member has no names", () => {
  expect(namesMatch("", { ...M, realName: "", displayName: "" })).toBe(false);
  expect(namesMatch("Jon", { ...M, realName: "", displayName: "" })).toBe(false);
});
it("isMine by slack id, email, kitchen phone and ledger", () => {
  expect(isMine({ holderUserId: "U1", ref: { backend: "rms", eventId: "e" } }, M, new Set())).toBe(true);
  expect(isMine({ holderEmail: "JON@x.org", ref: { backend: "rms", eventId: "e" } }, M, new Set())).toBe(true);
  expect(isMine({ category: "kitchen", holderName: "Someone", phone: "571-555-0101", ref: { backend: "kitchen", row: 9, date: "2026-10-24" } }, M, new Set())).toBe(true);
  const ref = { backend: "rooms", date: "2026-10-24", start: 600, end: 660, title: "Rally", holder: "jy2" };
  expect(isMine({ holderName: "jy2", ref }, M, new Set([refKey(ref)]))).toBe(true);
  expect(isMine({ holderName: "Pat Doe", ref }, M, new Set())).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/reservation-owner.test.js` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** in `src/lib/reservation-owner.js`. Strip accents with `normalize("NFD").replace(/\p{M}/gu, "")`. A one-token display name (like "jy") matches only on equality. "First L" means the sheet has exactly two tokens, the second is one letter.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reservations): match bookings to members`.

### Task 2: Rooms adapter — refs and cancel by marking

**Files:**
- Modify: `src/services/reservations/rooms.js`
- Test: `tests/services/reservations/rooms.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - Each listed reservation gains `holderName` (column F raw) and `ref = { backend: "rooms", date, start, end, title, holder, rooms: [...] }`.
  - `book()` returns `{ status: "booked", link, ref }` with the same `ref` shape built from what it wrote.
  - `cancel(ref, { clients } = {}) → { status: "cancelled" | "already" | "changed", link }`.

- [ ] **Step 1: Write the failing tests**

```js
it("treats Canceled rows as free", async () => {
  // a row with Status "Canceled" on 10/24 MPR 1–2 PM is not a conflict and not listed
});
it("cancel writes Canceled into H of the matching row only", async () => {
  // rows: [header..., matching row at sheet row 4]; expect values.update called with
  // { spreadsheetId: "S1", range: "'Upcoming Room Requests'!H4", valueInputOption: "RAW", requestBody: { values: [["Canceled"]] } }
  // and result { status: "cancelled", link: "https://rooms" }
});
it("cancel ignores Status and notes when matching", async () => { /* matching row with Status Approved → cancelled */ });
it("cancel of a row already Canceled returns already and writes nothing", async () => {});
it("cancel returns changed when the title or time was edited, and writes nothing", async () => {});
it("two identical rows: first cancel marks one, second cancel marks the other", async () => {}); // Review Focus 1
it("uses the member's sheets client when given", async () => {});
```

- [ ] **Step 2: Run** `npx vitest run tests/services/reservations/rooms.test.js` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Keep a raw-row reader that includes the 1-based sheet row (`index + 2`) and status, used by both the existing filtered reader and `cancel`. Add `canceled`/`cancelled` to `INACTIVE`. Matching compares normalized title (`trim`), date, start, end, holder (`trim`) and the rooms set (order-insensitive). Prefer an active matching row; if only canceled ones match, return `already`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reservations): cancel rooms bookings by marking them Canceled`.

### Task 3: Kitchen adapter — refs and cancel by clearing

**Files:**
- Modify: `src/services/reservations/kitchen.js`
- Test: `tests/services/reservations/kitchen.test.js`

**Interfaces:**
- Produces:
  - Listed reservations gain `holderName` (B raw), `phone` (C raw) and `ref = { backend: "kitchen", row, date, name, start, end }`.
  - `book()` returns `{ status: "booked", link, ref }` for the row it filled.
  - `cancel(ref, { clients } = {}) → { status: "cancelled" | "already" | "changed", link }`.

- [ ] **Step 1: Write the failing tests**

```js
it("cancel clears B:P of the row", async () => {
  // expect values.clear({ spreadsheetId: "K1", range: "'Kitchen'!B7:P7" }) and { status: "cancelled" }
});
it("cancel returns already when the row's name is empty", async () => {});
it("cancel returns changed when the name or times differ, and clears nothing", async () => {});
it("cancel ignores appliance columns when matching", async () => {});
```

- [ ] **Step 2: Run** `npx vitest run tests/services/reservations/kitchen.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** with `spreadsheets.values.clear`, writer = `clients?.sheetsClient || sheetsClient`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reservations): cancel kitchen bookings by clearing the row`.

### Task 4: RMS adapter — refs and cancel by delete or release

**Files:**
- Modify: `src/services/reservations/rms.js`
- Test: `tests/services/reservations/rms.test.js`

**Interfaces:**
- Produces:
  - Listed reservations gain `ref = { backend: "rms", eventId, organizerEmail, organizerSelf, resources: [calendarId], date, start, end, title }`. `organizerSelf` is `!!e.organizer?.self` as seen by the bot's client.
  - `book()` returns `{ status: "booked", link, ref }`; `organizerSelf` is `!clients`, `organizerEmail` null.
  - `cancel(ref, { clients } = {}) → { status: "cancelled" | "already" | "changed", link }`.
  - Which client: `ref.organizerSelf ? calendarClient on botCalendarId : clients.calendarClient on "primary"`. If not `organizerSelf` and no `clients`, throw `new Error("member clients required")` (the handler never lets this happen; Task 6 routes it to the connect prompt).

- [ ] **Step 1: Write the failing tests**

```js
it("cancel deletes a bot event with only resource attendees", async () => {
  // events.get → { status: "confirmed", start: { dateTime: nyLocal(...) }, attendees: [{ email: "t2", resource: true }] }
  // expect events.delete({ calendarId: "primary", eventId: "E1", sendUpdates: "all" })
});
it("cancel removes only the booked resources when people are invited", async () => {
  // attendees: [{ email: "t2", resource: true }, { email: "pat@x.org" }]
  // expect events.patch({ calendarId: "primary", eventId: "E1", sendUpdates: "all", requestBody: { attendees: [{ email: "pat@x.org" }] } })
});
it("cancel returns already for a cancelled or 404/410 event", async () => {});
it("cancel returns changed when the event moved to another day or time", async () => {});
it("cancel of a member-organized event uses the member's client on primary", async () => {});
it("merges nothing itself: the same event listed from two resources keeps the same eventId", async () => {});
```

- [ ] **Step 2: Run** `npx vitest run tests/services/reservations/rms.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** "Human attendee" = not `resource` and not `self`/organizer email. Treat a 404 or 410 from `events.get` as `already`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reservations): cancel calendar bookings`.

### Task 5: Booking ledger

**Files:**
- Modify: `src/services/authStore.js`
- Test: `tests/services/authStore.test.js`

**Interfaces:**
- Produces on the auth store:
  - `recordBooking(slackUserId, ref, { today }) → void` — Get then Put `pk: "bookings#<U>"`, attribute `refs` (list), dropping refs with `date < today`, capped at the newest 50; `expiresAt` = one day after the latest ref's date (epoch seconds, NY midnight is fine).
  - `bookingsFor(slackUserId, { today }) → ref[]` — refs with `date >= today`; `[]` when none.

- [ ] **Step 1: Write the failing tests** — record two refs, read both; a ref dated before `today` is dropped on read and on the next write; 51 records keep 50; unknown user → `[]`.
- [ ] **Step 2: Run** `npx vitest run tests/services/authStore.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** with `GetCommand`/`PutCommand` (the fake DDB in the test supports both).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reservations): remember bookings the bot makes`.

### Task 6: Card Cancel and Cancel booking

**Files:**
- Modify: `src/lib/reservation-card.js`, `src/events/reservations.js`, `src/lambda/clients.js` (pass `ledger`)
- Test: `tests/lib/reservation-card.test.js`, `tests/events/reservations.test.js`, `tests/events/reservations-connect.test.js`

**Interfaces:**
- Consumes: `cancel`, `ref` from Tasks 2–4; `refKey` from Task 1; `recordBooking` from Task 5.
- Produces in `reservation-card.js`:
  - `CANCEL_ACTION = "reservation_cancel"` (open card, value = the card value, same as Book/Edit).
  - `CANCEL_BOOKING_ACTION = "reservation_cancel_booking"`, value `encodeRef({ user, ref })` → JSON `{ u, r }`; `decodeRef(value) → { user, ref } | null`.
  - `bookedMessage({ user, text, ref, req }) → { text, blocks, metadata: CLOSED_METADATA }`: section with `text`, actions with one `Cancel booking` button (style `danger`) and `confirm: { title: "Cancel this booking?", text: "<items> · <day> · <time> will be released.", confirm: "Cancel booking", deny: "Keep it" }`.
  - `cardMessage` adds a `Cancel` button (no style) after Edit on every open card.
- Produces in the handler:
  - `createReservationsHandler({ ..., ledger = null })` where `ledger = { recordBooking, bookingsFor }`; `clients.js` passes `connect?.authStore ?? null`.
  - `finishBooking` uses `bookedMessage` for the ✅ outcome when `result.ref` is present, and calls `ledger?.recordBooking` (errors logged, never rethrown).
  - `cancelBooking({ ref, user, say, client }) → Promise` shared with Task 7: decides the account per Global Constraints, calls `adapter.cancel`, maps `cancelled` → `say.done(cancelledText)` and `livingDigest?.refresh(ref.date)`, `already` → `That booking was already cancelled.`, `changed` → the "couldn't find" copy, a 403 → `forbiddenText`, invalid grant → mark revoked and connect prompt.
  - Connect prompt for a cancel: `createPending` with `request: { kind: "cancel", ref, requester, cardTs, responseUrl }`, text `To cancel as you, connect your Google account once. I'll cancel this booking as soon as you approve.`; `resume` branches on `pending.request.kind === "cancel"` and calls `cancelBooking`.

- [ ] **Step 1: Write the failing tests**

```js
// reservation-card.test.js
it("every open card has Cancel after Edit", () => {
  for (const state of ["free", "taken", "missing", "past", "mixed"]) {
    expect(actionsOf(cardMessage({ user: "U9", req: REQ, assessment: { state, conflicts: [], missing: ["date"] } })).at(-1))
      .toMatchObject({ action_id: CANCEL_ACTION, text: { text: "Cancel" } });
  }
});
it("bookedMessage has one confirmed Cancel booking button whose value round-trips", () => {});

// reservations.test.js
it("Cancel on an open card closes it with 🚫 Cancelled by <@U9>.", async () => {});
it("Cancel by someone else is answered privately", async () => {}); // "Only <@U9> can cancel this."
it("Cancel on an already closed card does nothing", async () => {});
it("a booking ends with a Cancel booking button and records the ref in the ledger", async () => {});
it("Cancel booking cancels, keeps the summary, adds 🚫 Booking cancelled by <@U9>. and refreshes the digest", async () => {});
it("Cancel booking after the end time answers That booking has already ended. privately", async () => {});
it("a redelivered Cancel booking says That booking was already cancelled.", async () => {}); // Review Focus 3
it("changed booking: nothing cancelled, link given", async () => {});

// reservations-connect.test.js
it("an unconnected member's cancel prompts Connect Google and resumes into cancel", async () => {});
it("a bot-organized RMS event is cancelled with the bot client even when connect is on", async () => {});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/reservation-card.test.js tests/events` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `handleCardAction` accepts the two new action ids. For `CANCEL_ACTION`, check the requester, then `readCard` + `isOpenCard`, then close. For `CANCEL_BOOKING_ACTION`, check the requester and end time (`ref.date`/`ref.end` against `now()` in NY), then read the card and require the Cancel booking button value to still equal the pressed value (stale-press guard), then `cancelBooking` with a `cardSay` whose `done` updates the card to `closedMessage(`${originalSummaryLine}\n🚫 Booking cancelled by <@U>.`)` for success and to the other messages otherwise, keeping the button only when the outcome is a transient failure.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(reservations): Cancel and Cancel booking on cards`.

### Task 7: "My reservations"

**Files:**
- Create: `src/lib/reservation-mine.js` (message builder)
- Modify: `src/services/llm.js` (prompt), `src/lib/reservation-request.js` (`INTENTS`), `src/events/reservations.js`, `README.md`, `docs/RUNBOOK.md`
- Test: `tests/lib/reservation-mine.test.js`, `tests/events/reservations.test.js`, `tests/lib/reservation-request.test.js`

**Interfaces:**
- Consumes: `isMine`, `refKey` (Task 1); `ref` on listed reservations (Tasks 2–4); `bookingsFor` (Task 5); `cancelBooking`, `CANCEL_BOOKING_ACTION`, `encodeRef` (Task 6).
- Produces:
  - `INTENTS` includes `"mine"`; the prompt line: `"mine" (asks what they themselves have booked, e.g. "what do I have booked?", "my reservations")`.
  - `mineMessage({ user, entries, more, links, partial, notice }) → { text, blocks }`: optional `notice` section first (e.g. the 🚫 line after a cancel), one section per entry with a `Cancel` accessory button (`action_id: MINE_CANCEL_ACTION = "reservation_mine_cancel"`, value `encodeRef({ user, ref })`, `confirm` naming the booking; for a name-matched sheet row the confirm text quotes the row as typed: `"<title>" · <name> · <day> · <time> in the <rooms|kitchen> sheet`). Entries that can't be cancelled (RMS not organized by the bot and member not connected, when connect is configured) get an `Open in Calendar` link instead. `partial` adds `Some bookings couldn't be checked.`
  - Name-matched sheet entries end with ` · from the <rooms|kitchen> sheet, matched by name`.
- Handler:
  - `handleMessage`: `req.intent === "mine"` → `listMine` (posts with `chat.postEphemeral({ channel, user })`, no thread).
  - `listMine({ user, client }) → { entries, more, partial }`: Member from `users.info` (`real_name`, `profile.display_name`, `profile.email`, `profile.phone`); every adapter's `listReservations({ from: today, to: addDaysIso(today, 60) })`; keep `isMine`; drop ended; merge RMS entries with the same `ref.eventId` (union `ref.resources`, items joined); sort; cap 20.
  - `MINE_CANCEL_ACTION` press: requester check, end-time check, `cancelBooking` with a `say` whose `done` POSTs to `payload.response_url` `{ replace_original: true, ...mineMessage({ ..., notice: outcomeText }) }` built from a fresh `listMine`.

- [ ] **Step 1: Write the failing tests**

```js
it("mine lists only the asker's bookings for the next 60 days, sorted, privately", async () => {
  // adapters return mixed holders; expect chat.postEphemeral({ channel: "CRES", user: "U9", ... }) with 3 entries
  // and listReservations called with { from: "2026-10-20", to: "2026-12-19" }
});
it("mine merges one calendar event booked on two resources into one line", async () => {});
it("mine caps at 20 lines and adds …and N more with links", async () => {});
it("mine with nothing found gives the empty copy and links", async () => {});
it("mine still answers when one backend fails, with Some bookings couldn't be checked.", async () => {}); // Review Focus 4
it("a name-matched sheet row says matched by name and its confirm quotes the row", async () => {});
it("cancel from the list replaces the list via response_url with the 🚫 notice on top", async () => {});
it("normalizeRequest keeps intent mine", () => {});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/reservation-mine.test.js tests/events tests/lib/reservation-request.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**, then update `README.md` (#reservations section: Cancel, Cancel booking, "what do I have booked?") and `docs/RUNBOOK.md` (a cancel says "couldn't find": someone edited the row or event; Canceled rows stay in the rooms sheet by design).
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(reservations): "what do I have booked?" with cancel`.
