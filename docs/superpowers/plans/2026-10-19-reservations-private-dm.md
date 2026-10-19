# Private Reservations in DM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/reserve` conversations move to the member's DM with the bot, a new "find" intent searches the catalog by meaning, and #reservations shows two living digests (Mon–Thu, Fri–Sun) edited in place instead of per-booking posts.

**Architecture:** The DM is one running conversation. A pure helper picks the open request out of DM history (newest start marker, not closed, not stale), and the existing stateless parse-the-whole-transcript flow runs on it. Digest posts carry Slack message metadata with their date range; after a booking the bot finds the covering post, rebuilds it from the backends and `chat.update`s it.

**Tech Stack:** Node 22 ESM, `@slack/web-api`, vitest, AWS SAM (Lambda + SQS + EventBridge Scheduler), Claude Haiku on Bedrock.

**Spec:** `docs/superpowers/specs/2026-10-19-reservations-private-dm-design.md`

## Global Constraints

- One command, `/reserve`. No `/reserve-list`, no @-mention entry point.
- Nothing but the two living digests is ever posted to #reservations by the reservations flow.
- Weekday digest: Mon–Thu, posted Monday 08:00 America/New_York. Weekend digest: Fri–Sun, posted Friday 08:00 America/New_York.
- Digest metadata: `event_type: "reservation_digest"`, `event_payload: { from, to }` (ISO dates).
- Request stale after 2 hours (`STALE_MS = 2 * 60 * 60 * 1000`).
- Escape words: whole message `start over` or `cancel`, any case, surrounding whitespace ignored.
- Find answers cap at 25 items, then `+N more`.
- Living digest is always one message, ≤ 3500 chars.
- A booking that is written must never be retried: any failure after `adapter.book` returns is logged, never rethrown.
- DM posts use `chat.postMessage({ channel: <userId> })` — no `im:write`, no `conversations.open`.
- Follow the repo's style: header comment per file explaining why, `BOT_PERSONA` on every reservations post, `log`/`metric` from `src/lib/logger.js`.

## Review Focus

1. Member answers "I still need: date" with a plain DM message "Saturday" → it continues the open request (Task 3 test `continues the open request`).
2. Member sends a new `/reserve` while an older request is still open → the new one stands alone, not merged with the old transcript (Task 3 test `a newer start marker wins`).
3. Booking succeeds but the digest update throws → DM confirmation still sent, handler resolves (Task 5 test `digest refresh failure never fails the booking`).
4. Booking for a date whose digest isn't posted yet (next month) → no channel post, no edit, no error (Task 2 test `refresh with no covering digest does nothing`).
5. "thanks" in the DM with nothing open → no start marker, no reply (Task 5 test `chatter with nothing open is ignored`).

---

### Task 1: Digest periods and single-message digest text

**Files:**
- Modify: `src/lib/reservation-time.js` (add after `weekOf`)
- Modify: `src/lib/reservation-format.js` (replace `buildDigest`)
- Test: `tests/lib/reservation-time.test.js`, `tests/lib/reservation-format.test.js`

**Interfaces:**
- Produces: `digestPeriod(kind: "weekday"|"weekend", now: Date) -> { kind, from, to }` — the period of the current week (`weekday` = this week's Mon–Thu, `weekend` = this week's Fri–Sun, weeks start Monday as in `weekOf`).
- Produces: `periodCovering(iso: string) -> { kind, from, to }` — the period a date falls in.
- Produces: `DIGEST_EVENT_TYPE = "reservation_digest"` in `reservation-format.js`.
- Produces: `buildLivingDigest({ kind, from, to, reservations, maxChars = 3500 }) -> string` — replaces `buildDigest`.

- [ ] **Step 1: Write failing tests**

```js
it("digestPeriod gives Mon–Thu and Fri–Sun of the current week", () => {
  const mon = new Date("2026-10-19T12:00:00Z");
  expect(digestPeriod("weekday", mon)).toEqual({ kind: "weekday", from: "2026-10-19", to: "2026-10-22" });
  expect(digestPeriod("weekend", new Date("2026-10-23T12:00:00Z"))).toEqual({ kind: "weekend", from: "2026-10-23", to: "2026-10-25" });
});
it("periodCovering puts Friday in the weekend and Thursday in the weekday", () => {
  expect(periodCovering("2026-10-22")).toEqual({ kind: "weekday", from: "2026-10-19", to: "2026-10-22" });
  expect(periodCovering("2026-10-23")).toEqual({ kind: "weekend", from: "2026-10-23", to: "2026-10-25" });
  expect(periodCovering("2026-10-25")).toEqual({ kind: "weekend", from: "2026-10-23", to: "2026-10-25" });
});
```

```js
describe("buildLivingDigest", () => {
  it("headers the period and lists by day and category", () => {
    const text = buildLivingDigest({ kind: "weekend", from: "2026-10-23", to: "2026-10-25", reservations: [
      { category: "tech", item: "Tech Set 2", date: "2026-10-24", start: 840, end: 960, title: "Youth night", holder: "Deandra" },
    ] });
    expect(text).toMatch(/^\*This weekend: Fri 10\/23 – Sun 10\/25\*/);
    expect(text).toContain("*Sat 10/24*\n_Tech_\n• 2:00–4:00 PM · Tech Set 2 · Youth night (Deandra)");
  });
  it("says so when nothing is booked", () => {
    expect(buildLivingDigest({ kind: "weekday", from: "2026-10-19", to: "2026-10-22", reservations: [] }))
      .toBe("*This week: Mon 10/19 – Thu 10/22*\n\nNothing booked yet.");
  });
  it("stays one message by trimming each day with +N more", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ category: "rooms", item: `Room ${i}`, date: "2026-10-20", start: 600, end: 660, title: "x".repeat(20), holder: "h" }));
    const text = buildLivingDigest({ kind: "weekday", from: "2026-10-19", to: "2026-10-22", reservations: many });
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toMatch(/\+\d+ more/);
  });
});
```

Delete the old `buildDigest` tests.

- [ ] **Step 2: Run** `npx vitest run tests/lib` — expect FAIL (not exported).
- [ ] **Step 3: Implement** `digestPeriod`, `periodCovering`, `DIGEST_EVENT_TYPE`, `buildLivingDigest`; remove `buildDigest`. Headers: weekday `*This week: <from> – <to>*`, weekend `*This weekend: <from> – <to>*` (dates via `fmtDay`). Trimming: when over `maxChars`, cut every day to the same N lines (largest N that fits), appending `…+K more` per trimmed day.
- [ ] **Step 4: Run** `npx vitest run tests/lib` — expect PASS.
- [ ] **Step 5: Commit** `feat(reservations): weekday/weekend digest periods and one-message digest text`

---

### Task 2: Living digest service, digest Lambda and schedules

**Files:**
- Create: `src/services/livingDigest.js`
- Modify: `src/lambda/digest.js`, `template.yaml:142-168`, `src/lambda/clients.js` (wire `livingDigest` into the cached deps)
- Test: `tests/services/livingDigest.test.js`, `tests/lambda/digest.test.js`

**Interfaces:**
- Consumes: `digestPeriod`, `periodCovering`, `buildLivingDigest`, `DIGEST_EVENT_TYPE` (Task 1).
- Produces: `createLivingDigest({ client, adapters, channelId, escalationUserId }) -> { post(kind, now?): Promise<{ failures }>, refresh(dateIso): Promise<boolean> }`. `refresh` returns `false` when no covering digest is found.
- Produces: `getDeps().livingDigest` (or `null` when reservations are off).

- [ ] **Step 1: Write failing tests** in `tests/services/livingDigest.test.js`:
  - `post("weekday")` calls `chat.postMessage` once with `channel: channelId`, `metadata: { event_type: "reservation_digest", event_payload: { from: "2026-10-19", to: "2026-10-22" } }` and `...BOT_PERSONA`; `listReservations` called with `{ from: "2026-10-19", to: "2026-10-22" }`.
  - A source that throws is named in the text (`⚠️ Couldn't read: Rooms`) and DMed to `escalationUserId` (existing behavior kept).
  - `refresh("2026-10-24")`: `conversations.history` returns a weekday digest (10/19–10/22) and a weekend digest (10/23–10/25) in `messages[].metadata`; asserts `chat.update` called once with `ts` of the weekend one and rebuilt text; returns `true`.
  - `refresh with no covering digest does nothing`: history has only older digests → no `chat.update`, no `chat.postMessage`, returns `false`.
  - `refresh` calls `conversations.history({ channel: channelId, limit: 100, include_all_metadata: true })`.
- [ ] **Step 2: Run** `npx vitest run tests/services/livingDigest.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `src/services/livingDigest.js`. Move the source-reading and escalation code out of `runDigest` into a shared `read(from, to)`. `refresh` uses `periodCovering(date)` and matches on `event_payload.from === period.from`.
- [ ] **Step 4: Update** `src/lambda/digest.js`: `handler(event)` reads `event?.period` (`"weekday"` | `"weekend"`, default `"weekday"`) and calls `livingDigest.post(period)`. Update `tests/lambda/digest.test.js` to cover both periods.
- [ ] **Step 5: Update** `template.yaml`: replace the `Weekly` event with two `ScheduleV2` events — `Weekday`: `cron(0 8 ? * MON *)`, `Input: '{"period":"weekday"}'`; `Weekend`: `cron(0 8 ? * FRI *)`, `Input: '{"period":"weekend"}'`; both `ScheduleExpressionTimezone: America/New_York`. Update the DigestFn description/comment and the alarm description ("weekly" → "reservations digest").
- [ ] **Step 6: Run** `npx vitest run` and `sam validate --lint` (if `sam` is installed) — expect PASS.
- [ ] **Step 7: Commit** `feat(reservations): living weekday and weekend digests`

---

### Task 3: DM conversation helper

**Files:**
- Create: `src/lib/dm-conversation.js`
- Test: `tests/lib/dm-conversation.test.js`

**Interfaces:**
- Consumes: `REQUEST_EVENT_TYPE`, `CLOSED_METADATA` from `reservation-format.js`.
- Produces: `STALE_MS = 7200000`.
- Produces: `openRequest(messages, { currentTs, nowMs }) -> Message[] | null`. `messages` is Slack `conversations.history` order (newest first) and may include the current message. Returns the open request's messages oldest-first, from the start marker up to and including `currentTs`, or `null` when nothing is open.
- Produces: `isEscape(text) -> boolean`.

Rules, newest first, skipping the current message: the first bot message with `CLOSED_METADATA.event_type` before any start marker → `null`. The first start marker (`metadata.event_type === REQUEST_EVENT_TYPE`) → open, unless the newest message older than `currentTs` is more than `STALE_MS` before `nowMs` → `null`. No marker at all → `null`.

- [ ] **Step 1: Write failing tests:** `continues the open request` (marker, bot "I still need: date", member "Saturday" current → returns those 3 oldest-first); `closed request is not open`; `a newer start marker wins` (old marker + old member text, then new marker → returns only from the new marker); `stale request is not open` (last message 2 h 1 min before now → null; 1 h 59 min → open); `no marker is not open`; `isEscape` true for `" Start Over "`, `"CANCEL"`, false for `"cancel the MPR booking"`.
- [ ] **Step 2: Run** `npx vitest run tests/lib/dm-conversation.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** Slack `ts` is seconds as a string: `Number(ts) * 1000` for ms.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(reservations): find the open request in a DM`

---

### Task 4: Route DMs to the reservations handler

**Files:**
- Modify: `src/lambda/receiver.js:40-53`, `src/lambda/dispatch.js` (before the `#reservations` block)
- Test: `tests/lambda/receiver.test.js`, `tests/lambda/dispatch.test.js`

**Interfaces:**
- Produces: DM `message` events (`channel_type: "im"`) reach `reservationsHandler.handleMessage({ event, client })` and nothing else.

- [ ] **Step 1: Write failing tests:**
  - receiver: top-level `{ type: "message", channel_type: "im", text: "Saturday" }` → `shouldEnqueueEvent` true; with `bot_id` → false; with `subtype: "message_changed"` → false.
  - dispatch: a threaded DM message calls `reservationsHandler.handleMessage` and neither `handler` (maintenance) nor `genderHandler`, even when the text matches a gender trigger; with no `reservationsHandler`, a DM is dropped (maintenance handler not called).
- [ ] **Step 2: Run** `npx vitest run tests/lambda` — expect FAIL.
- [ ] **Step 3: Implement.** Receiver: after the `bot_id` check, `if (event.channel_type === "im") return !event.subtype;`. Dispatch: `if (event.channel_type === "im") { if (reservationsHandler && event.type === "message") await reservationsHandler.handleMessage({ event, client }); return; }`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(reservations): route DMs to the reservations flow`

---

### Task 5: Reservations handler runs in the DM

**Files:**
- Modify: `src/events/reservations.js` (most of it), `src/services/reservations/rms.js:85-101`, `src/lambda/clients.js:135-141`
- Test: `tests/events/reservations.test.js`, `tests/events/reservations-connect.test.js`, `tests/services/reservations/rms.test.js`

**Interfaces:**
- Consumes: `openRequest`, `isEscape` (Task 3); `livingDigest.refresh(dateIso)` (Task 2).
- Produces: `createReservationsHandler({ llm, adapters, catalog, channelId, now, connect, livingDigest = null })` — same return shape `{ channelId, handleMessage, handleCommand, resume, disconnect }`.
- Produces: rms `book()` no longer takes or writes `permalink`; description is `Requested by: <name>\nSlack: <@<id>>`.

Behavior to implement (replacing the channel-thread flow):
- Replies go to the DM with no `thread_ts`. Two reply kinds: `ask(text)` leaves the request open; `done(text)` carries `CLOSED_METADATA`. `done`: booked, conflict, past date, unknown item, mixed backends, backend error / unavailable, every check / list / find answer, escape acknowledgement. `ask`: missing fields, ambiguous, "couldn't read that", connect prompt.
- `handleCommand`: post start marker `📅 You asked: <text>` with `REQUEST_EVENT_TYPE` metadata to `channel: userId`; the response's `channel` is the DM id. If `envelope.channel_id` ≠ that id, `tellPrivately` "Continuing in your DM with me." Then process with transcript `Member: <text>`.
- `handleMessage`: only `channel_type === "im"`, no `bot_id`, no `subtype`, non-empty text; everything else (including #reservations threads) is ignored. Read `conversations.history({ channel, limit: 50, include_all_metadata: true })`. History holds only top-level messages, so a thread reply is missing from it: prepend the current event when its `ts` isn't there. Then call `openRequest`. Test: `a thread reply in the DM continues the open request`.
  - Escape word: if open, `done("Okay, starting fresh.")`; if not open, ignore.
  - Open: transcript = those messages via the existing `line()` mapping.
  - Not open: parse `Member: <text>`; if intent is `other`, stop silently; else post a start marker for it, then continue.
- Remove `thread.closed`, `transcriptFor`, `reply_broadcast`, `getPermalink`.
- After `✅` is sent: `await livingDigest?.refresh(req.date)` inside try/catch → `log.error("digest refresh failed", ...)`.
- Connect: `promptConnect` posts the button with `chat.postMessage` to the DM (not `postEphemeral`); `createPending({ ..., channel: dmChannel, threadTs: null })`. `resume` replies to `pending.channel`, using `pending.threadTs` only if set (rows from before the deploy).
- `clients.js`: pass `livingDigest` into `createReservationsHandler`.

- [ ] **Step 1: Rewrite the tests** to the DM model. Must include: `/reserve posts the start marker to the member's DM`; `tells the member to look in their DM when run elsewhere`; `continues the open request` end-to-end (history mock with marker + bot question; parser receives both lines plus the new one; books); `chatter with nothing open is ignored` (intent `other` → no `postMessage`); `a plain message with nothing open starts a request` (marker posted, then handled); `escape closes the open request`; `ignores #reservations threads`; `booking confirmation goes to the DM, closed, never to the channel`; `digest refresh failure never fails the booking` (`refresh` rejects → handler resolves, ✅ sent); `refreshes the digest for the booked date` (`refresh` called with `"2026-10-17"`); connect prompt is a DM `postMessage` with the `reservations_connect_google` button; resume replies in the DM and refreshes the digest. Update rms tests: description has no permalink.
- [ ] **Step 2: Run** `npx vitest run tests/events tests/services/reservations` — expect FAIL.
- [ ] **Step 3: Implement** the behavior above.
- [ ] **Step 4: Run** `npx vitest run` — expect all PASS.
- [ ] **Step 5: Commit** `feat(reservations): /reserve conversations happen in the member's DM`

---

### Task 6: Find intent and the bare `/reserve` overview

**Files:**
- Modify: `src/services/llm.js:42-67,179`, `src/lib/reservation-request.js:8`, `src/lib/reservation-catalog.js`, `src/events/reservations.js`
- Test: `tests/services/llm.test.js`, `tests/lib/reservation-request.test.js`, `tests/lib/reservation-catalog.test.js`, `tests/events/reservations.test.js`

**Interfaces:**
- Produces: intent `"find"` in `normalizeRequest` (`INTENTS` gains `"find"`).
- Produces: `categoryCounts(catalog) -> string` in `reservation-catalog.js`, e.g. `"Rooms (11) · Kitchen (1) · Tech (23)"` in `CATEGORY_NAMES` order, empty categories left out.
- Produces: `FIND_CAP = 25` in `reservations.js`.

- [ ] **Step 1: Write failing tests:**
  - llm: prompt text contains `"find"` and says it is a member's direct messages with the reservations bot (not "#reservations Slack channel"); `max_tokens` for `parseReservationRequest` is `2048`.
  - request: `normalizeRequest({ intent: "find", items: ["Tech Set 2", "Nope"] }, CATALOG)` → intent `find`, items `[SET2]`, unmatched `["Nope"]`.
  - catalog: `categoryCounts` output for the test catalog.
  - handler: find with 3 items → `done` reply grouped by category with exact labels, ending with how to book (`/reserve <name> <day> <time> for <what>`); find with 30 items → 25 shown and `+5 more`; find with 0 items → "Nothing matches" plus `categoryCounts`; bare `/reserve` (empty text) → `tellPrivately` usage text plus `categoryCounts`, no DM post.
- [ ] **Step 2: Run** `npx vitest run` — expect FAIL.
- [ ] **Step 3: Implement.** Prompt intent line adds: `"find" (asks what items exist that fit a description, e.g. "what speakers are there?", "something for a picnic"; put every fitting item name in "items")`. Change the opening to "You read a member's direct messages with a community building's reservations bot." Raise max tokens to 2048. Handler: `if (req.intent === "find") return find(req, done)` before the check/list branch; also take that branch when ambiguous/unmatched would otherwise fire for a find. Update `USAGE` to include a find example.
- [ ] **Step 4: Run** `npx vitest run` — expect PASS.
- [ ] **Step 5: Commit** `feat(reservations): find items by description with /reserve`

---

### Task 7: Runbook and rollout notes

**Files:**
- Modify: `docs/RUNBOOK.md` (reservations section)

- [ ] **Step 1: Document** the Slack app changes from the spec: add `im:history`; subscribe to bot event `message.im`; App Home → Messages tab on, "Allow users to send messages" ticked; reinstall. Note that until then `/reserve` answers in the DM but follow-up messages don't reach the bot. Document the two digest schedules and that bookings made directly in sheets/calendars show on the next edit or post.
- [ ] **Step 2: Run** `npx vitest run` — expect all PASS (no code change; confirms the branch is green).
- [ ] **Step 3: Commit** `docs(reservations): runbook for DM conversations and living digests`

After merge (user does these, not the implementer): Slack app changes above, then a live check — `/reserve` a lookup, a find, an incomplete booking answered with a plain message, and one real booking; confirm the digest edit in #reservations.
