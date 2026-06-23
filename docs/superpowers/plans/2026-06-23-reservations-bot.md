# Reservations Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add room (Google Sheet) and resource (Google Calendar) reservation check/list/make to the existing `fh-community-bot` Slack app.

**Architecture:** Pure parsing/logic libraries (`src/lib/reservation-*.js`) are composed by a `reservations` orchestration service and exposed through a Slack handler wired into the existing receiver → SQS → worker → dispatch flow. Reads hit the OneStop sheet + Google Calendars; writes go to the sheet (rooms) or a calendar (resources). Conflicts are reject-only.

**Tech Stack:** Node 22 ESM, `googleapis` (Sheets v4 + Calendar v3), `openai` SDK against Groq, Vitest, AWS SAM.

## Global Constraints

- **Runtime:** Node 22 ESM (`"type": "module"`), arm64 Lambda. Copied verbatim from `package.json` / `template.yaml`.
- **No new dependencies.** `googleapis` already present (add Calendar usage only).
- **Service shape:** every service is a factory `createXService(deps)` returning a methods object (matches `src/services/*.js`).
- **Pure libs:** files under `src/lib/` are pure functions, no I/O, no `Date.now()` reliance except via an injected `now`/reference date argument.
- **Tests:** Vitest, `import { describe, it, expect, vi, beforeEach } from "vitest";`, files under `tests/<mirror>/<name>.test.js`. Run with `npm test`.
- **Reject-only conflicts:** a detected conflict means NO write and a reply listing the conflict. Never suggest alternatives.
- **Handler gating:** the reservation handler is wired only when `RESERVATIONS_SHEET_ID` is set (mirrors gender gating on `GENDER_SHEET_ID` in `src/lambda/clients.js`).
- **Slack reply persona:** reservation replies post with `username: "Reservations (beta)"` — the Slack app name carries a "(beta)" suffix (the maintenance handler posts as `"FH Maintenance (beta)"`), so the reservations persona matches.
- **Source of truth:** spec `docs/superpowers/specs/2026-06-23-reservations-bot-design.md`.

---

## File Structure

**Create (pure libs):**
- `src/lib/reservation-time.js` — parse/format dates & times, year inference, all-day detection.
- `src/lib/reservation-tabs.js` — parse week-tab names, select the tab for a date.
- `src/lib/reservation-rooms.js` — normalize a LOCATION, match to a canonical room.
- `src/lib/reservation-overlap.js` — interval overlap + room conflict detection.
- `src/lib/reservation-triggers.js` — `matchesReservationIntent(text)` regex pre-filter.

**Create (services):**
- `src/services/reservationsSheet.js` — read schedule tabs / week rows, insert a room row.
- `src/services/calendar.js` — Calendar v3 wrapper (list, freeBusy, insert).
- `src/services/reservations.js` — orchestration: classify, check, list, make, format reply.

**Create (event handler):**
- `src/events/reservations.js` — handles `/reserve`, `/check`, and reservation `@mention`s.

**Modify (wiring):**
- `src/services/groq.js` — add `parseReservationRequest(text, referenceDateIso)`.
- `src/lambda/dispatch.js` — route reservation slash commands + mentions.
- `src/lambda/worker.js` — pass `reservationHandler` through.
- `src/lambda/receiver.js` — enqueue reservation-intent messages + the new slash commands.
- `src/lambda/clients.js` — construct calendar client + services, gate on config.
- `src/config.js` — load new env vars.
- `template.yaml` + `.env.example` — declare new env vars.

**Tests:** one `*.test.js` mirroring each created/modified source file.

---

### Task 1: Date & time parsing library

**Files:**
- Create: `src/lib/reservation-time.js`
- Test: `tests/lib/reservation-time.test.js`

**Interfaces:**
- Produces:
  - `parseTimeToMinutes(str): number | null` — `"9:00 PM"` → `1260`; blank/garbage → `null`.
  - `formatMinutes(min): string` — `1260` → `"9:00 PM"`.
  - `parseMonthDay(str): {month:number, day:number} | null` — `"6/22 Mon"` → `{month:6, day:22}`.
  - `inferYear(month, day, referenceDate): number` — nearest year to `referenceDate` (a `Date`).
  - `isAllDay(startMin, endMin): boolean` — true for `0` and `1439`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/reservation-time.test.js
import { describe, it, expect } from "vitest";
import {
  parseTimeToMinutes,
  formatMinutes,
  parseMonthDay,
  inferYear,
  isAllDay,
} from "../../src/lib/reservation-time.js";

describe("parseTimeToMinutes", () => {
  it("parses PM times", () => expect(parseTimeToMinutes("9:00 PM")).toBe(21 * 60));
  it("parses AM times", () => expect(parseTimeToMinutes("12:30 AM")).toBe(30));
  it("parses noon", () => expect(parseTimeToMinutes("12:00 PM")).toBe(12 * 60));
  it("tolerates surrounding whitespace/newlines", () =>
    expect(parseTimeToMinutes(" 5:00 PM\n")).toBe(17 * 60));
  it("returns null for blank", () => expect(parseTimeToMinutes("")).toBeNull());
  it("returns null for garbage", () => expect(parseTimeToMinutes("c")).toBeNull());
});

describe("formatMinutes", () => {
  it("formats PM", () => expect(formatMinutes(21 * 60)).toBe("9:00 PM"));
  it("formats midnight", () => expect(formatMinutes(0)).toBe("12:00 AM"));
});

describe("parseMonthDay", () => {
  it("parses date+weekday", () => expect(parseMonthDay("6/22 Mon")).toEqual({ month: 6, day: 22 }));
  it("parses without weekday", () => expect(parseMonthDay("12/3")).toEqual({ month: 12, day: 3 }));
  it("returns null for blank", () => expect(parseMonthDay("")).toBeNull());
});

describe("inferYear", () => {
  it("uses same year when close", () =>
    expect(inferYear(6, 22, new Date("2026-06-20T00:00:00Z"))).toBe(2026));
  it("rolls to next year across Dec->Jan boundary", () =>
    expect(inferYear(1, 2, new Date("2026-12-30T00:00:00Z"))).toBe(2027));
  it("rolls to previous year across Jan->Dec boundary", () =>
    expect(inferYear(12, 30, new Date("2027-01-02T00:00:00Z"))).toBe(2026));
});

describe("isAllDay", () => {
  it("detects all-day", () => expect(isAllDay(0, 23 * 60 + 59)).toBe(true));
  it("rejects partial", () => expect(isAllDay(17 * 60, 19 * 60)).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/reservation-time.test.js`
Expected: FAIL — "Failed to resolve import ... reservation-time.js".

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/reservation-time.js
export function parseTimeToMinutes(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  const min = Number(m[2]);
  if (m[3].toLowerCase() === "pm") hour += 12;
  return hour * 60 + min;
}

export function formatMinutes(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function parseMonthDay(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]) };
}

export function inferYear(month, day, referenceDate) {
  const refYear = referenceDate.getUTCFullYear();
  const candidates = [refYear - 1, refYear, refYear + 1];
  let best = refYear;
  let bestDist = Infinity;
  for (const y of candidates) {
    const d = Date.UTC(y, month - 1, day);
    const dist = Math.abs(d - referenceDate.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

export function isAllDay(startMin, endMin) {
  return startMin === 0 && endMin === 23 * 60 + 59;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/reservation-time.test.js`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-time.js tests/lib/reservation-time.test.js
git commit -m "feat(reservations): date/time parsing library"
```

---

### Task 2: Week-tab name parsing & selection

**Files:**
- Create: `src/lib/reservation-tabs.js`
- Test: `tests/lib/reservation-tabs.test.js`

**Interfaces:**
- Consumes: `inferYear` from `src/lib/reservation-time.js`.
- Produces:
  - `parseTabName(name): {start:{month,day}, end:{month,day}, kind:"M-F"|"S-Su"} | null`.
  - `isScheduleTab(name): boolean`.
  - `selectTabForDate(tabNames, date): string | null` — `date` is a JS `Date`; returns the matching tab name.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/reservation-tabs.test.js
import { describe, it, expect } from "vitest";
import { parseTabName, isScheduleTab, selectTabForDate } from "../../src/lib/reservation-tabs.js";

describe("parseTabName", () => {
  it("parses a weekday tab", () =>
    expect(parseTabName("6/22-6/26 M-F")).toEqual({
      start: { month: 6, day: 22 }, end: { month: 6, day: 26 }, kind: "M-F",
    }));
  it("parses a weekend tab", () =>
    expect(parseTabName("6/27-6/28 S-Su")).toEqual({
      start: { month: 6, day: 27 }, end: { month: 6, day: 28 }, kind: "S-Su",
    }));
  it("rejects non-schedule tabs", () => {
    expect(parseTabName("BULLETIN")).toBeNull();
    expect(parseTabName("M-F Temp")).toBeNull();
    expect(parseTabName("Category/Legend")).toBeNull();
  });
});

describe("isScheduleTab", () => {
  it("accepts schedule tabs", () => expect(isScheduleTab("6/29-7/3 M-F")).toBe(true));
  it("rejects others", () => expect(isScheduleTab("Config")).toBe(false));
});

describe("selectTabForDate", () => {
  const tabs = ["BULLETIN", "6/22-6/26 M-F", "6/27-6/28 S-Su", "6/29-7/3 M-F"];
  it("selects the weekday tab containing the date", () =>
    expect(selectTabForDate(tabs, new Date("2026-06-24T12:00:00Z"))).toBe("6/22-6/26 M-F"));
  it("selects the weekend tab", () =>
    expect(selectTabForDate(tabs, new Date("2026-06-27T12:00:00Z"))).toBe("6/27-6/28 S-Su"));
  it("returns null when no tab covers the date", () =>
    expect(selectTabForDate(tabs, new Date("2026-08-01T12:00:00Z"))).toBeNull());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/reservation-tabs.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/reservation-tabs.js
import { inferYear } from "./reservation-time.js";

const TAB_RE = /^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2}) (M-F|S-Su)$/;

export function parseTabName(name) {
  const m = String(name).trim().match(TAB_RE);
  if (!m) return null;
  return {
    start: { month: Number(m[1]), day: Number(m[2]) },
    end: { month: Number(m[3]), day: Number(m[4]) },
    kind: m[5],
  };
}

export function isScheduleTab(name) {
  return parseTabName(name) !== null;
}

export function selectTabForDate(tabNames, date) {
  const t = date.getTime();
  for (const name of tabNames) {
    const parsed = parseTabName(name);
    if (!parsed) continue;
    const startYear = inferYear(parsed.start.month, parsed.start.day, date);
    let start = Date.UTC(startYear, parsed.start.month - 1, parsed.start.day);
    let endYear = inferYear(parsed.end.month, parsed.end.day, date);
    let end = Date.UTC(endYear, parsed.end.month - 1, parsed.end.day, 23, 59, 59);
    if (end < start) end += Date.UTC(1971, 0, 1) - Date.UTC(1970, 0, 1); // wrap a year
    if (t >= start && t <= end) return name;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/reservation-tabs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-tabs.js tests/lib/reservation-tabs.test.js
git commit -m "feat(reservations): week-tab parsing and selection"
```

---

### Task 3: Room normalization & matching

**Files:**
- Create: `src/lib/reservation-rooms.js`
- Test: `tests/lib/reservation-rooms.test.js`

**Interfaces:**
- Produces:
  - `normalizeLocation(str): string` — lowercase, collapse whitespace/newlines, trim.
  - `createRoomMatcher(canonicalRooms, aliases): { match(location): string | null }` — returns the canonical room name or `null` (unmanaged). `canonicalRooms` is `string[]`; `aliases` is `{ [aliasNormalized]: canonicalName }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/reservation-rooms.test.js
import { describe, it, expect } from "vitest";
import { normalizeLocation, createRoomMatcher } from "../../src/lib/reservation-rooms.js";

describe("normalizeLocation", () => {
  it("collapses newlines and case", () =>
    expect(normalizeLocation("Staff Suite \nzoom")).toBe("staff suite zoom"));
  it("trims and collapses spaces", () =>
    expect(normalizeLocation("  FH   MPR ")).toBe("fh mpr"));
});

describe("createRoomMatcher", () => {
  const matcher = createRoomMatcher(
    ["FH MPR", "FH Staff Suite", "Childcare Room"],
    { "staff suite": "FH Staff Suite", "mpr": "FH MPR" }
  );
  it("matches an exact canonical name", () => expect(matcher.match("FH MPR")).toBe("FH MPR"));
  it("matches case/space-insensitively", () => expect(matcher.match("childcare room")).toBe("Childcare Room"));
  it("matches an alias", () => expect(matcher.match("Staff Suite")).toBe("FH Staff Suite"));
  it("matches alias inside noisy text", () => expect(matcher.match("Staff Suite \nzoom")).toBe("FH Staff Suite"));
  it("returns null for unmanaged location", () => expect(matcher.match("National Mall")).toBeNull());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/reservation-rooms.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/reservation-rooms.js
export function normalizeLocation(str) {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function createRoomMatcher(canonicalRooms, aliases = {}) {
  const canonByNorm = new Map();
  for (const room of canonicalRooms) canonByNorm.set(normalizeLocation(room), room);
  const aliasByNorm = new Map();
  for (const [alias, canon] of Object.entries(aliases)) aliasByNorm.set(normalizeLocation(alias), canon);

  function match(location) {
    const norm = normalizeLocation(location);
    if (!norm) return null;
    if (canonByNorm.has(norm)) return canonByNorm.get(norm);
    if (aliasByNorm.has(norm)) return aliasByNorm.get(norm);
    // substring: a known canonical/alias token appears inside noisy free text
    for (const [key, canon] of canonByNorm) if (norm.includes(key)) return canon;
    for (const [key, canon] of aliasByNorm) if (norm.includes(key)) return canon;
    return null;
  }
  return { match };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/reservation-rooms.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-rooms.js tests/lib/reservation-rooms.test.js
git commit -m "feat(reservations): room normalization and matching"
```

---

### Task 4: Overlap & conflict detection

**Files:**
- Create: `src/lib/reservation-overlap.js`
- Test: `tests/lib/reservation-overlap.test.js`

**Interfaces:**
- Consumes: `isAllDay` from `src/lib/reservation-time.js`.
- Produces:
  - `intervalsOverlap(aStart, aEnd, bStart, bEnd): boolean` — half-open `[start, end)`.
  - `findRoomConflicts(request, events): { conflicts: Array, skipped: number }` where
    `request = { room, startMin, endMin }`, each `event = { room, startMin, endMin, allDay }`,
    and `conflicts` are events on the same room that overlap (all-day blocks the whole day).
    Events with `startMin === null || endMin === null` increment `skipped` and never conflict.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/reservation-overlap.test.js
import { describe, it, expect } from "vitest";
import { intervalsOverlap, findRoomConflicts } from "../../src/lib/reservation-overlap.js";

describe("intervalsOverlap", () => {
  it("detects overlap", () => expect(intervalsOverlap(60, 120, 90, 150)).toBe(true));
  it("treats touching ends as non-overlapping", () => expect(intervalsOverlap(60, 120, 120, 180)).toBe(false));
  it("detects nested", () => expect(intervalsOverlap(60, 180, 90, 120)).toBe(true));
  it("rejects disjoint", () => expect(intervalsOverlap(60, 120, 200, 260)).toBe(false));
});

describe("findRoomConflicts", () => {
  const req = { room: "FH MPR", startMin: 18 * 60, endMin: 21 * 60 };
  it("flags an overlapping same-room event", () => {
    const events = [{ room: "FH MPR", startMin: 19 * 60, endMin: 20 * 60, allDay: false }];
    expect(findRoomConflicts(req, events).conflicts).toHaveLength(1);
  });
  it("ignores a different room", () => {
    const events = [{ room: "Childcare Room", startMin: 19 * 60, endMin: 20 * 60, allDay: false }];
    expect(findRoomConflicts(req, events).conflicts).toHaveLength(0);
  });
  it("all-day same-room event always conflicts", () => {
    const events = [{ room: "FH MPR", startMin: 0, endMin: 1439, allDay: true }];
    expect(findRoomConflicts(req, events).conflicts).toHaveLength(1);
  });
  it("counts and skips unparseable-time events", () => {
    const events = [{ room: "FH MPR", startMin: null, endMin: null, allDay: false }];
    const res = findRoomConflicts(req, events);
    expect(res.conflicts).toHaveLength(0);
    expect(res.skipped).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/reservation-overlap.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/reservation-overlap.js
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function findRoomConflicts(request, events) {
  const conflicts = [];
  let skipped = 0;
  for (const ev of events) {
    if (ev.room !== request.room) continue;
    if (ev.startMin === null || ev.endMin === null) {
      skipped += 1;
      continue;
    }
    if (ev.allDay) {
      conflicts.push(ev);
      continue;
    }
    if (intervalsOverlap(request.startMin, request.endMin, ev.startMin, ev.endMin)) {
      conflicts.push(ev);
    }
  }
  return { conflicts, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/reservation-overlap.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-overlap.js tests/lib/reservation-overlap.test.js
git commit -m "feat(reservations): overlap and conflict detection"
```

---

### Task 5: Reservation-intent trigger

**Files:**
- Create: `src/lib/reservation-triggers.js`
- Test: `tests/lib/reservation-triggers.test.js`

**Interfaces:**
- Produces: `matchesReservationIntent(text): boolean` — cheap pre-filter so `@mention`s route to reservations vs maintenance.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/reservation-triggers.test.js
import { describe, it, expect } from "vitest";
import { matchesReservationIntent } from "../../src/lib/reservation-triggers.js";

describe("matchesReservationIntent", () => {
  it("matches reserve/book verbs", () => {
    expect(matchesReservationIntent("can I reserve the MPR friday?")).toBe(true);
    expect(matchesReservationIntent("book the staff suite 6-9pm")).toBe(true);
  });
  it("matches availability questions", () => {
    expect(matchesReservationIntent("is the MPR free saturday?")).toBe(true);
    expect(matchesReservationIntent("when is the makerspace being used next week")).toBe(true);
  });
  it("ignores maintenance reports", () => {
    expect(matchesReservationIntent("the sink in the bathroom is leaking")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/reservation-triggers.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/reservation-triggers.js
const PATTERNS = [
  /\b(reserve|reservation|reservations|book|booking)\b/i,
  /\bavailab(le|ility)\b/i,
  /\bis\b.+\bfree\b/i,
  /\bwhen is\b.+\b(used|using|booked|reserved|free)\b/i,
];

export function matchesReservationIntent(text) {
  const t = String(text || "");
  return PATTERNS.some((p) => p.test(t));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/reservation-triggers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-triggers.js tests/lib/reservation-triggers.test.js
git commit -m "feat(reservations): intent trigger pre-filter"
```

---

### Task 6: Reservations sheet service

**Files:**
- Create: `src/services/reservationsSheet.js`
- Test: `tests/services/reservationsSheet.test.js`

**Interfaces:**
- Consumes: `isScheduleTab` from `reservation-tabs.js`; `parseMonthDay`, `parseTimeToMinutes`, `isAllDay` from `reservation-time.js`.
- Produces `createReservationsSheetService(sheetsClient, spreadsheetId)` →
  - `listScheduleTabs(): Promise<string[]>` — titles that pass `isScheduleTab`.
  - `readWeekEvents(tabName): Promise<Array<{rowIndex, date:{month,day}, startMin, endMin, allDay, location, what, raw:string[]}>>` — header row 0 skipped, blank rows skipped.
  - `insertRow(tabName, rowIndex0, values): Promise<void>` — insert a row at 0-based `rowIndex0` and write `values` (array padded to 12 cols).

Column order (12): `DATE, START TIME, END TIME, TRIBE, MINISTRY, WHAT, LOCATION, IN CHARGE, WHO, TECH, CHILDCARE, NOTES`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/services/reservationsSheet.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsSheetService } from "../../src/services/reservationsSheet.js";

describe("ReservationsSheetService", () => {
  let mockSheets;
  let service;
  beforeEach(() => {
    mockSheets = {
      spreadsheets: {
        get: vi.fn(),
        values: { get: vi.fn(), update: vi.fn().mockResolvedValue({}) },
        batchUpdate: vi.fn().mockResolvedValue({}),
      },
    };
    service = createReservationsSheetService(mockSheets, "SHEET1");
  });

  it("listScheduleTabs keeps only schedule tabs", async () => {
    mockSheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [
        { properties: { title: "BULLETIN", sheetId: 1 } },
        { properties: { title: "6/22-6/26 M-F", sheetId: 2 } },
        { properties: { title: "6/27-6/28 S-Su", sheetId: 3 } },
      ] },
    });
    expect(await service.listScheduleTabs()).toEqual(["6/22-6/26 M-F", "6/27-6/28 S-Su"]);
  });

  it("readWeekEvents parses rows, skips header and blanks", async () => {
    mockSheets.spreadsheets.values.get.mockResolvedValue({
      data: { values: [
        ["DATE", "START TIME", "END TIME", "TRIBE", "MINISTRY", "WHAT", "LOCATION"],
        ["6/24 Wed", "1:00 PM", "2:00 PM", "", "", "Worktime", "Management office"],
        [],
        ["6/24 Wed", "", "", "", "", "TBD thing", "Various"],
      ] },
    });
    const events = await service.readWeekEvents("6/22-6/26 M-F");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      rowIndex: 1, date: { month: 6, day: 24 }, startMin: 13 * 60, endMin: 14 * 60,
      allDay: false, location: "Management office", what: "Worktime",
    });
    expect(events[1]).toMatchObject({ rowIndex: 3, startMin: null, endMin: null });
  });

  it("insertRow inserts a dimension then writes padded values", async () => {
    mockSheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "6/22-6/26 M-F", sheetId: 7 } }] },
    });
    await service.insertRow("6/22-6/26 M-F", 2, ["6/24 Wed", "3:00 PM", "4:00 PM", "", "", "Meeting", "FH MPR"]);
    expect(mockSheets.spreadsheets.batchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      spreadsheetId: "SHEET1",
      requestBody: { requests: [{ insertDimension: {
        range: { sheetId: 7, dimension: "ROWS", startIndex: 2, endIndex: 3 }, inheritFromBefore: true,
      } }] },
    }));
    const updateArg = mockSheets.spreadsheets.values.update.mock.calls[0][0];
    expect(updateArg.range).toBe("'6/22-6/26 M-F'!A3:L3");
    expect(updateArg.requestBody.values[0]).toHaveLength(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/reservationsSheet.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/services/reservationsSheet.js
import { isScheduleTab } from "../lib/reservation-tabs.js";
import { parseMonthDay, parseTimeToMinutes, isAllDay } from "../lib/reservation-time.js";

const COLS = 12; // A..L

function isBlankRow(row) {
  return !row || row.every((c) => String(c || "").trim() === "");
}

export function createReservationsSheetService(sheetsClient, spreadsheetId) {
  async function getSheetIdByTitle(title) {
    const res = await sheetsClient.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    const sheet = res.data.sheets.find((s) => s.properties.title === title);
    if (!sheet) throw new Error(`tab not found: ${title}`);
    return sheet.properties.sheetId;
  }

  async function listScheduleTabs() {
    const res = await sheetsClient.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    return res.data.sheets.map((s) => s.properties.title).filter(isScheduleTab);
  }

  async function readWeekEvents(tabName) {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A1:L`,
    });
    const rows = res.data.values || [];
    const events = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (isBlankRow(row)) continue;
      const startMin = parseTimeToMinutes(row[1]);
      const endMin = parseTimeToMinutes(row[2]);
      events.push({
        rowIndex: i,
        date: parseMonthDay(row[0]),
        startMin,
        endMin,
        allDay: startMin !== null && endMin !== null && isAllDay(startMin, endMin),
        location: row[6] || "",
        what: row[5] || "",
        raw: row,
      });
    }
    return events;
  }

  async function insertRow(tabName, rowIndex0, values) {
    const sheetId = await getSheetIdByTitle(tabName);
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: rowIndex0, endIndex: rowIndex0 + 1 },
            inheritFromBefore: true,
          },
        }],
      },
    });
    const padded = Array.from({ length: COLS }, (_, i) => values[i] ?? "");
    const a1Row = rowIndex0 + 1; // 1-based
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A${a1Row}:L${a1Row}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [padded] },
    });
  }

  return { listScheduleTabs, readWeekEvents, insertRow };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/reservationsSheet.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/reservationsSheet.js tests/services/reservationsSheet.test.js
git commit -m "feat(reservations): sheet read/insert service"
```

---

### Task 7: Calendar service

**Files:**
- Create: `src/services/calendar.js`
- Test: `tests/services/calendar.test.js`

**Interfaces:**
- Produces `createCalendarService(calendarClient)` →
  - `listEvents(calendarId, timeMinIso, timeMaxIso): Promise<Array<{summary, startIso, endIso}>>`.
  - `isBusy(calendarId, timeMinIso, timeMaxIso): Promise<boolean>` — via freebusy.
  - `insertEvent(calendarId, {summary, startIso, endIso, description}): Promise<{id}>`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/services/calendar.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCalendarService } from "../../src/services/calendar.js";

describe("CalendarService", () => {
  let mockCal;
  let service;
  beforeEach(() => {
    mockCal = {
      events: { list: vi.fn(), insert: vi.fn() },
      freebusy: { query: vi.fn() },
    };
    service = createCalendarService(mockCal);
  });

  it("listEvents maps the API response", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [
      { summary: "Practice", start: { dateTime: "2026-06-24T18:00:00Z" }, end: { dateTime: "2026-06-24T20:00:00Z" } },
    ] } });
    const out = await service.listEvents("cal1", "2026-06-24T00:00:00Z", "2026-06-25T00:00:00Z");
    expect(out).toEqual([{ summary: "Practice", startIso: "2026-06-24T18:00:00Z", endIso: "2026-06-24T20:00:00Z" }]);
  });

  it("isBusy true when freebusy reports a busy block", async () => {
    mockCal.freebusy.query.mockResolvedValue({ data: { calendars: { cal1: { busy: [{ start: "x", end: "y" }] } } } });
    expect(await service.isBusy("cal1", "a", "b")).toBe(true);
  });

  it("isBusy false when no busy blocks", async () => {
    mockCal.freebusy.query.mockResolvedValue({ data: { calendars: { cal1: { busy: [] } } } });
    expect(await service.isBusy("cal1", "a", "b")).toBe(false);
  });

  it("insertEvent returns the new id", async () => {
    mockCal.events.insert.mockResolvedValue({ data: { id: "evt123" } });
    const res = await service.insertEvent("cal1", {
      summary: "Team", startIso: "2026-06-24T18:00:00Z", endIso: "2026-06-24T19:00:00Z", description: "d",
    });
    expect(res).toEqual({ id: "evt123" });
    expect(mockCal.events.insert).toHaveBeenCalledWith(expect.objectContaining({ calendarId: "cal1" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/calendar.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/services/calendar.js
export function createCalendarService(calendarClient) {
  async function listEvents(calendarId, timeMinIso, timeMaxIso) {
    const res = await calendarClient.events.list({
      calendarId,
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items || []).map((e) => ({
      summary: e.summary || "",
      startIso: e.start?.dateTime || e.start?.date || "",
      endIso: e.end?.dateTime || e.end?.date || "",
    }));
  }

  async function isBusy(calendarId, timeMinIso, timeMaxIso) {
    const res = await calendarClient.freebusy.query({
      requestBody: { timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] },
    });
    const busy = res.data.calendars?.[calendarId]?.busy || [];
    return busy.length > 0;
  }

  async function insertEvent(calendarId, { summary, startIso, endIso, description }) {
    const res = await calendarClient.events.insert({
      calendarId,
      requestBody: {
        summary,
        description: description || "",
        start: { dateTime: startIso },
        end: { dateTime: endIso },
      },
    });
    return { id: res.data.id };
  }

  return { listEvents, isBusy, insertEvent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/calendar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/calendar.js tests/services/calendar.test.js
git commit -m "feat(reservations): Google Calendar service"
```

---

### Task 8: Groq reservation-request parser

**Files:**
- Modify: `src/services/groq.js`
- Test: `tests/services/groq.test.js` (add a `describe` block; create the file if it only covers other methods — append, do not overwrite existing tests)

**Interfaces:**
- Produces (added to the object returned by `createGroqService`):
  - `parseReservationRequest(text, referenceDateIso): Promise<{intent, target, date, startTime, endTime, what, who} | null>` — returns `null` on parse/JSON failure. `intent ∈ {"check","list","reserve"}`. `date` is `YYYY-MM-DD` (or `null`); `target` is the room/resource phrase as the user wrote it.

- [ ] **Step 1: Write the failing test (append to the existing groq test file)**

```javascript
// tests/services/groq.test.js  (add this describe block; keep existing ones)
import { describe, it, expect, vi } from "vitest";
import { createGroqService } from "../../src/services/groq.js";

describe("parseReservationRequest", () => {
  it("returns parsed JSON from the model", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"reserve","target":"FH MPR","date":"2026-06-26","startTime":"7:00 PM","endTime":"10:00 PM","what":"Practice","who":"College"}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("book the MPR friday 7-10pm for practice", "2026-06-23T12:00:00Z");
    expect(out).toMatchObject({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM" });
  });

  it("returns null on bad JSON", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    }) } } };
    const svc = createGroqService(client);
    expect(await svc.parseReservationRequest("hi", "2026-06-23T12:00:00Z")).toBeNull();
  });

  it("returns null when the API throws", async () => {
    const client = { chat: { completions: { create: vi.fn().mockRejectedValue(new Error("boom")) } } };
    const svc = createGroqService(client);
    expect(await svc.parseReservationRequest("x", "2026-06-23T12:00:00Z")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/groq.test.js`
Expected: FAIL — `svc.parseReservationRequest is not a function`.

- [ ] **Step 3: Add the implementation to `src/services/groq.js`**

Add this constant near the other system prompts at the top of the file:

```javascript
const SYSTEM_PROMPT_RESERVATION = `You convert a community member's reservation message into JSON. The reference date is provided. Output ONLY a JSON object with keys: intent ("check" | "list" | "reserve"), target (the room or resource name as written, or null), date (YYYY-MM-DD or null), startTime (e.g. "7:00 PM" or null), endTime (or null), what (short purpose or null), who (group/person or null). Resolve relative dates ("friday", "next week") against the reference date. Output no prose, only JSON.`;
```

Add this function inside `createGroqService`, before the `return { ... }`:

```javascript
  async function parseReservationRequest(text, referenceDateIso) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_RESERVATION },
          { role: "user", content: `Reference date: ${referenceDateIso}\nMessage: ${text}` },
        ],
        max_tokens: 256,
      });
      const raw = res.choices[0].message.content.trim();
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return null;
      return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return null;
    }
  }
```

Update the return statement to include it:

```javascript
  return { suggestFix, checkDuplicate, isMaintenanceRequest, parseReservationRequest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/groq.test.js`
Expected: PASS (existing groq tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/services/groq.js tests/services/groq.test.js
git commit -m "feat(reservations): groq reservation-request parser"
```

---

### Task 9: Reservations orchestration service

**Files:**
- Create: `src/services/reservations.js`
- Test: `tests/services/reservations.test.js`

**Interfaces:**
- Consumes: `reservationsSheetService` (Task 6), `calendarService` (Task 7), a `roomMatcher` (Task 3), `resourceCalendars` map (`{ [normalizedResource]: calendarId }`), and a `now()` function returning a `Date`.
- Consumes libs: `selectTabForDate` (tabs), `parseMonthDay`, `parseTimeToMinutes`, `formatMinutes`, `inferYear` (time), `findRoomConflicts` (overlap).
- Produces `createReservationsService({ sheetService, calendarService, roomMatcher, resourceCalendars, now })` →
  - `classifyTarget(target): { kind:"room"|"resource"|"unmanaged", name, calendarId? }`.
  - `checkRoom({ room, dateIso, startTime, endTime }): Promise<{ available, conflicts, skipped }>`.
  - `makeRoomReservation({ room, dateIso, startTime, endTime, what, who }): Promise<{ ok, reason?, conflicts? }>`.
  - `listRoom({ room, fromIso, toIso }): Promise<Array<{dateIso, startTime, endTime, what}>>`.

This task wires the pure libs to the sheet service. Resource (calendar) check/make is a thin pass-through to `calendarService` and is covered by Task 7; this service's tests focus on room logic.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/services/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsService } from "../../src/services/reservations.js";
import { createRoomMatcher } from "../../src/lib/reservation-rooms.js";

function makeService(weekEvents, tabs = ["6/22-6/26 M-F", "6/27-6/28 S-Su"]) {
  const sheetService = {
    listScheduleTabs: vi.fn().mockResolvedValue(tabs),
    readWeekEvents: vi.fn().mockResolvedValue(weekEvents),
    insertRow: vi.fn().mockResolvedValue(),
  };
  const roomMatcher = createRoomMatcher(["FH MPR", "Childcare Room"], {});
  const service = createReservationsService({
    sheetService,
    calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
    roomMatcher,
    resourceCalendars: { "projector": "cal_projector" },
    now: () => new Date("2026-06-23T12:00:00Z"),
  });
  return { service, sheetService };
}

describe("classifyTarget", () => {
  it("recognizes a room", () => {
    const { service } = makeService([]);
    expect(service.classifyTarget("MPR... FH MPR").kind).toBe("room");
  });
  it("recognizes a resource", () => {
    const { service } = makeService([]);
    expect(service.classifyTarget("projector")).toEqual({ kind: "resource", name: "projector", calendarId: "cal_projector" });
  });
  it("returns unmanaged otherwise", () => {
    const { service } = makeService([]);
    expect(service.classifyTarget("National Mall").kind).toBe("unmanaged");
  });
});

describe("checkRoom", () => {
  it("reports available when no overlap", async () => {
    const { service } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "X" },
    ]);
    const res = await service.checkRoom({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "9:00 PM" });
    expect(res.available).toBe(true);
    expect(res.conflicts).toHaveLength(0);
  });
  it("reports a conflict on overlap", async () => {
    const { service } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 20 * 60, allDay: false, location: "FH MPR", what: "Meeting" },
    ]);
    const res = await service.checkRoom({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:30 PM", endTime: "9:00 PM" });
    expect(res.available).toBe(false);
    expect(res.conflicts[0].what).toBe("Meeting");
  });
});

describe("makeRoomReservation", () => {
  it("rejects without writing when a conflict exists", async () => {
    const { service, sheetService } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 20 * 60, allDay: false, location: "FH MPR", what: "Meeting" },
    ]);
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:30 PM", endTime: "9:00 PM", what: "Practice", who: "College" });
    expect(res.ok).toBe(false);
    expect(sheetService.insertRow).not.toHaveBeenCalled();
  });
  it("inserts a chronologically ordered row when free", async () => {
    const { service, sheetService } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "Morning" },
      { rowIndex: 2, date: { month: 6, day: 24 }, startMin: 20 * 60, endMin: 21 * 60, allDay: false, location: "Childcare Room", what: "Evening" },
    ]);
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice", who: "College" });
    expect(res.ok).toBe(true);
    // 6:00 PM on 6/24 sorts after row 1 (10am) and before row 2 (8pm) -> insert at index 2
    const [tab, rowIndex0, values] = sheetService.insertRow.mock.calls[0];
    expect(tab).toBe("6/22-6/26 M-F");
    expect(rowIndex0).toBe(2);
    expect(values[0]).toBe("6/24 Wed"); // DATE formatted M/D Ddd (2026-06-24 is a Wednesday)
    expect(values[6]).toBe("FH MPR");   // LOCATION
  });
});
```

> Note: the key behavioral assertion is the **insertion index** (`rowIndex0 === 2`) — the new 6:00 PM event sorts after the 10am row and before the 8pm row. The DATE-cell string is whatever `formatDateCell` produces; if it differs, copy its real output into the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/reservations.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/services/reservations.js
import { selectTabForDate } from "../lib/reservation-tabs.js";
import { parseTimeToMinutes, formatMinutes } from "../lib/reservation-time.js";
import { createRoomMatcher } from "../lib/reservation-rooms.js";
import { findRoomConflicts } from "../lib/reservation-overlap.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDateCell(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${WEEKDAYS[d.getUTCDay()]}`;
}

function sameDate(eventDate, dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return eventDate && eventDate.month === d.getUTCMonth() + 1 && eventDate.day === d.getUTCDate();
}

export function createReservationsService({ sheetService, calendarService, roomMatcher, resourceCalendars, now }) {
  // Resource calendars are keyed by their full Google resource title
  // (e.g. "DMV Accessories-Popcorn Machine"). Build a forgiving matcher over
  // those titles so a user phrase ("popcorn machine") resolves via the same
  // normalize+substring logic the room matcher uses.
  const resourceMatcher = createRoomMatcher(Object.keys(resourceCalendars || {}), {});

  function classifyTarget(target) {
    const room = roomMatcher.match(target);
    if (room) return { kind: "room", name: room };
    const resourceTitle = resourceMatcher.match(target);
    if (resourceTitle) {
      return { kind: "resource", name: resourceTitle, calendarId: resourceCalendars[resourceTitle] };
    }
    return { kind: "unmanaged", name: target };
  }

  async function eventsForDate(dateIso) {
    const date = new Date(`${dateIso}T12:00:00Z`);
    const tabs = await sheetService.listScheduleTabs();
    const tab = selectTabForDate(tabs, date);
    if (!tab) return { tab: null, events: [] };
    const all = await sheetService.readWeekEvents(tab);
    const events = all
      .filter((e) => sameDate(e.date, dateIso))
      .map((e) => ({ ...e, room: roomMatcher.match(e.location) }));
    return { tab, events };
  }

  async function checkRoom({ room, dateIso, startTime, endTime }) {
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    const { events } = await eventsForDate(dateIso);
    const { conflicts, skipped } = findRoomConflicts({ room, startMin, endMin }, events);
    return { available: conflicts.length === 0, conflicts, skipped };
  }

  async function makeRoomReservation({ room, dateIso, startTime, endTime, what, who }) {
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    if (startMin === null || endMin === null) return { ok: false, reason: "unparseable time" };
    const { tab, events } = await eventsForDate(dateIso);
    if (!tab) return { ok: false, reason: "no week tab for that date" };
    const { conflicts } = findRoomConflicts({ room, startMin, endMin }, events);
    if (conflicts.length > 0) return { ok: false, reason: "conflict", conflicts };

    // chronological insertion point: first row on/after this date whose start is later
    const all = await sheetService.readWeekEvents(tab);
    let insertAt = all.length + 1; // default end (account for header at 0)
    for (const e of all) {
      const laterSameDay = sameDate(e.date, dateIso) && e.startMin !== null && e.startMin > startMin;
      if (laterSameDay) { insertAt = e.rowIndex; break; }
    }
    const values = [
      formatDateCell(dateIso), formatMinutes(startMin), formatMinutes(endMin),
      "", "", what || "", room, who || "", "", "", "", "",
    ];
    await sheetService.insertRow(tab, insertAt, values);
    return { ok: true };
  }

  async function listRoom({ room, fromIso, toIso }) {
    const out = [];
    const from = new Date(`${fromIso}T00:00:00Z`);
    const to = new Date(`${toIso}T00:00:00Z`);
    const tabs = await sheetService.listScheduleTabs();
    const seenTabs = new Set();
    for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
      const day = new Date(t);
      const tab = selectTabForDate(tabs, day);
      if (!tab || seenTabs.has(tab)) continue;
      seenTabs.add(tab);
      const events = await sheetService.readWeekEvents(tab);
      for (const e of events) {
        if (roomMatcher.match(e.location) !== room) continue;
        out.push({
          dateIso: `${e.date ? e.date.month : "?"}/${e.date ? e.date.day : "?"}`,
          startTime: e.startMin !== null ? formatMinutes(e.startMin) : "",
          endTime: e.endMin !== null ? formatMinutes(e.endMin) : "",
          what: e.what,
        });
      }
    }
    return out;
  }

  return { classifyTarget, checkRoom, makeRoomReservation, listRoom };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/reservations.test.js`
Expected: PASS. (If the weekday string assertion fails, copy the formatter's actual output into the test, per the Step 1 note.)

- [ ] **Step 5: Commit**

```bash
git add src/services/reservations.js tests/services/reservations.test.js
git commit -m "feat(reservations): orchestration service (check/list/make rooms)"
```

---

### Task 10: Slack reservation handler

**Files:**
- Create: `src/events/reservations.js`
- Test: `tests/events/reservations.test.js`

**Interfaces:**
- Consumes: `reservationsService` (Task 9), `groqService.parseReservationRequest` (Task 8), a `now()` function.
- Produces `createReservationHandler({ reservationsService, groqService, now })` →
  - `handleMention({ event, say })` — parse text via Groq, route by intent, reply (in-thread, `username: "Reservations"`).
  - `handleSlash({ envelope, client })` — handle `/reserve` and `/check` (envelope `text` parsed via Groq).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationHandler } from "../../src/events/reservations.js";

describe("ReservationHandler.handleMention", () => {
  let reservationsService, groqService, say, handler;
  beforeEach(() => {
    reservationsService = {
      classifyTarget: vi.fn(),
      checkRoom: vi.fn(),
      makeRoomReservation: vi.fn(),
      listRoom: vi.fn(),
    };
    groqService = { parseReservationRequest: vi.fn() };
    say = vi.fn();
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-23T12:00:00Z") });
  });

  it("replies with availability for a check intent", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "check", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.checkRoom.mockResolvedValue({ available: true, conflicts: [], skipped: 0 });
    await handler.handleMention({ event: { text: "is the MPR free friday 7-10pm?", channel: "C1", ts: "1.1" }, say });
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: "1.1", username: "Reservations (beta)", text: expect.stringContaining("available"),
    }));
  });

  it("rejects a reserve intent with a conflict and does not claim success", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.makeRoomReservation.mockResolvedValue({ ok: false, reason: "conflict", conflicts: [{ what: "Meeting", startMin: 1140, endMin: 1200 }] });
    await handler.handleMention({ event: { text: "book MPR friday 7-10pm", channel: "C1", ts: "2.2" }, say });
    const arg = say.mock.calls[0][0];
    expect(arg.text.toLowerCase()).toContain("conflict");
  });

  it("asks for clarification when Groq cannot parse", async () => {
    groqService.parseReservationRequest.mockResolvedValue(null);
    await handler.handleMention({ event: { text: "uhh do the thing", channel: "C1", ts: "3.3" }, say });
    expect(say.mock.calls[0][0].text.toLowerCase()).toContain("didn't catch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/events/reservations.js
const BOT_USERNAME = "Reservations (beta)";
const BOT_ICON_EMOJI = ":calendar:";

function conflictText(conflicts) {
  return conflicts.map((c) => `• ${c.what || "(busy)"}`).join("\n");
}

export function createReservationHandler({ reservationsService, groqService, now }) {
  async function replyForParsed(parsed, say, thread_ts) {
    if (!parsed) {
      await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: "I didn't catch that — try e.g. \"reserve FH MPR Friday 7-10pm for practice\"." });
      return;
    }
    const target = reservationsService.classifyTarget(parsed.target || "");
    if (target.kind === "unmanaged") {
      await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: `I don't manage "${parsed.target}". I can only handle known rooms and resources.` });
      return;
    }
    if (target.kind === "room") {
      if (parsed.intent === "reserve") {
        const res = await reservationsService.makeRoomReservation({
          room: target.name, dateIso: parsed.date, startTime: parsed.startTime, endTime: parsed.endTime,
          what: parsed.what, who: parsed.who,
        });
        await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
          text: res.ok
            ? `Booked ${target.name} on ${parsed.date} ${parsed.startTime}–${parsed.endTime}.`
            : res.reason === "conflict"
              ? `Can't book — conflict on ${target.name}:\n${conflictText(res.conflicts)}`
              : `Can't book: ${res.reason}.` });
        return;
      }
      if (parsed.intent === "list") {
        const items = await reservationsService.listRoom({ room: target.name, fromIso: parsed.date, toIso: parsed.date });
        await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
          text: items.length
            ? `${target.name} usage:\n` + items.map((i) => `• ${i.dateIso} ${i.startTime}–${i.endTime} ${i.what}`).join("\n")
            : `Nothing booked for ${target.name}.` });
        return;
      }
      const chk = await reservationsService.checkRoom({
        room: target.name, dateIso: parsed.date, startTime: parsed.startTime, endTime: parsed.endTime,
      });
      await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: chk.available
          ? `${target.name} is available ${parsed.date} ${parsed.startTime}–${parsed.endTime}.`
          : `${target.name} has a conflict:\n${conflictText(chk.conflicts)}` });
      return;
    }
    // resource (calendar) path is intentionally minimal in v1
    await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
      text: `Resource "${target.name}" handling is configured via calendars; ask an admin if this fails.` });
  }

  async function handleMention({ event, say }) {
    const refIso = now().toISOString();
    const parsed = await groqService.parseReservationRequest(event.text || "", refIso);
    const thread_ts = event.thread_ts || event.ts;
    await replyForParsed(parsed, say, thread_ts);
  }

  async function handleSlash({ envelope, client }) {
    const refIso = now().toISOString();
    const parsed = await groqService.parseReservationRequest(envelope.text || "", refIso);
    const say = (msg) => client.chat.postEphemeral({
      channel: envelope.channel_id, user: envelope.user_id, ...msg,
    });
    await replyForParsed(parsed, say, undefined);
  }

  return { handleMention, handleSlash };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/reservations.js tests/events/reservations.test.js
git commit -m "feat(reservations): Slack mention + slash handler"
```

---

### Task 11: Wire dispatch, worker, receiver

**Files:**
- Modify: `src/lambda/dispatch.js`
- Modify: `src/lambda/worker.js`
- Modify: `src/lambda/receiver.js`
- Test: `tests/lambda/dispatch.test.js` (create) — verify routing.

**Interfaces:**
- Consumes: `reservationHandler` with `handleMention`/`handleSlash` (Task 10); `matchesReservationIntent` (Task 5).
- Produces: `dispatchSlackEvent` now accepts `reservationHandler` and routes `/reserve`, `/check`, and reservation-intent app_mentions to it.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lambda/dispatch.test.js
import { describe, it, expect, vi } from "vitest";
import { dispatchSlackEvent } from "../../src/lambda/dispatch.js";

function client() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({}) } };
}

describe("dispatchSlackEvent reservation routing", () => {
  it("routes /reserve to the reservation handler", async () => {
    const reservationHandler = { handleMention: vi.fn(), handleSlash: vi.fn().mockResolvedValue() };
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/reserve", text: "MPR fri 7-10pm" },
      reservationHandler, client: client(),
    });
    expect(reservationHandler.handleSlash).toHaveBeenCalled();
  });

  it("routes a reservation-intent app_mention to the reservation handler, not maintenance", async () => {
    const reservationHandler = { handleMention: vi.fn().mockResolvedValue(), handleSlash: vi.fn() };
    const maintenance = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", text: "<@U1> is the MPR free friday?", channel: "C1", ts: "1.1" } },
      handler: maintenance, reservationHandler, client: client(),
    });
    expect(reservationHandler.handleMention).toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
  });

  it("falls through to maintenance for a non-reservation app_mention", async () => {
    const reservationHandler = { handleMention: vi.fn(), handleSlash: vi.fn() };
    const maintenance = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", text: "<@U1> the sink is leaking", channel: "C1", ts: "2.2" } },
      handler: maintenance, reservationHandler, client: client(),
    });
    expect(reservationHandler.handleMention).not.toHaveBeenCalled();
    expect(maintenance).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: FAIL — reservation routing not implemented (maintenance called instead).

- [ ] **Step 3: Edit `src/lambda/dispatch.js`**

Add the import at the top:

```javascript
import { matchesReservationIntent } from "../lib/reservation-triggers.js";
```

Replace the slash-command block and add mention routing. The function signature gains `reservationHandler`:

```javascript
export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, reservationHandler, client }) {
  if (slackEnvelope.type === "slash_command") {
    if (slashRefreshHandler && slackEnvelope.command === "/refresh-genders") {
      await slashRefreshHandler({ envelope: slackEnvelope, client });
    } else if (reservationHandler && (slackEnvelope.command === "/reserve" || slackEnvelope.command === "/check")) {
      await reservationHandler.handleSlash({ envelope: slackEnvelope, client });
    }
    return;
  }

  const event = slackEnvelope.event;
  if (!event) return;

  if (
    genderHandler &&
    event.type === "message" &&
    !event.bot_id &&
    !event.subtype &&
    matchesGenderEvent(event.text || "")
  ) {
    const say = (msg) =>
      client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts, ...msg });
    await genderHandler({ event, say, client });
    return;
  }

  if (
    reservationHandler &&
    (event.type === "app_mention" || (event.type === "message" && event.thread_ts)) &&
    !event.bot_id &&
    matchesReservationIntent(event.text || "")
  ) {
    const say = (msg) =>
      client.chat.postMessage({ channel: event.channel, ...msg });
    await reservationHandler.handleMention({ event, say, client });
    return;
  }

  if (shouldSkip(event)) return;

  const say = (msg) =>
    client.chat.postMessage({ channel: event.channel, username: "FH Maintenance (beta)", ...msg });

  await handler({ event, say, client });
}
```

(Keep the existing `import { matchesGenderEvent } ...` and `shouldSkip` function unchanged.)

- [ ] **Step 4: Edit `src/lambda/worker.js`**

```javascript
import { dispatchSlackEvent } from "./dispatch.js";
import { getDeps } from "./clients.js";

export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler, slashRefreshHandler, reservationHandler } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      genderHandler,
      slashRefreshHandler,
      reservationHandler,
      client,
    });
  }
}
```

- [ ] **Step 5: Edit `src/lambda/receiver.js`**

Add the import:

```javascript
import { matchesReservationIntent } from "../lib/reservation-triggers.js";
```

Update `shouldEnqueueEvent` so reservation-intent threaded messages are enqueued (app_mention already returns true via `type !== "message"`):

```javascript
function shouldEnqueueEvent(parsed) {
  const event = parsed.event;
  if (!event) return false;
  if (event.type !== "message") return true;
  const text = event.text || "";
  if (matchesGenderEvent(text)) return true;
  if (matchesReservationIntent(text)) return true;
  if (/<@[A-Z0-9_]+>/.test(text)) return true;
  if (event.thread_ts) return true;
  return false;
}
```

(The slash-command branch already enqueues every slash command — `/reserve` and `/check` flow through unchanged.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: PASS. Then `npm test` — all suites green.

- [ ] **Step 7: Commit**

```bash
git add src/lambda/dispatch.js src/lambda/worker.js src/lambda/receiver.js tests/lambda/dispatch.test.js
git commit -m "feat(reservations): route slash + mention through dispatch"
```

---

### Task 12: Config, client wiring, env vars

**Files:**
- Modify: `src/config.js`
- Modify: `src/lambda/clients.js`
- Modify: `template.yaml`
- Modify: `.env.example`
- Test: `tests/config.test.js` (extend)

**Interfaces:**
- Consumes everything above. Produces a fully wired `reservationHandler` from `getDeps()` when `RESERVATIONS_SHEET_ID` is set.

New env vars:
- `RESERVATIONS_SHEET_ID` — OneStop spreadsheet id (gates the feature).
- `RESERVATION_ROOMS` — JSON: `{ "rooms": ["FH MPR", ...], "aliases": { "mpr": "FH MPR" } }`.
- `RESOURCE_CALENDARS` — JSON: `{ "projector": "calendar_id@group.calendar.google.com" }`.

- [ ] **Step 1: Extend `tests/config.test.js`**

Add:

```javascript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig reservations vars", () => {
  const base = {
    SLACK_BOT_TOKEN: "x", SLACK_CHANNEL_IDS: "C1", GOOGLE_SHEET_ID: "s",
    GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "cs", GOOGLE_REFRESH_TOKEN: "r", GROQ_API_KEY: "g",
  };
  let saved;
  beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, base); });
  afterEach(() => { process.env = saved; });

  it("defaults reservations config to null/empty when unset", () => {
    delete process.env.RESERVATIONS_SHEET_ID;
    const cfg = loadConfig();
    expect(cfg.reservationsSheetId).toBeNull();
  });

  it("parses room and calendar JSON when set", () => {
    process.env.RESERVATIONS_SHEET_ID = "RS1";
    process.env.RESERVATION_ROOMS = JSON.stringify({ rooms: ["FH MPR"], aliases: { mpr: "FH MPR" } });
    process.env.RESOURCE_CALENDARS = JSON.stringify({ projector: "cal@x" });
    const cfg = loadConfig();
    expect(cfg.reservationsSheetId).toBe("RS1");
    expect(cfg.reservationRooms.rooms).toEqual(["FH MPR"]);
    expect(cfg.resourceCalendars).toEqual({ projector: "cal@x" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL — `cfg.reservationsSheetId` is `undefined`.

- [ ] **Step 3: Edit `src/config.js`**

Inside the returned object in `loadConfig`, add (before the closing `}`):

```javascript
    reservationsSheetId: process.env.RESERVATIONS_SHEET_ID || null,
    reservationRooms: process.env.RESERVATION_ROOMS
      ? JSON.parse(process.env.RESERVATION_ROOMS)
      : { rooms: [], aliases: {} },
    resourceCalendars: process.env.RESOURCE_CALENDARS
      ? JSON.parse(process.env.RESOURCE_CALENDARS)
      : {},
```

- [ ] **Step 4: Edit `src/lambda/clients.js`**

Add imports near the existing service imports:

```javascript
import { createReservationsSheetService } from "../services/reservationsSheet.js";
import { createCalendarService } from "../services/calendar.js";
import { createReservationsService } from "../services/reservations.js";
import { createRoomMatcher } from "../lib/reservation-rooms.js";
import { createReservationHandler } from "../events/reservations.js";
```

After `slashRefreshHandler` is set up and before `cached = {...}`, add:

```javascript
  let reservationHandler;
  if (config.reservationsSheetId) {
    const reservationsSheetClient = google.sheets({ version: "v4", auth: oauth2Client });
    const reservationsSheetService = createReservationsSheetService(
      reservationsSheetClient,
      config.reservationsSheetId
    );
    const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });
    const calendarService = createCalendarService(calendarClient);
    const roomMatcher = createRoomMatcher(
      config.reservationRooms.rooms || [],
      config.reservationRooms.aliases || {}
    );
    const reservationsService = createReservationsService({
      sheetService: reservationsSheetService,
      calendarService,
      roomMatcher,
      resourceCalendars: config.resourceCalendars,
      now: () => new Date(),
    });
    reservationHandler = createReservationHandler({
      reservationsService,
      groqService,
      now: () => new Date(),
    });
  }
```

Update the cached object:

```javascript
  cached = { client: slack, handler, genderHandler, slashRefreshHandler, reservationHandler };
  return cached;
```

- [ ] **Step 5: Edit `template.yaml`**

Add three parameters under `Parameters:`:

```yaml
  ReservationsSheetId:  { Type: String, Default: "" }
  ReservationRooms:     { Type: String, Default: "" }
  ResourceCalendars:    { Type: String, Default: "" }
```

Add to `WorkerFn` → `Environment` → `Variables`:

```yaml
          RESERVATIONS_SHEET_ID: !Ref ReservationsSheetId
          RESERVATION_ROOMS:     !Ref ReservationRooms
          RESOURCE_CALENDARS:    !Ref ResourceCalendars
```

- [ ] **Step 6: Edit `.env.example`**

Append:

```
# Reservations (optional; feature is off unless RESERVATIONS_SHEET_ID is set)
RESERVATIONS_SHEET_ID=
RESERVATION_ROOMS={"rooms":["FH MPR","FH Staff Suite","FH Makerspace","Childcare Room","Management office"],"aliases":{"mpr":"FH MPR","staff suite":"FH Staff Suite"}}
RESOURCE_CALENDARS={}
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/lambda/clients.js template.yaml .env.example tests/config.test.js
git commit -m "feat(reservations): config, client wiring, env vars"
```

---

### Task 13: Re-issue Google refresh token with Calendar scope

**Files:**
- Modify: `scripts/get-google-token.js`
- Modify: `scripts/google-token-ci.js`
- Reference: spec "Auth" section.

**Interfaces:** no code consumers; this changes the OAuth consent scope list so the existing refresh token can call the Calendar API.

> This task has no unit test (it mints a credential via an interactive/CI OAuth flow). Verification is manual, described below.

- [ ] **Step 1: Find the scope list**

Run: `grep -rn "scope" scripts/get-google-token.js scripts/google-token-ci.js`
Expected: a `scopes`/`scope` array containing the Sheets and Drive scopes.

- [ ] **Step 2: Add the Calendar scope**

In both files, add `"https://www.googleapis.com/auth/calendar"` to the scopes array alongside the existing Sheets/Drive scopes. Example shape:

```javascript
const scopes = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar",
];
```

- [ ] **Step 3: Re-issue the token (manual)**

Per the existing runbook used in commit `b610479`: run the token script, complete consent, and update the `GOOGLE_REFRESH_TOKEN` secret (local `.env` and the deploy secret).

Run (local): `node scripts/get-google-token.js`
Expected: prints a new refresh token after consent that now includes Calendar.

- [ ] **Step 4: Verify Calendar access (manual smoke test)**

Create a throwaway script in the scratchpad that lists calendars with the new token:

```javascript
import { google } from "googleapis";
import { config } from "dotenv";
config({ path: "/Users/jyen/Projects/fh-community-bot/.env", quiet: true });
const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const cal = google.calendar({ version: "v3", auth });
const res = await cal.calendarList.list();
console.log(res.data.items.map((c) => `${c.summary}: ${c.id}`).join("\n"));
```

Run it from the project dir. Expected: a list of calendars with ids (these ids populate `RESOURCE_CALENDARS`). Delete the script afterward.

- [ ] **Step 5: Commit**

```bash
git add scripts/get-google-token.js scripts/google-token-ci.js
git commit -m "feat(reservations): add Calendar scope to Google token flow"
```

---

### Task 14: Mirror room reservations to the venue calendar

**Context:** Decision (user): the OneStop sheet is the source of truth for rooms; the DMV Venues Google Calendar is a **mirror**. So a successful room booking writes the sheet row (Task 9) AND creates a matching event on the room's venue calendar. Availability/conflict checks stay sheet-only (Task 9 unchanged). The venue calendar is best-effort: a mirror failure must NOT fail or undo the sheet booking (the sheet is truth).

**Files:**
- Modify: `src/services/calendar.js` (+ test) — `insertEvent` accepts an optional `timeZone`.
- Modify: `src/services/reservations.js` (+ test) — `makeRoomReservation` mirrors to the venue calendar.
- Modify: `src/lambda/clients.js`, `src/config.js`, `template.yaml`, `.env.example` — wire `VENUE_CALENDARS`.

**Interfaces:**
- Consumes: `calendarService.insertEvent` (Task 7), `venueCalendars` map `{ "<canonical room>": "<calendarId>" }`.
- `createReservationsService` gains a `venueCalendars` dep (default `{}`). `makeRoomReservation` returns `{ ok, mirrored: boolean }` (mirrored false when no venue mapping or the mirror call failed).

- [ ] **Step 1: Extend `insertEvent` with a timeZone — write the failing test**

Add to `tests/services/calendar.test.js`:

```javascript
  it("insertEvent forwards an optional timeZone on start and end", async () => {
    mockCal.events.insert.mockResolvedValue({ data: { id: "evtTZ" } });
    await service.insertEvent("cal1", {
      summary: "Room", startIso: "2026-06-26T19:00:00", endIso: "2026-06-26T22:00:00",
      description: "", timeZone: "America/New_York",
    });
    const arg = mockCal.events.insert.mock.calls[0][0];
    expect(arg.requestBody.start).toEqual({ dateTime: "2026-06-26T19:00:00", timeZone: "America/New_York" });
    expect(arg.requestBody.end).toEqual({ dateTime: "2026-06-26T22:00:00", timeZone: "America/New_York" });
  });
```

- [ ] **Step 2: Run it — confirm it fails** (`timeZone` not forwarded).

Run: `npx vitest run tests/services/calendar.test.js`

- [ ] **Step 3: Update `insertEvent` in `src/services/calendar.js`**

```javascript
  async function insertEvent(calendarId, { summary, startIso, endIso, description, timeZone }) {
    const start = { dateTime: startIso };
    const end = { dateTime: endIso };
    if (timeZone) { start.timeZone = timeZone; end.timeZone = timeZone; }
    const res = await calendarClient.events.insert({
      calendarId,
      requestBody: { summary, description: description || "", start, end },
    });
    return { id: res.data.id };
  }
```

- [ ] **Step 4: Run the calendar test — confirm pass** (existing cases still green; the no-timeZone case must still omit `timeZone`).

- [ ] **Step 5: Mirror logic — write the failing test**

Add to `tests/services/reservations.test.js` a `makeService` that also passes `venueCalendars` and a calendar spy. Extend the existing `makeService` helper to accept and forward `venueCalendars`, and assert:

```javascript
  it("mirrors a successful room booking to the venue calendar", async () => {
    const calInsert = vi.fn().mockResolvedValue({ id: "evt1" });
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue([]),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: calInsert },
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars: {},
      venueCalendars: { "FH MPR": "venue_cal_mpr" },
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice", who: "College" });
    expect(res.ok).toBe(true);
    expect(res.mirrored).toBe(true);
    expect(calInsert).toHaveBeenCalledWith("venue_cal_mpr", expect.objectContaining({
      summary: expect.stringContaining("Practice"), timeZone: "America/New_York",
    }));
  });

  it("still succeeds (mirrored:false) when the room has no venue calendar", async () => {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue([]),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars: {},
      venueCalendars: {},
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice" });
    expect(res.ok).toBe(true);
    expect(res.mirrored).toBe(false);
  });

  it("still returns ok when the mirror call throws (sheet is truth)", async () => {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue([]),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn().mockRejectedValue(new Error("cal down")) },
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars: {},
      venueCalendars: { "FH MPR": "venue_cal_mpr" },
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice" });
    expect(res.ok).toBe(true);
    expect(res.mirrored).toBe(false);
  });
```

- [ ] **Step 6: Run — confirm the new cases fail.**

- [ ] **Step 7: Update `src/services/reservations.js`**

Add `venueCalendars = {}` to the destructured deps. Add a helper and mirror after a successful sheet insert:

```javascript
const VENUE_TZ = "America/New_York";

function isoFromDateMinutes(dateIso, minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${dateIso}T${h}:${m}:00`;
}
```

At the end of `makeRoomReservation`, after `await sheetService.insertRow(...)`:

```javascript
    let mirrored = false;
    const venueCalendarId = venueCalendars[room];
    if (venueCalendarId) {
      try {
        await calendarService.insertEvent(venueCalendarId, {
          summary: `${what || "Reservation"}${who ? ` (${who})` : ""}`,
          startIso: isoFromDateMinutes(dateIso, startMin),
          endIso: isoFromDateMinutes(dateIso, endMin),
          description: "Mirrored from OneStop sheet by the reservations bot.",
          timeZone: VENUE_TZ,
        });
        mirrored = true;
      } catch (err) {
        console.warn(`[reservations] venue mirror failed for ${room}: ${err.message}`);
      }
    }
    return { ok: true, mirrored };
```

- [ ] **Step 8: Run the reservations test — confirm pass.** Then `npm test`.

- [ ] **Step 9: Wire `VENUE_CALENDARS`** (mirrors the Task 12 pattern):
  - `src/config.js`: `venueCalendars: process.env.VENUE_CALENDARS ? JSON.parse(process.env.VENUE_CALENDARS) : {}`.
  - `src/lambda/clients.js`: pass `venueCalendars: config.venueCalendars` into `createReservationsService`.
  - `template.yaml`: add `VenueCalendars: { Type: String, Default: "" }` param + `VENUE_CALENDARS: !Ref VenueCalendars` env var on WorkerFn.
  - `.env.example`: add `VENUE_CALENDARS={}`.

- [ ] **Step 10: Commit**

```bash
git add src/services/calendar.js tests/services/calendar.test.js src/services/reservations.js tests/services/reservations.test.js src/config.js src/lambda/clients.js template.yaml .env.example
git commit -m "feat(reservations): mirror room bookings to the venue calendar"
```

---

## Final verification

- [ ] Run `npm test` — every suite passes.
- [ ] `git log --oneline` shows one commit per task.
- [ ] Confirm `RESERVATION_ROOMS` / `RESOURCE_CALENDARS` are finalized with the real room list and calendar ids (the two deferred config TODOs from the spec).

---

## Self-Review (completed against the spec)

- **Capabilities** (check / list / make): Tasks 9–10 implement all three; routing in Task 11. ✓
- **Rooms→sheet, resources→calendar**: Task 6 (sheet), Task 7 (calendar), Task 9 classification. ✓
- **Weekly-tab selection + ignore non-schedule tabs**: Task 2 + Task 6 `listScheduleTabs`. ✓
- **Wild LOCATION / canonical rooms**: Task 3 matcher; unmanaged path in Tasks 9–10. ✓
- **Reject-only conflicts**: Task 4 + Task 9 `makeRoomReservation` (no write on conflict) + Task 10 reply. ✓
- **Blank/garbage times skipped + flagged**: Task 1 returns null, Task 4 counts `skipped`, surfaced via service. ✓
- **Chronological insert**: Task 6 `insertRow` + Task 9 insertion-point logic. ✓
- **Both triggers (slash + mention)**: Task 10 + Task 11. ✓
- **One-app intent routing** (the architecture gap): Task 5 trigger + Task 11 dispatch fallthrough to maintenance. ✓
- **Auth scope re-mint**: Task 13. ✓
- **Gating on env var**: Task 12 mirrors gender gating. ✓
- **Bot persona "Reservations (beta)"**: Task 10 `username` override (matches the app's "(beta)" naming). ✓
- **Deferred**: exact room list, resource calendar ids, `/reserve` arg grammar (Groq NL covers parsing) — left as config TODOs per spec, flagged in Final verification.
