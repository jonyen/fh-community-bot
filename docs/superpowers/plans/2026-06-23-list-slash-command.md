# `/list` Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/list` Slack slash command that lists OneStop-sheet room reservations over a date window parsed from natural language (optional room + optional date).

**Architecture:** A new orchestration method `listReservations({room, fromIso, toIso})` (window-filtered, sheet-only, optional room) feeds a new `/list` branch in the reservation slash handler; `dispatch.js` routes `/list` to it. The existing per-room `listRoom` is reimplemented in terms of `listReservations` (fixing a latent whole-tab bug).

**Tech Stack:** Node 22 ESM, Vitest. Existing reservations feature (Groq parser, sheet service, dispatch/receiver).

## Global Constraints

- **Runtime:** Node 22 ESM (`"type": "module"`). No new dependencies.
- **Reply persona:** slash replies post ephemerally as `username: "Reservations (beta)"` with `icon_emoji: ":calendar:"` (constants already in `src/events/reservations.js`).
- **Scope:** OneStop master sheet only — no resource/venue calendar reads.
- **Window:** explicit `date` → that single day; no date → today through today + 7 days.
- **Date ISO format:** `YYYY-MM-DD` (zero-padded), comparable as strings.
- **Tests:** Vitest, deps mocked, no real I/O. Run one file: `npx vitest run <path>`; full suite `npm test`.
- **Spec:** `docs/superpowers/specs/2026-06-23-list-slash-command-design.md`.

---

## File Structure

- **Modify** `src/services/reservations.js` — add `listReservations`; reimplement `listRoom` via it. (+ `tests/services/reservations.test.js`)
- **Modify** `src/events/reservations.js` — `/list` handler path (window calc, all-rooms, formatting). (+ `tests/events/reservations.test.js`)
- **Modify** `src/lambda/dispatch.js` — route `/list` to `reservationHandler.handleSlash`. (+ `tests/lambda/dispatch.test.js`)

---

### Task 1: `listReservations` orchestration method

**Files:**
- Modify: `src/services/reservations.js`
- Test: `tests/services/reservations.test.js`

**Interfaces:**
- Consumes: existing deps (`sheetService.listScheduleTabs`/`readWeekEvents`, `roomMatcher.match`, `selectTabForDate`, `formatMinutes`, `inferYear`, `now`).
- Produces:
  - `listReservations({ room = null, fromIso, toIso }): Promise<Array<{ dateIso, startTime, endTime, location, what }>>` — events whose date is within `[fromIso, toIso]` (inclusive), filtered to `room` (canonical name) when given, else all rooms; sorted by date then start time. Sheet-only; tabs read once each.
  - `listRoom` keeps its existing shape `Array<{ dateIso, startTime, endTime, what }>` but now delegates to `listReservations` (so it is window-filtered).

- [ ] **Step 1: Write the failing tests** (append to `tests/services/reservations.test.js`)

```javascript
describe("listReservations", () => {
  function svc(tabs, eventsByTab) {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(tabs),
      readWeekEvents: vi.fn(async (tab) => eventsByTab[tab] || []),
      insertRow: vi.fn(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
      roomMatcher: createRoomMatcher(["FH MPR", "Childcare Room"], {}),
      resourceCalendars: {},
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    return { service, sheetService };
  }

  it("lists all rooms in a single-day window, only that day's events", async () => {
    const { service } = svc(["6/22-6/26 M-F"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "AM" },
        { rowIndex: 2, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 19 * 60, allDay: false, location: "Childcare Room", what: "PM" },
        { rowIndex: 3, date: { month: 6, day: 25 }, startMin: 9 * 60, endMin: 10 * 60, allDay: false, location: "FH MPR", what: "NextDay" },
      ],
    });
    const out = await service.listReservations({ fromIso: "2026-06-24", toIso: "2026-06-24" });
    expect(out.map((i) => i.what)).toEqual(["AM", "PM"]); // 6/25 excluded; sorted by start
    expect(out[0]).toMatchObject({ dateIso: "2026-06-24", startTime: "10:00 AM", location: "FH MPR" });
  });

  it("filters to a single room across the window", async () => {
    const { service } = svc(["6/22-6/26 M-F"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "MPR-AM" },
        { rowIndex: 2, date: { month: 6, day: 25 }, startMin: 18 * 60, endMin: 19 * 60, allDay: false, location: "Childcare Room", what: "CC" },
      ],
    });
    const out = await service.listReservations({ room: "FH MPR", fromIso: "2026-06-24", toIso: "2026-06-26" });
    expect(out.map((i) => i.what)).toEqual(["MPR-AM"]);
  });

  it("reads each tab once across a multi-tab window and sorts by date then start", async () => {
    const { service, sheetService } = svc(["6/22-6/26 M-F", "6/27-6/28 S-Su"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 26 }, startMin: 20 * 60, endMin: 21 * 60, allDay: false, location: "FH MPR", what: "Fri-PM" },
        { rowIndex: 2, date: { month: 6, day: 26 }, startMin: 7 * 60, endMin: 8 * 60, allDay: false, location: "FH MPR", what: "Fri-AM" },
      ],
      "6/27-6/28 S-Su": [
        { rowIndex: 1, date: { month: 6, day: 27 }, startMin: 9 * 60, endMin: 10 * 60, allDay: false, location: "Childcare Room", what: "Sat" },
      ],
    });
    const out = await service.listReservations({ fromIso: "2026-06-26", toIso: "2026-06-28" });
    expect(out.map((i) => i.what)).toEqual(["Fri-AM", "Fri-PM", "Sat"]);
    expect(sheetService.readWeekEvents).toHaveBeenCalledTimes(2); // each tab read once (dedup)
  });

  it("returns empty array when nothing falls in the window", async () => {
    const { service } = svc(["6/22-6/26 M-F"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "AM" },
      ],
    });
    const out = await service.listReservations({ fromIso: "2026-06-30", toIso: "2026-07-01" });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/reservations.test.js`
Expected: FAIL — `service.listReservations is not a function`.

- [ ] **Step 3: Implement `listReservations` and re-point `listRoom`**

In `src/services/reservations.js`, replace the existing `listRoom` function (lines ~108–136) with the two functions below, and add `listReservations` to the returned object.

```javascript
  async function listReservations({ room = null, fromIso, toIso }) {
    const from = new Date(`${fromIso}T00:00:00Z`);
    const to = new Date(`${toIso}T00:00:00Z`);
    const tabs = await sheetService.listScheduleTabs();
    const seenTabs = new Set();
    const out = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
      const day = new Date(t);
      const tab = selectTabForDate(tabs, day);
      if (!tab || seenTabs.has(tab)) continue;
      seenTabs.add(tab);
      const events = await sheetService.readWeekEvents(tab);
      for (const e of events) {
        if (!e.date) continue;
        const year = inferYear(e.date.month, e.date.day, now());
        const dateIso = `${year}-${String(e.date.month).padStart(2, "0")}-${String(e.date.day).padStart(2, "0")}`;
        if (dateIso < fromIso || dateIso > toIso) continue; // window filter (zero-padded ISO compares lexically)
        if (room && roomMatcher.match(e.location) !== room) continue;
        out.push({
          dateIso,
          startTime: e.startMin !== null ? formatMinutes(e.startMin) : "",
          endTime: e.endMin !== null ? formatMinutes(e.endMin) : "",
          location: e.location,
          what: e.what,
          _startMin: e.startMin ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }
    out.sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : a._startMin - b._startMin));
    return out.map(({ _startMin, ...item }) => item);
  }

  async function listRoom({ room, fromIso, toIso }) {
    const items = await listReservations({ room, fromIso, toIso });
    return items.map(({ dateIso, startTime, endTime, what }) => ({ dateIso, startTime, endTime, what }));
  }
```

Update the return statement at the bottom of the factory:

```javascript
  return { classifyTarget, checkRoom, makeRoomReservation, listRoom, listReservations };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/reservations.test.js`
Expected: PASS — new `listReservations` cases green AND the existing `listRoom` test still green (it now flows through `listReservations`).

- [ ] **Step 5: Commit**

```bash
git add src/services/reservations.js tests/services/reservations.test.js
git commit -m "feat(reservations): listReservations (window-filtered, optional room)"
```

---

### Task 2: `/list` slash handler + dispatch routing

**Files:**
- Modify: `src/events/reservations.js`
- Modify: `src/lambda/dispatch.js`
- Test: `tests/events/reservations.test.js`, `tests/lambda/dispatch.test.js`

**Interfaces:**
- Consumes: `reservationsService.listReservations` + `classifyTarget` (Task 1); `groqService.parseReservationRequest`; `now`.
- Produces: `handleSlash` handles `envelope.command === "/list"` via a new `replyForList`; `dispatchSlackEvent` routes `/list` to `reservationHandler.handleSlash`.

- [ ] **Step 1: Write the failing handler tests** (append to `tests/events/reservations.test.js`)

```javascript
describe("ReservationHandler.handleSlash /list", () => {
  let reservationsService, groqService, client, handler;
  beforeEach(() => {
    reservationsService = {
      classifyTarget: vi.fn(),
      listReservations: vi.fn(),
    };
    groqService = { parseReservationRequest: vi.fn() };
    client = { chat: { postEphemeral: vi.fn().mockResolvedValue({}) } };
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-23T12:00:00Z") });
  });
  const envelope = (text) => ({ command: "/list", text, channel_id: "C1", user_id: "U1" });

  it("lists all rooms for an explicit date, ephemeral, as Reservations (beta)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "1:00 PM", endTime: "2:00 PM", location: "FH MPR", what: "Worktime" },
    ]);
    await handler.handleSlash({ envelope: envelope("all reservations tomorrow"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-24", toIso: "2026-06-24" });
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "C1", user: "U1", username: "Reservations (beta)" });
    expect(arg.text).toContain("FH MPR");
    expect(arg.text).toContain("Worktime");
  });

  it("defaults to a 7-day window when no date is given", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: "MPR", date: null });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleSlash({ envelope: envelope("reservations for MPR"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: "FH MPR", fromIso: "2026-06-23", toIso: "2026-06-30" });
    expect(client.chat.postEphemeral.mock.calls[0][0].text.toLowerCase()).toContain("no reservations");
  });

  it("lists all rooms and notes when the room phrase is unrecognized", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: "the spaceship", date: "2026-06-24" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "unmanaged", name: "the spaceship" });
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleSlash({ envelope: envelope("reservations for the spaceship tomorrow"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-24", toIso: "2026-06-24" });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain("couldn't match");
  });

  it("treats a null parse as 'list everything in the default window'", async () => {
    groqService.parseReservationRequest.mockResolvedValue(null);
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleSlash({ envelope: envelope("???"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-23", toIso: "2026-06-30" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: FAIL — `/list` not handled; `postEphemeral` not called as asserted.

- [ ] **Step 3: Implement the `/list` path in `src/events/reservations.js`**

Add these helpers near the top, after the `BOT_ICON_EMOJI` constant:

```javascript
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function fmtListDate(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
```

Add `replyForList` inside the factory (e.g. just before `handleMention`):

```javascript
  async function replyForList(parsed, say) {
    const ref = now();
    const fromIso = (parsed && parsed.date) || isoDate(ref);
    const toIso = (parsed && parsed.date) || isoDate(addDays(ref, 7));
    let room = null;
    let note = "";
    if (parsed && parsed.target) {
      const t = reservationsService.classifyTarget(parsed.target);
      if (t.kind === "room") room = t.name;
      else note = ` (couldn't match "${parsed.target}" to a room — showing all)`;
    }
    const items = await reservationsService.listReservations({ room, fromIso, toIso });
    const scope = room || "all rooms";
    const window = fromIso === toIso ? fromIso : `${fromIso} … ${toIso}`;
    if (!items.length) {
      await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: `No reservations found for ${scope}, ${window}.${note}` });
      return;
    }
    const lines = items
      .map((i) => `• ${fmtListDate(i.dateIso)} ${i.startTime}–${i.endTime} — ${i.location} — ${i.what}`)
      .join("\n");
    await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
      text: `Reservations for ${scope}, ${window}:${note}\n${lines}` });
  }
```

Update `handleSlash` to branch on the command:

```javascript
  async function handleSlash({ envelope, client }) {
    const refIso = now().toISOString();
    const parsed = await groqService.parseReservationRequest(envelope.text || "", refIso);
    const say = (msg) => client.chat.postEphemeral({
      channel: envelope.channel_id, user: envelope.user_id, ...msg,
    });
    if (envelope.command === "/list") {
      await replyForList(parsed, say);
      return;
    }
    await replyForParsed(parsed, say, undefined);
  }
```

- [ ] **Step 4: Run handler tests to verify they pass**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: PASS (existing handler tests still green).

- [ ] **Step 5: Write the failing dispatch test** (append to `tests/lambda/dispatch.test.js`, inside the existing `describe("dispatchSlackEvent reservation routing", ...)` block or a new one)

```javascript
  it("routes /list to the reservation handler", async () => {
    const reservationHandler = { handleMention: vi.fn(), handleSlash: vi.fn().mockResolvedValue() };
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/list", text: "all reservations tomorrow" },
      reservationHandler, client: client(),
    });
    expect(reservationHandler.handleSlash).toHaveBeenCalled();
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: FAIL — `/list` not routed (`handleSlash` not called).

- [ ] **Step 7: Route `/list` in `src/lambda/dispatch.js`**

Find the slash-command branch and add `/list` to the reservation condition:

```javascript
    } else if (
      reservationHandler &&
      (slackEnvelope.command === "/reserve" ||
        slackEnvelope.command === "/check" ||
        slackEnvelope.command === "/list")
    ) {
      await reservationHandler.handleSlash({ envelope: slackEnvelope, client });
    }
```

- [ ] **Step 8: Run dispatch test + full suite**

Run: `npx vitest run tests/lambda/dispatch.test.js` → PASS.
Run: `npm test` → all suites green.

- [ ] **Step 9: Commit**

```bash
git add src/events/reservations.js src/lambda/dispatch.js tests/events/reservations.test.js tests/lambda/dispatch.test.js
git commit -m "feat(reservations): /list slash command (NL room + date window)"
```

---

### Task 3: Broadcast successful `/reserve` room reservations to the channel

**Context (added requirement, user decision):** When a **room reservation succeeds via the `/reserve` slash command**, announce it with a **public** `chat.postMessage` to the **same channel** the command was issued in (`envelope.channel_id`), mentioning the requester. All other cases stay as-is: a `/reserve` conflict/failure replies **ephemerally** (private); `/check` and `/list` stay ephemeral; `@mention` reservations keep their current in-channel/thread reply (no change — mentions are already public). Only the `/reserve` success path changes from ephemeral to a public broadcast.

**Files:**
- Modify: `src/events/reservations.js`
- Test: `tests/events/reservations.test.js`

**Interfaces:**
- `replyForParsed` gains an optional 4th arg `opts = {}` with `{ broadcast, requester }`. When the room **reserve** path succeeds and `opts.broadcast` is provided, the success message is sent via `opts.broadcast` (public) instead of `say` (ephemeral); on failure it still uses `say`. `opts.requester` (a Slack user id) is prefixed as `<@id>` in the success text when present.
- `handleSlash` passes `opts` only for `/reserve`: `broadcast = (msg) => client.chat.postMessage({ channel: envelope.channel_id, ...msg })` and `requester = envelope.user_id`.

- [ ] **Step 1: Write the failing tests** (append to `tests/events/reservations.test.js`)

```javascript
describe("ReservationHandler /reserve broadcast", () => {
  let reservationsService, groqService, client, handler;
  beforeEach(() => {
    reservationsService = { classifyTarget: vi.fn(), makeRoomReservation: vi.fn() };
    groqService = { parseReservationRequest: vi.fn() };
    client = { chat: { postEphemeral: vi.fn().mockResolvedValue({}), postMessage: vi.fn().mockResolvedValue({}) } };
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-23T12:00:00Z") });
  });
  const env = (text) => ({ command: "/reserve", text, channel_id: "C1", user_id: "U1" });

  it("broadcasts publicly to the channel on a successful /reserve", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.makeRoomReservation.mockResolvedValue({ ok: true, mirrored: true });
    await handler.handleSlash({ envelope: env("reserve MPR friday 7-10pm for practice"), client });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "C1", username: "Reservations (beta)" });
    expect(arg.text).toContain("<@U1>");
    expect(arg.text).toContain("FH MPR");
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("keeps a /reserve conflict ephemeral (no broadcast)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.makeRoomReservation.mockResolvedValue({ ok: false, reason: "conflict", conflicts: [{ what: "Meeting" }] });
    await handler.handleSlash({ envelope: env("reserve MPR friday 7-10pm"), client });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral.mock.calls[0][0].text.toLowerCase()).toContain("conflict");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: FAIL — `postMessage` not called (success still ephemeral).

- [ ] **Step 3: Implement in `src/events/reservations.js`**

Change the `replyForParsed` signature and the room **reserve** branch. Replace the existing reserve branch (the `if (parsed.intent === "reserve") { ... }` block inside the room branch) with this, and update the function signature:

```javascript
  async function replyForParsed(parsed, say, thread_ts, opts = {}) {
```

Reserve branch (inside `if (target.kind === "room")`):

```javascript
      if (parsed.intent === "reserve") {
        const res = await reservationsService.makeRoomReservation({
          room: target.name, dateIso: parsed.date, startTime: parsed.startTime, endTime: parsed.endTime,
          what: parsed.what, who: parsed.who,
        });
        if (res.ok) {
          const who = opts.requester ? `<@${opts.requester}> ` : "";
          const purpose = parsed.what ? ` for ${parsed.what}` : "";
          const msg = {
            username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
            text: `${who}reserved ${target.name} on ${parsed.date} ${parsed.startTime}–${parsed.endTime}${purpose}.`,
          };
          if (opts.broadcast) await opts.broadcast(msg);
          else await say({ thread_ts, ...msg });
        } else {
          await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
            text: res.reason === "conflict"
              ? `Can't book — conflict on ${target.name}:\n${conflictText(res.conflicts)}`
              : `Can't book: ${res.reason}.` });
        }
        return;
      }
```

Update `handleSlash` to pass `opts` for `/reserve` (keep the `/list` branch from Task 2):

```javascript
  async function handleSlash({ envelope, client }) {
    const refIso = now().toISOString();
    const parsed = await groqService.parseReservationRequest(envelope.text || "", refIso);
    const say = (msg) => client.chat.postEphemeral({
      channel: envelope.channel_id, user: envelope.user_id, ...msg,
    });
    if (envelope.command === "/list") {
      await replyForList(parsed, say);
      return;
    }
    const opts = envelope.command === "/reserve"
      ? { broadcast: (msg) => client.chat.postMessage({ channel: envelope.channel_id, ...msg }), requester: envelope.user_id }
      : {};
    await replyForParsed(parsed, say, undefined, opts);
  }
```

`handleMention` is unchanged — it calls `replyForParsed(parsed, say, thread_ts)` with no `opts`, so mention reservations keep posting via `say` (already in-channel/thread).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: PASS (existing handler + Task 2 `/list` tests still green). Then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/events/reservations.js tests/events/reservations.test.js
git commit -m "feat(reservations): broadcast successful /reserve to the channel"
```

---

## Final verification

- [ ] `npm test` — every suite passes.
- [ ] Register `/list` in the Slack app (Slash Commands → Request URL = receiver Function URL), same as `/reserve` / `/check`.

## Self-Review (against the spec)

- **`/list` command + ephemeral reply**: Task 2 (`handleSlash` `/list` branch, `postEphemeral`, persona). ✓
- **NL room + date via Groq**: reuses `parseReservationRequest`; handler reads `target`/`date`. ✓
- **Window (explicit day vs 7-day default)**: `replyForList` window calc; tests assert both. ✓
- **Sheet-only**: `listReservations` reads only `sheetService`; no calendar reads. ✓
- **All-rooms vs room filter + unrecognized-room note**: Task 2 tests cover null target, matched room, unmanaged. ✓
- **Sorted by date+start, tab dedup, window filter**: Task 1 (`listReservations` sort + `seenTabs` + ISO window filter); tests cover multi-tab + out-of-window exclusion. ✓
- **dispatch routing**: Task 2 dispatch test. ✓
- **Empty-result message**: Task 2 (`No reservations found …`). ✓
- **Limitation (multi-day NL windows)**: out of scope by design; single-date + 7-day default only — matches spec Non-goals/Limitations. ✓
