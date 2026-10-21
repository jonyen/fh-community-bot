# Listing Card, Tray and Repeats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members in #reservations can browse everything bookable on a private, paged, searchable card, collect items into a tray (each with its own date, time, title, repeat), reserve them all at once, and see one combined public post whose lines can be cancelled (a series as a whole or one date).

**Architecture:** The tray, the member's place in the listing (search, category, page) and the line being edited live in one DynamoDB row per member (`tray#<U>` in the existing auth/ledger table), so the private card carries only action ids and item/line ids. Every interaction is queued to the worker as today and re-renders the private card through the press's `response_url`. Reserve all books per backend through new adapter `checkDates`/`bookMany` methods, records progress per date in the tray row so a retry resumes, writes the ledger (series as one entry) and posts one combined message.

**Tech Stack:** Node 22 ESM, Slack Block Kit (ephemeral messages, `response_url`), Google Sheets/Calendar via `googleapis`, DynamoDB (`@aws-sdk/lib-dynamodb`), Vitest, SAM.

**Spec:** `docs/superpowers/specs/2026-10-20-reservations-listing-card-design.md`

## Global Constraints

- Bot persona for everything in #reservations: `{ username: "Reservations", icon_emoji: ":calendar:" }`. Maintenance replies keep "FH Maintenance".
- Listing and tray are ephemeral (only the asker sees them); every change to them goes through the interaction's `response_url` with `replace_original: true`. Never `chat.update` an ephemeral.
- Page size 8. Tray limits: at most 10 lines; a repeat at most 183 days from its first date to `until`; at most 60 dates per Reserve all. Tray expires 24 h after the last change.
- Repeat pattern: weekly on chosen weekdays (0=Sun … 6=Sat) from the line's date through `until` (inclusive).
- An ephemeral message is at most 50 blocks; button values ≤ 2,000 chars; block ids ≤ 255; section text ≤ 3,000 (use `fitSection`); confirm text ≤ 300; static_select ≤ 100 options.
- Copy style: emoji lead, `·` separators, plain sentences. Exact strings in the tasks are fixed copy.
- Every write to a backend uses the same account rules as Book today: when `connect` is configured, the member's Google clients; otherwise the bot's.
- Once anything is written, a failed Slack reply, post, ledger write or digest refresh is logged and never rethrown (an SQS retry must not write again).
- Search text is capped at 60 characters everywhere it is stored or shown, and escaped (`&`, `<`, `>`) before it goes into mrkdwn.

## Rulings recorded while planning

- **P1 (deviation from spec):** without a ledger/auth table configured, "list items to reserve" answers with the category counts line and "To book, post the item, day, time and what it's for." instead of an interactive card, because the card's state lives in that table. Production has the table. Cost if wrong: deploys without the table get no browsing card.
- **P2:** a date written in a run that crashed between "started" and "done" is removed from the tray and reported as "may already be booked, please check before booking again", never written twice.
- **P3:** a series-cancel from the combined post or "mine" that needs the member's Google account and finds them unconnected shows the connect prompt and stores a pending row of kind `series-cancel`; it resumes after they connect.

## Review Focus

1. Reserve all pressed with a line that is incomplete, in the past, or whose item has left the catalog: refused (incomplete/past) or that line skipped with "no longer bookable" (item gone); nothing else in the tray is lost. Tests in Task 10.
2. A repeat with no weekdays ticked, `until` before the date, or over 183 days: the form shows the problem, the tray line shows ⚠️, Reserve all is refused naming the line. Tests in Task 3.
3. A search containing Slack markup (`<!channel>`, `*bold*`, `&`) or longer than 60 characters: shown escaped and cut, never pinging anyone. Tests in Task 7.
4. The `response_url` has expired (fetch not ok) when Reserve all finishes: the bookings and public post stand, the ledger is written, a warning is logged, the event does not throw. Tests in Task 10.
5. The model fallback for search fails (returns null or throws): the card shows "Nothing matches" with category counts, and the failure is not cached. Tests in Task 9.

---

### Task 1: Rename, digest lookup, worker timeout

**Files:**
- Modify: `src/lib/reservation-format.js:5`
- Modify: `src/services/livingDigest.js` (`refresh`)
- Modify: `template.yaml` (WorkerFn `Timeout`, EventQueue `VisibilityTimeout`)
- Test: `tests/services/livingDigest.test.js`, plus every test asserting `"FH Reservations"` (`tests/events/reservations.test.js`, `tests/events/reservations-connect.test.js`, `tests/services/livingDigest.test.js`)

**Interfaces:**
- Produces: `BOT_PERSONA = { username: "Reservations", icon_emoji: ":calendar:" }`; `livingDigest.refresh(dateIso) -> Promise<boolean>` unchanged in signature.

- [ ] **Step 1: Write the failing tests**

In `tests/services/livingDigest.test.js`:

```js
it("refresh pages back through history to find an older digest", async () => {
  client.conversations.history
    .mockResolvedValueOnce({ messages: [{ ts: "900.1" }], response_metadata: { next_cursor: "c2" } })
    .mockResolvedValueOnce({ messages: [digestMsg("800.1", "2026-10-23", "2026-10-25")], response_metadata: { next_cursor: "" } });
  const adapters = { rooms: makeAdapter("rooms", { reservations: [WEEKEND_RES], errors: [] }) };
  const ok = await createLivingDigest({ client, adapters, channelId: "CRES" }).refresh("2026-10-24");
  expect(ok).toBe(true);
  expect(client.conversations.history).toHaveBeenNthCalledWith(2, expect.objectContaining({ channel: "CRES", cursor: "c2", limit: 200, include_all_metadata: true }));
  expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "800.1" }));
});

it("refresh stops after 5 pages or once messages are older than a week before the period", async () => {
  client.conversations.history.mockResolvedValue({ messages: [{ ts: "1.0" }], response_metadata: { next_cursor: "more" } });
  const ok = await createLivingDigest({ client, adapters: {}, channelId: "CRES" }).refresh("2026-10-24");
  expect(ok).toBe(false);
  expect(client.conversations.history.mock.calls.length).toBeLessThanOrEqual(5);
});
```

Update the existing refresh test's expected history call to `{ channel: "CRES", limit: 200, include_all_metadata: true, oldest: <epoch seconds of period.from minus 7 days, NY midnight> }`, and change every expected `username: "FH Reservations"` to `"Reservations"`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/services/livingDigest.test.js tests/events`
Expected: FAIL (single 100-message call; old username).

- [ ] **Step 3: Implement**

- `BOT_PERSONA.username = "Reservations"`.
- `refresh`: loop `conversations.history({ channel, limit: 200, include_all_metadata: true, oldest, cursor })` up to 5 pages, where `oldest` is the epoch seconds of `nyDateTime(addDaysIso(period.from, -7), 0)`; stop at the first match or an empty `next_cursor`.
- `template.yaml`: WorkerFn `Timeout: 300` with a comment ("Reserve all books calendar dates that each take seconds to confirm"); EventQueue `VisibilityTimeout: 1800` (AWS: at least 6× the function timeout).

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-format.js src/services/livingDigest.js template.yaml tests
git commit -m "feat(reservations): post as Reservations; find the digest further back; longer worker timeout"
```

---

### Task 2: Parser — `browse` intent, `search`, and `matchItems`

**Files:**
- Modify: `src/services/llm.js` (prompt intents line; new `matchItems`)
- Modify: `src/lib/reservation-request.js` (`INTENTS`, `search` field)
- Test: `tests/services/llm.test.js`, `tests/lib/reservation-request.test.js`

**Interfaces:**
- Produces: `normalizeRequest(raw, catalog).search: string|null` (trimmed, cut to 60); intent `"browse"`.
- Produces: `llm.matchItems(query: string, { catalogText }) -> Promise<string[] | null>` — exact item names the model says fit; `null` on failure or non-JSON.

- [ ] **Step 1: Write the failing tests**

```js
// reservation-request.test.js
it("keeps the browse intent and its search words", () => {
  const r = normalizeRequest({ intent: "browse", search: "  speakers  " }, CATALOG);
  expect(r).toMatchObject({ intent: "browse", search: "speakers" });
});
it("cuts a long search to 60 characters and nulls a blank one", () => {
  expect(normalizeRequest({ intent: "browse", search: "x".repeat(80) }, CATALOG).search).toHaveLength(60);
  expect(normalizeRequest({ intent: "browse", search: " " }, CATALOG).search).toBeNull();
});

// llm.test.js
it("matchItems returns the names the model lists", async () => {
  client.messages.create.mockResolvedValue({ content: [{ type: "text", text: '["Tech Set 1","Tech Set 2"]' }] });
  await expect(llm.matchItems("speaker", { catalogText: "Tech: Tech Set 1, Tech Set 2" })).resolves.toEqual(["Tech Set 1", "Tech Set 2"]);
});
it("matchItems returns null on a failed call or a non-array reply", async () => {
  client.messages.create.mockResolvedValueOnce({ content: [{ type: "text", text: "no idea" }] });
  await expect(llm.matchItems("x", { catalogText: "" })).resolves.toBeNull();
  client.messages.create.mockRejectedValueOnce(new Error("boom"));
  await expect(llm.matchItems("x", { catalogText: "" })).resolves.toBeNull();
});
it("the reservation prompt describes browse and search", async () => {
  client.messages.create.mockResolvedValue({ content: [{ type: "text", text: '{"intent":"browse","search":"speakers"}' }] });
  await llm.parseReservationRequest("Member: list speakers to reserve", { catalogText: "", today: "2026-10-20", weekday: "Tuesday" });
  const { system } = client.messages.create.mock.calls[0][0];
  expect(system).toContain('"browse"');
  expect(system).toContain('"search"');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/services/llm.test.js tests/lib/reservation-request.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Prompt: add `"browse" (asks to see the things that can be reserved, e.g. "list items to reserve", "what can I reserve?", "list reservations" when no day or item is named)` to the intent list, and a field line `- "search": for browse only, the words describing what they want to see (e.g. "speakers" in "list speakers to reserve"), else null.` Keep `"list"` for requests naming a day or item.
- `matchItems`: system prompt "Given the bookable items below, output ONLY a JSON array of the exact item names that fit the member's search words. Output [] if none fit." with the catalog text; `max_tokens` 1024; parse the first `[`…last `]`; return only string elements; `null` on any failure.

- [ ] **Step 4: Run tests** — `npx vitest run tests/services/llm.test.js tests/lib/reservation-request.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): parse browse requests and match search words to items"`

---

### Task 3: Tray model (pure)

**Files:**
- Create: `src/lib/reservation-tray.js`
- Test: `tests/lib/reservation-tray.test.js`

**Interfaces:**
- Produces constants: `MAX_LINES = 10`, `MAX_DATES = 60`, `MAX_REPEAT_DAYS = 183`, `TRAY_TTL_S = 86400`.
- Produces types (documented in a header comment):
  - `Line = { id: string, item: string /* catalog label */, date: ISO|null, start: number|null, end: number|null, title: string|null, appliances: object, repeat: null | { days: number[] /* 0=Sun */, until: ISO|null }, onlyDates: ISO[]|null, progress: { [ISO]: "started"|"done" } }`
  - `Tray = { version: number, lines: Line[], view: { q: string, c: string /* "all" or category id */, p: number }, editing: Line|null /* draft being edited */, running: { runId: string, at: number } | null }`
- Produces functions:
  - `emptyTray() -> Tray`
  - `newLine(itemLabel, prev: Line|null, makeId = randomId) -> Line` — copies `date,start,end,title,repeat` from `prev` (not appliances, not progress).
  - `expandDates(line) -> ISO[]` — no repeat: `[date]`; repeat: every date from `date` to `until` inclusive whose weekday is in `days`; filtered by `onlyDates` when set; `[]` when `date` is null.
  - `lineProblems(line, { today, nowMin, catalog }) -> string[]` — fixed copy: `"Pick a date."`, `"Pick a start and end time."`, `"End must be after start."`, `"Add what it's for."`, `"That date has passed."`, `"That time has already passed today."`, `"Pick at least one day to repeat on."`, `"Pick when the repeat ends."`, `"The repeat must end after its first date."`, `"Repeats can run at most 6 months."`, `"<label> can no longer be booked."` (item not in catalog).
  - `trayProblems(tray, ctx) -> string[]` — per line `"<label>: <problem>"`, plus `"Your tray has more than 10 lines."` and `"That's <n> dates; Reserve all can do at most 60 at once."`
  - `repeatText(repeat, untilFmt = fmtDay) -> string` — e.g. `"every Sat, Sun until Sat Dec 20"`.
  - `lineSummary(line) -> string` — `"<item> · <fmtDay(date)> · <fmtRange> · <title>"` plus `" · <repeatText> · <n> dates"` for repeats; missing parts as `_day?_`, `_time?_`, `_what for?_` like the card.

- [ ] **Step 1: Write the failing tests**

```js
const L = (o = {}) => ({ id: "l1", item: "MPR", date: "2026-10-24", start: 840, end: 960, title: "MBS", appliances: {}, repeat: null, onlyDates: null, progress: {}, ...o });
const CTX = { today: "2026-10-20", nowMin: 600, catalog: [{ label: "MPR", category: "rooms", backend: "rooms" }] };

it("expands a weekly Sat/Sun repeat through its until date", () => {
  expect(expandDates(L({ repeat: { days: [6, 0], until: "2026-11-01" } }))).toEqual(["2026-10-24", "2026-10-25", "2026-10-31", "2026-11-01"]);
});
it("keeps only onlyDates when set", () => {
  expect(expandDates(L({ repeat: { days: [6, 0], until: "2026-11-01" }, onlyDates: ["2026-10-31"] }))).toEqual(["2026-10-31"]);
});
it("names a repeat with no days, a backwards until, or one over 6 months", () => {
  expect(lineProblems(L({ repeat: { days: [], until: "2026-11-01" } }), CTX)).toContain("Pick at least one day to repeat on.");
  expect(lineProblems(L({ repeat: { days: [6], until: "2026-10-01" } }), CTX)).toContain("The repeat must end after its first date.");
  expect(lineProblems(L({ repeat: { days: [6], until: "2027-05-01" } }), CTX)).toContain("Repeats can run at most 6 months.");
});
it("refuses a tray over 60 dates and names the count", () => {
  const big = { ...emptyTray(), lines: [L({ repeat: { days: [0, 1, 2, 3, 4, 5, 6], until: "2027-01-01" } })] };
  expect(trayProblems(big, CTX)).toContain("That's 70 dates; Reserve all can do at most 60 at once.");
});
it("newLine copies the previous line's when and what-for, not its appliances", () => {
  const l = newLine("Kitchen", L({ appliances: { island: true } }), () => "l2");
  expect(l).toMatchObject({ id: "l2", item: "Kitchen", date: "2026-10-24", start: 840, end: 960, title: "MBS", appliances: {} });
});
it("summarises a repeat line", () => {
  expect(lineSummary(L({ repeat: { days: [6, 0], until: "2026-11-01" } }))).toBe("MPR · Sat Oct 24 · 2:00–4:00 PM · MBS · every Sat, Sun until Sun Nov 1 · 4 dates");
});
```

(Use whatever `fmtDay`/`fmtRange` actually print; the test pins the composition, copy it from a real call.)

- [ ] **Step 2–4:** run `npx vitest run tests/lib/reservation-tray.test.js` (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): tray lines, repeats and their limits"`

---

### Task 4: Adapters — `checkDates`

**Files:**
- Modify: `src/services/reservations/rooms.js`, `kitchen.js`, `rms.js`
- Test: `tests/services/reservations/rooms.test.js`, `kitchen.test.js`, `rms.test.js`

**Interfaces:**
- Produces on every adapter: `checkDates({ dates: ISO[], start, end, items }) -> Promise<{ [ISO]: { conflicts: Reservation[], unavailable: string|null } }>` with **one** backend read per call (rooms: one `readRows`; kitchen: one `readRows`; rms: one `events.list` per item over `min(dates)…max(dates)`).
- Semantics per date: rooms — conflicts as `findConflicts`; kitchen — `unavailable: "The kitchen sheet is not open yet for that date."` when the date has no rows, conflicts only when ≥ `maxGroups` overlap (as `findConflicts`); rms — conflicts as `findConflicts`, `unavailable` null.

- [ ] **Step 1: Failing tests** (one per adapter): two dates, one taken and one free, asserting the map and that the sheet/calendar was read once (`toHaveBeenCalledTimes(1)` per item for rms). Kitchen: a date with no rows yields the "not open yet" text.
- [ ] **Step 2–4:** run the three adapter test files (FAIL → implement → PASS). Reimplement `findConflicts` as `checkDates({dates:[date],…})[date].conflicts` so the two can't drift.
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): check many dates in one read"`

---

### Task 5: Adapters — `bookMany`

**Files:**
- Modify: `src/services/reservations/rooms.js`, `kitchen.js`, `rms.js`
- Test: the three adapter test files

**Interfaces:**
- Produces on every adapter: `bookMany(bookings: Booking[], { clients } = {}) -> Promise<Result[]>`, results aligned with input, where `Booking` is the shape `book()` takes and `Result = { status: "booked", link, ref } | { status: "unavailable", reason, link } | { status: "error", error }`. **Never throws.**
  - rooms: one `values.append` with all rows (same columns `book()` writes); refs built per row; a failed append makes every result `{ status: "error", error }`.
  - kitchen: one `readRows`, assign a free pre-dated row per booking (two bookings on one day take two rows), one `values.batchUpdate`; dates with no rows / no free rows get the same `unavailable` reasons `book()` gives; a failed write → all `error`.
  - rms: `book()` per booking with concurrency 4 (reuse `mapLimit`), each wrapped so a throw becomes `{ status: "error", error }`.

- [ ] **Step 1: Failing tests:** rooms appends 3 rows in one call and returns 3 refs; rooms append failure → 3 errors; kitchen books two groups the same day into two rows in one batchUpdate and reports "not open yet" for a date without rows; rms runs at most 4 `events.insert` at once (track in-flight count in the fake) and turns one thrown insert into `{status:"error"}` while the others book.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): book many dates per backend in one go"`

---

### Task 6: Tray store and series ledger

**Files:**
- Modify: `src/services/authStore.js`
- Test: `tests/services/authStore.test.js` (extend `fakeDdb` to honour `ConditionExpression` of the form `attribute_not_exists(pk) OR #v = :v`, and `UpdateCommand` generically enough for the new calls)

**Interfaces:**
- Produces:
  - `getTray(user) -> Promise<Tray|null>` (null when absent or expired).
  - `putTray(user, tray, { expectVersion }) -> Promise<boolean>` — writes `{ ...tray, version: expectVersion + 1 }` only if the stored version equals `expectVersion` (or none exists and `expectVersion` is 0); `expiresAt = now + TRAY_TTL_S`; returns false on a lost race.
  - `deleteTray(user) -> Promise<void>`.
  - `recordSeries(user, series, { today })` where `series = { id, item, start, end, title, repeat, channel, postTs, refs: Ref[] }` — stored in the same `bookings#<U>` item under attribute `series` (array), pruned of series whose refs have all ended; `expiresAt` covers the latest ref date + 2 days.
  - `seriesFor(user, { today }) -> Promise<Series[]>` — each with only refs whose `date >= today`, series with none left dropped.
  - `dropSeriesRefs(user, id, keys: string[])` — removes refs whose `refKey` is in `keys`.
  - `bookingsFor` now returns single refs **plus** every live series ref (so `isMine` keeps working).

- [ ] **Step 1: Failing tests:** put/get round trip; a second `putTray` with a stale version returns false; an expired tray reads null; `recordSeries` then `seriesFor` drops past refs; `bookingsFor` includes series refs; `MAX_BOOKING_REFS` still caps single refs only.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): store a member's tray and booked series"`

---

### Task 7: Listing view and line form (messages)

**Files:**
- Create: `src/lib/reservation-listing.js`
- Create: `src/lib/reservation-line-form.js`
- Modify: `src/lib/reservation-modal.js` (export `applianceBlocks`, export `readAppliances(values)`, export `toTimes(startHHMM, endHHMM)` — the 00:00-after-start-is-1440 rule — and use them in the modal)
- Test: `tests/lib/reservation-listing.test.js`, `tests/lib/reservation-line-form.test.js`, existing `tests/lib/reservation-modal.test.js` stays green

**Interfaces:**
- `reservation-listing.js` produces:
  - Action ids: `LIST_SEARCH_ACTION = "reservation_list_search"`, `LIST_CATEGORY_ACTION = "reservation_list_category"`, `LIST_PAGE_ACTION = "reservation_list_page"`, `LIST_ADD_ACTION = "reservation_list_add"`, `LIST_EDIT_ACTION = "reservation_list_edit"`, `TRAY_RESERVE_ACTION = "reservation_tray_reserve"`, `TRAY_CLEAR_ACTION = "reservation_tray_clear"`; `PAGE_SIZE = 8`; `LISTING_ACTIONS: Set` of these.
  - `filterCatalog(catalog, { q, c }) -> CatalogEntry[]` — literal, case-insensitive match on label, room aliases (from `ROOMS` in `rooms-catalog.js`) and category name; `c` other than `"all"` narrows by category.
  - `listingMessage({ items, total, view: { q, c, p }, categories, tray, lineStatus: { [lineId]: string }, notice = null, searchedByModel = false }) -> { text, blocks }`:
    - header `📋 Things you can reserve · <total> items`, or `📋 <n> items match "<q>"` (q escaped);
    - an `input` block (`block_id: "list_search"`, `dispatch_action: true`, `plain_text_input` with `action_id: LIST_SEARCH_ACTION`, `max_length: 60`, `initial_value: q`, placeholder `Search, e.g. "tech", "youth"`, `dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] }`);
    - an actions block with the category `static_select` (`"All categories"` + categories present);
    - one section per item on the page: `*<label>* · <Category>` with accessory `+ Add` (`LIST_ADD_ACTION`, value = label) or `✓ Added` (`LIST_EDIT_ACTION`, value = line id);
    - nav actions (`◀ Prev` / `Next ▶`, `LIST_PAGE_ACTION`, value = target page) only where a page exists, and a context `Page x of y`;
    - no matches: `Nothing matches "<q>".` + `categoryCounts`;
    - when the tray has lines: a divider, `*Your tray (<n>)*`, one section per line with `lineSummary(line)` + ` · ` + `lineStatus[id]` and an `Edit` button (`LIST_EDIT_ACTION`, value = line id), then actions `Reserve all` (primary, `TRAY_RESERVE_ACTION`) and `Clear` (`TRAY_CLEAR_ACTION`, with a confirm);
    - `notice` (if any) as the first section.
- `reservation-line-form.js` produces:
  - Action ids: `FORM_DATE_ACTION = "reservation_form_date"`, `FORM_START_ACTION = "reservation_form_start"`, `FORM_END_ACTION = "reservation_form_end"`, `FORM_REPEAT_ACTION = "reservation_form_repeat"` (radio: `none` / `weekly`), `FORM_DAYS_ACTION = "reservation_form_days"` (checkboxes 0–6), `FORM_UNTIL_ACTION = "reservation_form_until"`, `FORM_SAVE_ACTION = "reservation_form_save"`, `FORM_REMOVE_ACTION = "reservation_form_remove"`, `FORM_BACK_ACTION = "reservation_form_back"`; `FORM_ACTIONS: Set`.
  - `lineFormMessage({ line, entry /* catalog entry */, check: string|null, problems: string[], notice = null }) -> { text, blocks }` — header `📅 *<label>* · <Category>`; actions block (`block_id: "form_when"`) with datepicker/timepickers pre-set from the line; `input` block `block_id: "title"` (`action_id: "title"`, optional, `initial_value`); repeat radio, and when weekly, the day checkboxes and until datepicker; kitchen appliances via `applianceBlocks`; a section with `check` (✅/❌/⚠️ text) and any `problems` lines; actions Save (primary), Remove (only for a line already in the tray), `◀ Back to list`.
  - `readLineForm(stateValues, line) -> Line` — the draft updated from `payload.state.values` (date, times via `toTimes`, title, repeat kind/days/until, appliances via `readAppliances`); unchanged fields kept.

- [ ] **Step 1: Failing tests** (listing): page 2 of 3 has Prev and Next and 8 item sections; last page has no Next; an added item shows `✓ Added` with the line id; search `<!channel> *x*` appears as `&lt;!channel&gt; *x*` escaped in the header (Review Focus 3) and a 70-char search is shown cut to 60; the whole message with 8 items and a 10-line tray is ≤ 50 blocks; no tray section when the tray is empty; `filterCatalog` finds "MPR" by alias "multipurpose room" and Tech items by category "tech".
- [ ] **Step 1b: Failing tests** (form): weekly repeat shows the day checkboxes with Sat/Sun initially selected; `readLineForm` reads an end of `00:00` after a 20:00 start as 1440; Remove is absent for a new line; kitchen shows appliances.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run tests/lib`).
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): listing card and tray line form messages"`

---

### Task 8: Combined post and series chooser (messages)

**Files:**
- Create: `src/lib/reservation-combined.js`
- Test: `tests/lib/reservation-combined.test.js`

**Interfaces:**
- Produces: `POST_CANCEL_ACTION = "reservation_post_cancel"`, `SERIES_ALL_ACTION = "reservation_series_all"`, `SERIES_ONE_ACTION = "reservation_series_one"`, `COMBINED_EVENT_TYPE = "reservation_combined"`.
- `combinedMessage({ user, booked: [{ summary: string, ref?: Ref, seriesId?: string, count: number }], skipped: [{ text: string }] }) -> { text, blocks, metadata }`:
  - first section `✅ <@user> reserved:`; one section per booked entry (`• <summary>`) with accessory `Cancel` (`POST_CANCEL_ACTION`, danger): value `{"u":user,"i":index,"r":ref}` for a single date (with a Slack confirm naming the line, `Keep it`/`Cancel booking`), or `{"u":user,"i":index,"s":seriesId}` for a series (no confirm; the chooser follows);
  - when `skipped` is not empty: `⚠️ Not booked, already claimed or unavailable:` then one `• <text>` per skip, chunked into sections under 3,000 chars;
  - `metadata: { event_type: COMBINED_EVENT_TYPE, event_payload: { user } }`.
- `markLineCancelled(message, index, text) -> { text, blocks, metadata }` — that entry's section gets `\n<text>` appended and loses its accessory; others untouched.
- `seriesChooser({ user, series: { id, item, start, end, title, repeat, refs }, postTs, channel }) -> { text, blocks }` — `Cancel *<item>* · <repeatText> · <fmtRange>?` then a button `Whole series` (`SERIES_ALL_ACTION`, danger, confirm "Cancel every remaining date?") with value `{"u","s","pt","c"}`, and a `static_select` (`SERIES_ONE_ACTION`, placeholder "Just one date") with one option per remaining ref date (`fmtDay` text, value `{"d":date}`), at most 100, with a confirm. The select's `block_id` carries `{"u","s","pt","c"}` JSON (≤255 chars).

- [ ] **Step 1: Failing tests:** a two-line post with one series and one single has two Cancel buttons with the right values; a skip list renders under the ⚠️ header; `markLineCancelled` changes only that section; the chooser lists remaining dates only and caps at 100.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): combined post and series cancel chooser"`

---

### Task 9: Listing flow (browse, search, tray editing)

**Files:**
- Create: `src/events/reservations-listing.js`
- Modify: `src/events/reservations.js` (route `browse`; route listing and form actions; pass deps)
- Modify: `src/lambda/clients.js` (pass `trayStore: ledger` and `llm` already present)
- Test: `tests/events/reservations-listing.test.js`

**Interfaces:**
- Consumes: Tasks 2–4, 6, 7.
- Produces: `createListingFlow({ catalog, adapters, llm, catalogText, trayStore, now, withMentions }) -> { post({ channel, user, search, client }), handleAction({ payload, action, client }), ACTIONS: Set }` and `lineCheck(line) -> Promise<string>` (exported for Task 10's tray statuses):
  - `post`: without `trayStore` → `chat.postEphemeral` with ruling P1's text. Otherwise load or create the tray, set `view = { q: search ?? "", c: "all", p: 0 }`, save, `chat.postEphemeral({ channel, user, ...BOT_PERSONA, ...listingMessage(...) })`.
  - Search: literal `filterCatalog` first; when it returns nothing and `q` is non-empty, `llm.matchItems(q, { catalogText })`, keep only labels found in the catalog, and cache the result in memory for 10 minutes per lowercased query (max 200 entries; failures and `null` are not cached). Model failure → "Nothing matches" (Review Focus 5).
  - `handleAction` (all replies via `fetch(payload.response_url, { replace_original: true, ... })`; a non-ok response is logged as a warning):
    - `LIST_SEARCH_ACTION`: `view.q = action.value` (cut to 60), `p = 0`; `LIST_CATEGORY_ACTION`: `view.c = selected value`, `p = 0`, and `view.q` from `state.values.list_search`; `LIST_PAGE_ACTION`: `view.p = Number(value)` clamped.
    - `LIST_ADD_ACTION`: if the tray has 10 lines → listing with notice `Your tray is full (10 lines). Reserve or remove some first.`; else `editing = newLine(label, lastLine)` → form.
    - `LIST_EDIT_ACTION`: `editing = copy of that line` → form.
    - Form pickers (`FORM_DATE/START/END/REPEAT/DAYS/UNTIL_ACTION`): `editing = readLineForm(state.values, editing)`, save, re-render the form with `check = await lineCheck(editing)` and `problems = lineProblems(...)`.
    - `FORM_SAVE_ACTION`: read the form, replace or append the line (by id), clear `editing` → listing. `FORM_REMOVE_ACTION`: drop the line → listing. `FORM_BACK_ACTION`: clear `editing` → listing.
    - `TRAY_CLEAR_ACTION`: empty lines → listing with notice `Tray cleared.`
    - A press whose tray is gone (expired) → listing of a fresh tray with notice `Your tray expired after a day without changes, so it was cleared.`
  - `lineCheck(line)`: `""` when problems block a check; otherwise `adapter.checkDates({ dates: expandDates(line), start, end, items: [entry] })` and returns `✅ free` (one date) / `✅ all <n> dates free` / `❌ taken by <holder>` (one date, with mentions) / `⚠️ <k> of <n> dates taken: <fmtDay> (<holder>), …` (first 5, then `…`) / `⚠️ <reason>` for `unavailable`. Tray lines in the listing show their `lineCheck` result (computed per render; at most 10 lines).
- `reservations.js`: after parsing, `if (req.intent === "browse") return listing.post({ channel: event.channel, user: event.user, search: req.search, client })`; in `handleCardAction`, when the action id is in `listing.ACTIONS`, `return listing.handleAction(...)` (Task 10 adds Reserve all; until then `TRAY_RESERVE_ACTION` re-renders the listing with notice `Reserve all is coming next.` — removed in Task 10).

- [ ] **Step 1: Failing tests** (fake `trayStore` in memory with the Task 6 contract; `fetchSpy` as in `reservations.test.js`):
  - "list items to reserve" posts an ephemeral listing as "Reservations" with no thread_ts and saves view `{q:"",c:"all",p:0}`.
  - search "speaker" with no literal match calls `matchItems` once, shows its catalog-valid items, and paging that search doesn't call it again (cache); a `null` result shows `Nothing matches "speaker".` and the next identical search calls the model again.
  - Add → form pre-filled from the last line; picking dates runs `checkDates` once and shows `⚠️ 1 of 2 dates taken: …`; Save returns to the same page and search with the line in the tray; Back discards; Remove drops; 11th Add gives the full-tray notice.
  - An expired tray shows the expiry notice.
  - Without `trayStore`, the P1 text is posted.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run tests/events`).
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): browse, search and edit a tray on a private card"`

---

### Task 10: Reserve all

**Files:**
- Create: `src/events/reservations-reserve-all.js`
- Modify: `src/events/reservations.js` (extract `memberClients(user)` and `classifyWriteError(error)` from `finishBooking` and reuse them there; route `TRAY_RESERVE_ACTION`; resume pending kind `tray`)
- Modify: `src/lambda/oauthCallback.js:86` (`kind === "tray"` → "Your reservations are being made now.")
- Test: `tests/events/reservations-reserve-all.test.js`, `tests/lambda/oauthCallback.test.js`

**Interfaces:**
- Consumes: Tasks 3–6, 8, 9 (`lineCheck`), and from `reservations.js`: `requesterFor`, `promptConnect`, `withMentions`, `memberClients(user) -> { status: "active", clients } | { status: "none"|"revoked" } | { status: "bot" }` (`"bot"` when `connect` is null), `classifyWriteError(error) -> "revoked" | "forbidden" | "error"`.
- Produces: `createReserveAll({ adapters, catalog, connect, ledger, trayStore, livingDigest, now, requesterFor, promptConnect, withMentions, memberClients, classifyWriteError, forbiddenText }) -> { run({ user, channel, client, runId, responseUrl }), resume(pending, client) }`.

Algorithm (`run`):
1. Load the tray. `trayProblems` non-empty → re-render the listing with notice `Can't reserve yet:\n• …` and stop (Review Focus 1, except a line whose item left the catalog, which is skipped in step 4 with reason `<label> can no longer be booked.`).
2. If `tray.running` exists with another `runId` started under 15 minutes ago → private notice `Already reserving your tray. One moment.` and stop. Otherwise `putTray({ ...tray, running: { runId, at: now } }, { expectVersion })`; a lost race → stop silently.
3. `memberClients(user)`: `"none"`/`"revoked"` → `promptConnect` with `request: { kind: "tray", user, channel }` (private prompt text `To book as you, connect your Google account once. I'll reserve your tray as soon as you approve.`), clear `running`, stop.
4. For each line: `dates = expandDates(line)` minus dates whose `progress` is `"done"`; a date with `progress: "started"` is a skip `may already be booked, please check before booking again` (ruling P2). Re-check with `checkDates`; conflicts → skip `<item> · <day> · <range> (<holder> · <title>)`; `unavailable` → skip `<item> · <day> · <reason>`.
5. Group the free dates by backend. Before writing a group, mark its dates `"started"` and save the tray (version-checked); then `adapter.bookMany(bookings, { clients })`; then mark `"done"` per booked date and save. For RMS, several items of one line on the same date stay one booking each (line = one item).
6. Per result: `booked` → collect ref; `unavailable` → skip with its reason; `error` → `classifyWriteError`: `"revoked"` → `markRevoked`, stop booking further groups, remember to prompt connect after posting; `"forbidden"` → skip the rest of that backend's dates with `forbiddenText(adapter, …)`; `"error"` → skip with `couldn't save (<message>)`.
7. Ledger: single-date lines `recordBooking(user, ref)`; repeat lines `recordSeries(user, { id: `${line.id}-${runId}`, item, start, end, title, repeat, channel, postTs, refs })` (after the post, so `postTs` is known). Failures logged.
8. Public post (only if something was booked): `chat.postMessage({ channel, ...BOT_PERSONA, ...combinedMessage(...) })` top-level; repeat summaries `"<item> · every <days> <first day> – <last day> (<n> dates) · <range> · <title>"`.
9. Tray: remove booked dates (lines with nothing left are dropped; partly booked lines get `onlyDates` = their unbooked dates, `progress` cleared), clear `running`, save.
10. Private card via `responseUrl`: `✅ Reserved <n> bookings. It's posted in the channel.` (or `Nothing could be booked.`) plus the skip lines, then the listing with the remaining tray. A non-ok `response_url` (expired) → `chat.postEphemeral` the same text; failures logged, never thrown (Review Focus 4).
11. Digest: `livingDigest.refresh(date)` once per distinct `periodCovering(date).from` among booked dates.
12. If revoked in step 6: prompt connect (pending kind `tray`) after the post.

`resume(pending)` for kind `tray`: `run({ user, channel, client, runId: "resume-" + pendingId, responseUrl: null })` — every private reply goes through `chat.postEphemeral`.

- [ ] **Step 1: Failing tests:**
  - Mixed tray (MPR repeat of 4 dates with 1 taken, Tech Set 2 single, Kitchen single) books 3 + 1 + 1 through `bookMany` once per backend, posts one combined message with the taken MPR date under "Not booked", records one series and two single refs, refreshes each period once, and leaves the tray with only the taken MPR date.
  - Nothing free → no public post, private `Nothing could be booked.`
  - Incomplete line → refused with `Can't reserve yet:` naming it; nothing booked.
  - A line whose item left the catalog is skipped with `can no longer be booked`; the rest books.
  - Double press: second run while the first holds `running` → `Already reserving your tray. One moment.`; a redelivered run with the same `runId` after a crash resumes and skips `"done"` dates, reporting `"started"` ones as "may already be booked".
  - Connect configured, member not connected → connect prompt, pending `{ kind: "tray" }`, nothing booked; `resume` books and posts publicly, replies privately by `postEphemeral`.
  - RMS `bookMany` result `{status:"error", error: invalid_grant}` → already-booked part is posted, member is marked revoked and prompted.
  - Forbidden on rooms → remaining rooms dates skipped with the access text; kitchen still books.
  - Expired `response_url` (fetch `{ ok: false }`) → falls back to `postEphemeral`, no throw (Review Focus 4).
  - `finishBooking`'s existing tests still pass after extracting `memberClients`/`classifyWriteError`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run`).
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): reserve a whole tray in one press"`

---

### Task 11: Cancelling from the combined post, series and "mine"

**Files:**
- Create: `src/events/reservations-series.js`
- Modify: `src/events/reservations.js` (extract `cancelOne({ ref, user, clients }) -> { status, link, error? }` from `cancelBooking` and reuse it; route `POST_CANCEL_ACTION`, `SERIES_ALL_ACTION`, `SERIES_ONE_ACTION`, `MINE_SERIES_ACTION`; resume pending kind `series-cancel`; `listMine` merges series)
- Modify: `src/lib/reservation-mine.js` (series lines; `MINE_SERIES_ACTION = "reservation_mine_series"`)
- Modify: `src/lambda/oauthCallback.js` (`series-cancel` → "being cancelled now", as `cancel`)
- Test: `tests/events/reservations-series.test.js`, `tests/lib/reservation-mine.test.js`, `tests/events/reservations.test.js` (mine)

**Interfaces:**
- Consumes: Tasks 6, 8, `memberClients`, `promptConnect`, `hasEnded`.
- Produces: `createSeriesFlow({ adapters, ledger, connect, livingDigest, now, cancelOne, memberClients, promptConnect, hasEnded }) -> { handleAction({ payload, action, client }), resume(pending, client), ACTIONS: Set }`.

Behaviour:
- `POST_CANCEL_ACTION` single (`r` in value): only `u` may press (others get `Only <@u> can cancel this.` privately); `hasEnded` → private `That booking has already ended.`; else `cancelOne`; outcome `cancelled` → read the post (`conversations.history({ channel, latest: ts, inclusive: true, limit: 1 })`), `chat.update` with `markLineCancelled(post, i, "🚫 Cancelled by <@u>.")`, refresh digest; `already`/`changed` texts as `cancelBooking` gives them, privately.
- `POST_CANCEL_ACTION` series (`s` in value) and `MINE_SERIES_ACTION`: load the series via `ledger.seriesFor(u)`; gone or empty → private `That series has no dates left to cancel.`; else post `seriesChooser(...)` ephemerally (from the post: `chat.postEphemeral`; from "mine": replace the list via `response_url`).
- `SERIES_ALL_ACTION`: member clients as Book/Cancel do (unconnected → connect prompt, pending `{ kind: "series-cancel", user, seriesId, which: "all", channel, postTs }`); `cancelOne` for every not-ended ref (sequentially for sheets, at most 4 at a time for RMS); `dropSeriesRefs` for cancelled/already ones; update the post line `🚫 Series cancelled by <@u> (<n> dates).` (plus ` <k> couldn't be cancelled; check <link>.` when some were `changed`/errors); private summary; digest refreshed once per period.
- `SERIES_ONE_ACTION`: same for the one chosen date; post line gets `🚫 <fmtDay> cancelled.` appended (accessory kept while dates remain).
- `listMine`: series from `ledger.seriesFor` become one entry each (`📅 *<item>* · <repeatText> · <n> dates left · <range> · <title>`, button `Cancel…` with `MINE_SERIES_ACTION`, value `{"u","s"}`); their refs are excluded from the per-date entries; series entries come first and count toward the 20-line cap.

- [ ] **Step 1: Failing tests:** someone else pressing gets the private refusal; single-line cancel updates only that line of the post; series "Whole series" cancels the 3 remaining (not ended) refs, drops them from the ledger and marks the post line; "Just one date" cancels one and leaves the others; "mine" shows one line for a 14-date series and opens the chooser; an unconnected member with connect configured gets the prompt and `resume` finishes the cancel.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run`).
- [ ] **Step 5: Commit** — `git commit -m "feat(reservations): cancel a reserved line, a whole series, or one date"`

---

### Task 12: Docs

**Files:**
- Modify: `README.md` (reservations section), `docs/RUNBOOK.md`

- [ ] **Step 1:** README: how to browse ("list items to reserve"), search, the tray, repeats (weekly on chosen days, ≤ 6 months), Reserve all and the combined post, cancelling a series or one date. RUNBOOK: the tray row (`tray#<U>`, 24 h TTL), series in `bookings#<U>.series`, worker timeout 300 s / queue visibility 1800 s, what "may already be booked" means and how to check, the name change to "Reservations".
- [ ] **Step 2:** `npx vitest run` → PASS (nothing should change).
- [ ] **Step 3: Commit** — `git commit -m "docs(reservations): listing card, tray, repeats and series cancel"`
