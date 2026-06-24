# Resource "Last Used" Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the `#reservations` channel, answer "who/when was <resource> last used?" by reading the most recent event off that resource's Google Calendar, disambiguating the resource name against the real catalog when needed.

**Architecture:** Groq gains a `history` intent. A candidate matcher over the resource catalog resolves the phrase (0/1/many). `calendarService.lastEvent` returns the most recent event ≤ now. `reservationsService.resourceLastUsed` ties them together into a tagged result, and the ambient channel handler formats the reply (answer / no-usage / unknown / ambiguous-ask). Read-only.

**Tech Stack:** Node 22 ESM, Groq, Google Calendar v3 (`events.list`), Vitest.

## Global Constraints

- **Runtime:** Node 22 ESM. No new dependencies.
- **Channel-only:** handled in `handleChannelMessage` (the ambient `#reservations` path); NOT in `handleMention`/`handleSlash`.
- **Persona:** replies post as `username: "Reservations (beta)"`, `icon_emoji: ":calendar:"` (existing constants).
- **Answer = event title + when** (title already names who/what); do NOT report organizer.
- **Resolution outcomes:** 0 candidates → "I don't track…"; 1 → answer; 2+ → ask the user to choose from real resource names.
- **Read-only:** no calendar writes.
- **Calendar prerequisite is MET** (token has `calendar` scope + resource access; Calendar API enabled).
- **Tests:** Vitest, deps mocked, no real I/O. Run one file `npx vitest run <path>`; full suite `npm test`.
- **Spec:** `docs/superpowers/specs/2026-06-24-resource-last-used-design.md`.

---

## File Structure

- **Modify** `src/services/groq.js` — add `history` to the intent prompt. (+ test)
- **Modify** `src/lib/reservation-rooms.js` — add `matchAll` to `createRoomMatcher`. (+ test)
- **Modify** `src/services/calendar.js` — add `lastEvent`. (+ test)
- **Modify** `src/services/reservations.js` — add `resourceLastUsed`. (+ test)
- **Modify** `src/events/reservations.js` — handle `history` in `handleChannelMessage`. (+ test)

---

### Task 1: Groq `history` intent

**Files:**
- Modify: `src/services/groq.js`
- Test: `tests/services/groq.test.js`

**Interfaces:**
- Produces: `parseReservationRequest` may now return `{ intent: "history", target: "<resource phrase>", ... }` for "who/when/where was X last used".

- [ ] **Step 1: Write the test** (append in the `parseReservationRequest` area)

```javascript
  it("passes through a 'history' intent for last-used questions", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"history","target":"speaker set","date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("who used the speaker set last?", "2026-06-24T12:00:00Z");
    expect(out).toMatchObject({ intent: "history", target: "speaker set" });
  });
```

- [ ] **Step 2: Run** `npx vitest run tests/services/groq.test.js` — passes (parser passes JSON through; the substantive change is the prompt).

- [ ] **Step 3: Update `SYSTEM_PROMPT_RESERVATION` in `src/services/groq.js`**

Insert a `history` bullet into the intent list (between the `list` and `none` bullets) and add it to the leading sentence. The list currently has reserve/check/list/none; the new bullet:

```
- "history": the person asks who/when/where a resource was LAST used or who has it (e.g. "who used the speaker set last?", "when was Tech Set 1 last used?", "where's the popcorn machine?"). target is the resource name.
```

(Leave the reserve/check/list/none bullets and the date-resolution sentence unchanged.)

- [ ] **Step 4: Run** `npx vitest run tests/services/groq.test.js` then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/services/groq.js tests/services/groq.test.js
git commit -m "feat(reservations): groq 'history' intent for last-used questions"
```

---

### Task 2: `matchAll` candidate matcher

**Files:**
- Modify: `src/lib/reservation-rooms.js`
- Test: `tests/lib/reservation-rooms.test.js`

**Interfaces:**
- Produces: `createRoomMatcher(...)` now also returns `matchAll(query): string[]` — ALL catalog names the query could mean (exact name, exact alias, query-as-word-inside-a-name, and name-inside-query), de-duplicated; `[]` when nothing matches. `match` is unchanged.

- [ ] **Step 1: Write the test** (append to `tests/lib/reservation-rooms.test.js`)

```javascript
describe("createRoomMatcher.matchAll", () => {
  const matcher = createRoomMatcher(
    ["DMV Tech Equipment-G-Tech Set 1", "DMV Tech Equipment-G-Tech Set 2",
     "DMV Tech Equipment-G-Tech Set 3", "DMV Tech Equipment-G-Tech Set 4",
     "DMV Accessories-Popcorn Machine"],
    {}
  );
  it("returns all candidates for an ambiguous query", () => {
    expect(matcher.matchAll("tech set").sort()).toEqual([
      "DMV Tech Equipment-G-Tech Set 1", "DMV Tech Equipment-G-Tech Set 2",
      "DMV Tech Equipment-G-Tech Set 3", "DMV Tech Equipment-G-Tech Set 4",
    ]);
  });
  it("returns a single candidate when unambiguous", () => {
    expect(matcher.matchAll("popcorn")).toEqual(["DMV Accessories-Popcorn Machine"]);
    expect(matcher.matchAll("popcorn machine")).toEqual(["DMV Accessories-Popcorn Machine"]);
  });
  it("returns the exact match for a full name", () => {
    expect(matcher.matchAll("DMV Tech Equipment-G-Tech Set 2")).toEqual(["DMV Tech Equipment-G-Tech Set 2"]);
  });
  it("returns [] for an unrecognized query", () => {
    expect(matcher.matchAll("spaceship")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/reservation-rooms.test.js` — FAIL (`matchAll` not a function).

- [ ] **Step 3: Implement in `src/lib/reservation-rooms.js`**

Add a `matchAll` function inside the factory (after `match`), and return it. Reuse the same normalization and the regex-escape from `match`:

```javascript
  function matchAll(query) {
    const norm = normalizeLocation(query);
    if (!norm) return [];
    const out = new Set();
    if (canonByNorm.has(norm)) out.add(canonByNorm.get(norm));
    if (aliasByNorm.has(norm)) out.add(aliasByNorm.get(norm));
    const wordRe = new RegExp(`\\b${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const [key, canon] of canonByNorm) if (wordRe.test(key)) out.add(canon);
    for (const [key, canon] of aliasByNorm) if (wordRe.test(key)) out.add(canon);
    for (const [key, canon] of canonByNorm) if (norm.includes(key)) out.add(canon);
    for (const [key, canon] of aliasByNorm) if (norm.includes(key)) out.add(canon);
    return [...out];
  }
  return { match, matchAll };
```

- [ ] **Step 4: Run** `npx vitest run tests/lib/reservation-rooms.test.js` then `npm test` — all green (existing `match` tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-rooms.js tests/lib/reservation-rooms.test.js
git commit -m "feat(reservations): matchAll candidate matcher for resource disambiguation"
```

---

### Task 3: `calendarService.lastEvent`

**Files:**
- Modify: `src/services/calendar.js`
- Test: `tests/services/calendar.test.js`

**Interfaces:**
- Produces: `lastEvent(calendarId, { lookbackDays = 540 } = {}): Promise<{ summary, startIso, endIso } | null>` — the most recent event ≤ now within the lookback window (events.list ascending, take the last), or `null` when none.

- [ ] **Step 1: Write the test** (append to `tests/services/calendar.test.js`)

```javascript
  it("lastEvent returns the most recent event in the window", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [
      { summary: "Old", start: { dateTime: "2025-01-01T10:00:00Z" }, end: { dateTime: "2025-01-01T11:00:00Z" } },
      { summary: "Recent", start: { dateTime: "2025-08-29T18:00:00Z" }, end: { dateTime: "2025-08-29T20:00:00Z" } },
    ] } });
    const out = await service.lastEvent("cal1");
    expect(out).toEqual({ summary: "Recent", startIso: "2025-08-29T18:00:00Z", endIso: "2025-08-29T20:00:00Z" });
    const arg = mockCal.events.list.mock.calls[0][0];
    expect(arg).toMatchObject({ calendarId: "cal1", singleEvents: true, orderBy: "startTime" });
    expect(typeof arg.timeMin).toBe("string");
    expect(typeof arg.timeMax).toBe("string");
    expect(arg.timeMin < arg.timeMax).toBe(true);
  });

  it("lastEvent returns null when there are no events", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [] } });
    expect(await service.lastEvent("cal1")).toBeNull();
  });

  it("lastEvent handles all-day events (date instead of dateTime)", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [
      { summary: "Camp", start: { date: "2025-08-06" }, end: { date: "2025-08-07" } },
    ] } });
    expect(await service.lastEvent("cal1")).toEqual({ summary: "Camp", startIso: "2025-08-06", endIso: "2025-08-07" });
  });
```

- [ ] **Step 2: Run** `npx vitest run tests/services/calendar.test.js` — FAIL (`lastEvent` not a function).

- [ ] **Step 3: Implement in `src/services/calendar.js`**

Add the function and include it in the returned object:

```javascript
  async function lastEvent(calendarId, { lookbackDays = 540 } = {}) {
    const now = new Date();
    const timeMin = new Date(now.getTime() - lookbackDays * 86400000).toISOString();
    const res = await calendarClient.events.list({
      calendarId,
      timeMin,
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    const items = res.data.items || [];
    if (items.length === 0) return null;
    const e = items[items.length - 1];
    return {
      summary: e.summary || "",
      startIso: e.start?.dateTime || e.start?.date || "",
      endIso: e.end?.dateTime || e.end?.date || "",
    };
  }
```

Update the return statement to `return { listEvents, isBusy, insertEvent, lastEvent };`.

- [ ] **Step 4: Run** `npx vitest run tests/services/calendar.test.js` then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/services/calendar.js tests/services/calendar.test.js
git commit -m "feat(reservations): calendar.lastEvent (most recent past event)"
```

---

### Task 4: `reservationsService.resourceLastUsed`

**Files:**
- Modify: `src/services/reservations.js`
- Test: `tests/services/reservations.test.js`

**Interfaces:**
- Consumes: the internal `resourceMatcher` (now has `matchAll` from Task 2), injected `resourceCalendars`, `calendarService.lastEvent` (Task 3).
- Produces: `resourceLastUsed(query): Promise<Result>` where `Result` is one of:
  - `{ status: "unknown", query }`
  - `{ status: "ambiguous", candidates: string[] }`
  - `{ status: "ok", resourceName, lastUse: { summary, startIso, endIso } | null }`
  - `{ status: "error", resourceName }` (calendar read threw)

- [ ] **Step 1: Write the test** (append to `tests/services/reservations.test.js`)

```javascript
describe("resourceLastUsed", () => {
  function svc(lastEventImpl) {
    const calendarService = { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn(), lastEvent: vi.fn(lastEventImpl) };
    const resourceCalendars = {
      "DMV Tech Equipment-G-Tech Set 1": "c1",
      "DMV Tech Equipment-G-Tech Set 2": "c2",
      "DMV Tech Equipment-G-Tech Set 3": "c3",
      "DMV Tech Equipment-G-Tech Set 4": "c4",
      "DMV Accessories-Popcorn Machine": "cp",
    };
    const service = createReservationsService({
      sheetService: { listScheduleTabs: vi.fn(), readWeekEvents: vi.fn(), insertRow: vi.fn() },
      calendarService,
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars,
      now: () => new Date("2026-06-24T12:00:00Z"),
    });
    return { service, calendarService };
  }

  it("unknown when no resource matches", async () => {
    const { service } = svc();
    expect(await service.resourceLastUsed("spaceship")).toEqual({ status: "unknown", query: "spaceship" });
  });

  it("ambiguous when multiple resources match", async () => {
    const { service } = svc();
    const r = await service.resourceLastUsed("tech set");
    expect(r.status).toBe("ambiguous");
    expect(r.candidates).toHaveLength(4);
  });

  it("ok with last use for a single match", async () => {
    const last = { summary: "Halloween Fest", startIso: "2024-10-31T14:00:00Z", endIso: "2024-10-31T16:00:00Z" };
    const { service, calendarService } = svc(async () => last);
    const r = await service.resourceLastUsed("popcorn machine");
    expect(r).toEqual({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: last });
    expect(calendarService.lastEvent).toHaveBeenCalledWith("cp");
  });

  it("ok with null lastUse when the calendar has no events", async () => {
    const { service } = svc(async () => null);
    const r = await service.resourceLastUsed("popcorn machine");
    expect(r).toEqual({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: null });
  });

  it("error when the calendar read throws", async () => {
    const { service } = svc(async () => { throw new Error("boom"); });
    const r = await service.resourceLastUsed("popcorn machine");
    expect(r).toEqual({ status: "error", resourceName: "DMV Accessories-Popcorn Machine" });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/services/reservations.test.js` — FAIL (`resourceLastUsed` not a function).

- [ ] **Step 3: Implement in `src/services/reservations.js`**

Add the method inside the factory (e.g. after `listReservations`):

```javascript
  async function resourceLastUsed(query) {
    const candidates = resourceMatcher.matchAll(query);
    if (candidates.length === 0) return { status: "unknown", query };
    if (candidates.length > 1) return { status: "ambiguous", candidates };
    const resourceName = candidates[0];
    const calendarId = resourceCalendars[resourceName];
    if (!calendarId) return { status: "unknown", query };
    try {
      const lastUse = await calendarService.lastEvent(calendarId);
      return { status: "ok", resourceName, lastUse };
    } catch {
      return { status: "error", resourceName };
    }
  }
```

Add `resourceLastUsed` to the returned object (the `return { classifyTarget, checkRoom, makeRoomReservation, listRoom, listReservations }` line).

- [ ] **Step 4: Run** `npx vitest run tests/services/reservations.test.js` then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/services/reservations.js tests/services/reservations.test.js
git commit -m "feat(reservations): resourceLastUsed (resolve + read resource history)"
```

---

### Task 5: Handle `history` in the ambient channel

**Files:**
- Modify: `src/events/reservations.js`
- Test: `tests/events/reservations.test.js`

**Interfaces:**
- Consumes: `reservationsService.resourceLastUsed` (Task 4); `parseReservationRequest` returning `intent: "history"` (Task 1).
- Produces: `handleChannelMessage` answers `history` requests and formats each result kind.

- [ ] **Step 1: Write the test** (append to the `handleChannelMessage` describe in `tests/events/reservations.test.js`)

```javascript
  it("answers a history request with the last-used event", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "popcorn machine" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({
      status: "ok", resourceName: "DMV Accessories-Popcorn Machine",
      lastUse: { summary: "Halloween Fest", startIso: "2024-10-31T14:00:00Z", endIso: "2024-10-31T16:00:00Z" },
    });
    await handler.handleChannelMessage({ event: msg({ text: "when was the popcorn machine last used" }), client });
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "Cres", thread_ts: "100.1", username: "Reservations (beta)" });
    expect(arg.text).toContain("Popcorn Machine");
    expect(arg.text).toContain("last used");
    expect(arg.text).toContain("Halloween Fest");
  });

  it("asks which resource when the history query is ambiguous", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "tech set" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({
      status: "ambiguous",
      candidates: ["DMV Tech Equipment-G-Tech Set 1", "DMV Tech Equipment-G-Tech Set 2"],
    });
    await handler.handleChannelMessage({ event: msg({ text: "who used the tech set last" }), client });
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text.toLowerCase()).toContain("which");
    expect(text).toContain("Tech Set 1");
    expect(text).toContain("Tech Set 2");
  });

  it("says it doesn't track an unknown resource", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "spaceship" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({ status: "unknown", query: "spaceship" });
    await handler.handleChannelMessage({ event: msg({ text: "who used the spaceship last" }), client });
    expect(client.chat.postMessage.mock.calls[0][0].text.toLowerCase()).toContain("don't track");
  });

  it("reports no recorded usage when the resource has no events", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "popcorn machine" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: null });
    await handler.handleChannelMessage({ event: msg({ text: "when was the popcorn machine last used" }), client });
    expect(client.chat.postMessage.mock.calls[0][0].text.toLowerCase()).toContain("no recorded usage");
  });
```

(If the `handleChannelMessage` describe's `reservationsService` mock object doesn't already include `resourceLastUsed`, these tests set it per-case via `vi.fn()` as shown — no beforeEach change required.)

- [ ] **Step 2: Run** `npx vitest run tests/events/reservations.test.js` — FAIL (history not handled; no postMessage / wrong text).

- [ ] **Step 3: Implement in `src/events/reservations.js`**

Add helpers near the top (after the existing `WEEKDAYS` / `fmtListDate`):

```javascript
function resourceLabel(title) {
  return String(title).replace(/^\(vehicle\)-/, "").replace(/^DMV [^-]*-(?:G-)?/, "").trim();
}
function fmtFullDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function historyText(res) {
  if (res.status === "unknown") return `I don't track a resource called "${res.query}".`;
  if (res.status === "ambiguous") return `Which one did you mean: ${res.candidates.map(resourceLabel).join(", ")}?`;
  if (res.status === "error") return `Couldn't reach the calendar for ${resourceLabel(res.resourceName)} right now.`;
  if (!res.lastUse) return `No recorded usage for ${resourceLabel(res.resourceName)}.`;
  return `${resourceLabel(res.resourceName)} was last used ${fmtFullDate(res.lastUse.startIso)} — ${res.lastUse.summary}.`;
}
```

In `handleChannelMessage`, add a `history` branch immediately after the `none`/null guard and the `say` definition, before the `list` branch:

```javascript
    if (parsed.intent === "history") {
      const res = await reservationsService.resourceLastUsed(parsed.target || "");
      await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI, text: historyText(res) });
      return;
    }
```

- [ ] **Step 4: Run** `npx vitest run tests/events/reservations.test.js` then `npm test` — all green (existing handler tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/events/reservations.js tests/events/reservations.test.js
git commit -m "feat(reservations): answer resource last-used history in the channel"
```

---

## Final verification

- [ ] `npm test` — every suite passes.
- [ ] Smoke test in `#reservations`: "who used the popcorn machine last", "who used the tech set last" (→ asks which), "where's the spaceship" (→ don't track).

## Self-Review (against the spec)

- **history intent**: Task 1. ✓
- **candidate matcher / disambiguation (0/1/many)**: Task 2 `matchAll` + Task 4 status + Task 5 reply. ✓
- **read most recent event, title + when**: Task 3 `lastEvent` + Task 5 `fmtFullDate`/title. ✓
- **unknown / no-usage / error messages**: Task 4 statuses + Task 5 `historyText`. ✓
- **channel-only (not mention/slash)**: Task 5 branch is in `handleChannelMessage`. ✓
- **threaded disambiguation reply re-resolves**: reuses the existing thread-combine in `handleChannelMessage` (the user's reply re-enters, re-parses → history again). ✓
- **read-only**: no writes added. ✓
