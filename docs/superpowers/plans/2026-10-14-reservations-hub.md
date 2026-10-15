# Reservations Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slack #reservations the front door for FH's four reservation systems: book and query in natural language, first come first served, with a weekly Monday digest.

**Architecture:** One adapter per backend (rooms sheet, kitchen sheet, RMS resource calendars) behind the same interface. A Slack message handler parses requests with Claude Haiku on Bedrock, checks conflicts through the adapter, and writes the booking. A scheduled Lambda reads all adapters for the week and posts a digest. Everything rides the existing receiver → SQS → worker pipeline.

**Tech Stack:** Node 22 ESM, vitest, `googleapis` (Sheets v4, Calendar v3), `@slack/web-api`, `@anthropic-ai/bedrock-sdk`, AWS SAM (Lambda, SQS, EventBridge Scheduler).

**Spec:** `docs/superpowers/specs/2026-10-14-reservations-hub-design.md`

## Global Constraints

- Time zone for every date and time: `America/New_York`.
- Bot persona on every reservations post: `username: "FH Reservations"`, `icon_emoji: ":calendar:"`.
- First come, first served. No approver. On conflict, write nothing and name the holder.
- Room rows are written with Status **blank**.
- Kitchen limit: no more than **3** groups overlapping one time window.
- Digest: `cron(0 8 ? * MON *)`, time zone `America/New_York`, covers Monday–Sunday of the current week.
- Digest source failure: still post, and DM `ESCALATION_USER_ID` (`U05SWHWFTEH`).
- A bad or missing config value never throws at load time; the affected backend is simply absent.
- `RESOURCE_CALENDARS` (~11 KB) ships as `runtime-config/resource-calendars.json`, written by the deploy workflow before `sam build`. `runtime-config/` must NOT be gitignored.
- Out of scope: venues and vehicles calendars, editing/cancelling, approval flows, real-time announcement of bookings made outside Slack.
- Every LLM call goes through `complete()` in `src/services/llm.js`, so failures emit `LlmCallFailed`.

## Review Focus

1. **"2-4pm" style times and end before start.** A reasonable person expects "Sat 2-4" to mean 2:00–4:00 PM, and a garbled range (end ≤ start) to be asked about, never booked. Pinned in Task 6 (`normalizeRequest` drops a range whose end ≤ start, so `missingFields` asks for times).
2. **Free-text room cells.** "MPR, parking lot", "FH Glass Room, L120, Youth Room", "Maker Space", "All FH" must all conflict with a request for the rooms they name. Pinned in Task 3.
3. **Kitchen dates without a year near New Year.** "Thu, 01/07" read in December is next January, not last. Pinned in Task 2 (`parseSheetDate` rollover).
4. **DST boundaries.** A booking on 2026-11-01 (EST) must carry offset `-05:00`, one on 2026-10-31 `-04:00`. Pinned in Task 2.
5. **Thread replies after a booking is done.** "thanks!" or "also the MPR" in a closed thread must never book again. Pinned in Task 7 (closed-thread metadata test).

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/reservation-time.js` | Parse sheet dates/times, NY time zone math, week ranges, formatting |
| `src/lib/rooms-catalog.js` | Canonical rooms, alias matching, cell splitting, room conflict rule |
| `src/lib/rms-catalog.js` | `RESOURCE_CALENDARS` → labelled, categorised resource list |
| `src/lib/reservation-catalog.js` | One bookable-item catalog across backends, prompt text, lookup |
| `src/lib/reservation-request.js` | Validate LLM output, missing-field rules |
| `src/lib/reservation-format.js` | One-line reservation text, holder text, digest builder |
| `src/services/reservations/rooms.js` | Rooms adapter (Upcoming Room Requests tab) |
| `src/services/reservations/kitchen.js` | Kitchen adapter (FH-Kitchen-RSVP tab) |
| `src/services/reservations/rms.js` | RMS calendars adapter |
| `src/services/llm.js` | + `parseReservationRequest` |
| `src/events/reservations.js` | Slack message flow |
| `src/lambda/digest.js` | Weekly digest Lambda |
| `src/config.js`, `src/lambda/clients.js`, `src/lambda/dispatch.js`, `src/lambda/receiver.js`, `src/lambda/worker.js` | Wiring |
| `template.yaml`, `.github/workflows/deploy.yml`, `.env.example`, `README.md`, `docs/RUNBOOK.md` | Infra and docs |

### Shared shapes (used across tasks)

```js
// Reservation: one booking read from any backend.
// start/end are minutes after midnight NY time; null means all day / unknown.
{ category, item, date /* "YYYY-MM-DD" */, start, end, title, holder, holderUserId /* "U…" | null */, holderEmail /* string | null */ }

// Adapter: every backend exposes exactly this.
{
  backend,            // "rooms" | "kitchen" | "rms"
  link,               // URL people can open to book directly
  listReservations({ from, to, items }),  // -> { reservations: Reservation[], errors: string[] }  (throws if the whole source is unreadable)
  findConflicts({ date, start, end, items }), // -> Reservation[]
  book(request),      // -> { status: "booked", link } | { status: "unavailable", reason, link }
}

// Catalog entry: one bookable item.
{ label, category, backend, calendarId /* rms only */ }

// Booking request passed to adapter.book():
{ date, start, end, items /* CatalogEntry[] */, title, ministry, requesterName, requesterUserId, phone, permalink, appliances /* { key: true|number } */ }
```

Category ids and display names: `rooms` Rooms, `kitchen` Kitchen, `tech` Tech, `sports` Sports, `outreach` Outreach, `accessories` Accessories.

---

### Task 1: Verify RMS booking and Slack access (spike, throwaway)

This decides whether RMS bookings write or fall back to a link. Nothing here is committed.

**Files:**
- Create (scratch only, never commit): `<scratchpad>/rms-spike.mjs`, copied to `./.rms-spike.mjs` to run, then deleted.

- [ ] **Step 1: Write the spike script**

```js
// .rms-spike.mjs — throwaway. Books DMV Accessories-Kiddie Pool for 30 min
// on 2027-12-30 at 3:00 AM ET, reports what the resource did, deletes it.
import { google } from "googleapis";
import { WebClient } from "@slack/web-api";
import "dotenv/config";

const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const cal = google.calendar({ version: "v3", auth });
const RES = "c_188cf8guebh7aje2gu35da9g3715e@resource.calendar.google.com"; // DMV Accessories-Kiddie Pool

const ins = await cal.events.insert({
  calendarId: "primary",
  sendUpdates: "none",
  requestBody: {
    summary: "SPIKE test — delete me",
    start: { dateTime: "2027-12-30T03:00:00", timeZone: "America/New_York" },
    end: { dateTime: "2027-12-30T03:30:00", timeZone: "America/New_York" },
    attendees: [{ email: RES, resource: true }],
  },
});
console.log("inserted", ins.data.id, "organizer", ins.data.organizer);
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const g = await cal.events.get({ calendarId: "primary", eventId: ins.data.id });
  console.log("attempt", i, g.data.attendees?.map((a) => `${a.email}:${a.responseStatus}`));
}
const seen = await cal.events.list({
  calendarId: RES, timeMin: "2027-12-30T07:00:00Z", timeMax: "2027-12-30T09:00:00Z", singleEvents: true,
});
console.log("visible on resource calendar:", seen.data.items.map((e) => ({ s: e.summary, d: e.description, org: e.organizer })));
await cal.events.delete({ calendarId: "primary", eventId: ins.data.id, sendUpdates: "none" });
console.log("deleted");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const t = await slack.auth.test();
console.log("slack scopes:", t.response_metadata?.scopes);
const ch = await slack.conversations.info({ channel: "C0BCSJNECRL" });
console.log("#reservations is_member:", ch.channel.is_member, ch.channel.name);
```

- [ ] **Step 2: Run it**

Run: `cp <scratchpad>/rms-spike.mjs ./.rms-spike.mjs && node ./.rms-spike.mjs; rm -f ./.rms-spike.mjs`

Expected one of:
- **PASS:** the attendee reaches `accepted`, the event is visible on the resource calendar with its description, and it is deleted. → `RMS_BOOKING_ENABLED` stays default `true`. Note how many seconds acceptance took; Task 5 polls 3 × 1 s.
- **FAIL:** insert errors, or the attendee is `declined`/stays `needsAction`. → Set repo variable `RMS_BOOKING_ENABLED=false` in Task 10 and tell the user. All other tasks are unchanged.

Also confirm: the scopes include `channels:history`, `users:read`, `users:read.email`, `chat:write.customize`; `is_member` is `true`. If the bot isn't a member, ask the user to `/invite` the bot into #reservations.

- [ ] **Step 3: Report the result to the user before Task 2.** If the event was not deleted (script crashed), delete it by id with `cal.events.delete`.

---

### Task 2: Time helpers

**Files:**
- Create: `src/lib/reservation-time.js`
- Test: `tests/lib/reservation-time.test.js`

**Interfaces:**
- Produces: `TZ`, `parseSheetDate(text, refIso) -> "YYYY-MM-DD"|null`, `formatSheetDate(iso) -> "Tue, 6/23/26"`, `parseSheetTime(text) -> number|null`, `hhmmToMin("14:30") -> 870|null`, `fmtTime(min) -> "2:30 PM"`, `fmtRange(start,end) -> "2:00–4:00 PM"|"All day"`, `overlaps(aS,aE,bS,bE) -> boolean`, `nyOffset(iso) -> "-04:00"`, `nyDateTime(iso,min) -> "2026-10-17T14:00:00-04:00"`, `nyLocal(iso,min) -> "2026-10-17T14:00:00"`, `nyParts(dateTimeString) -> { date, min }`, `nyToday(now) -> iso`, `addDaysIso(iso,n)`, `weekOf(now) -> { from, to }`, `fmtDay(iso) -> "Sat 10/17"`, `weekdayName(iso) -> "Saturday"`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/reservation-time.test.js
import { describe, it, expect } from "vitest";
import {
  parseSheetDate, formatSheetDate, parseSheetTime, hhmmToMin, fmtTime, fmtRange,
  overlaps, nyOffset, nyDateTime, nyLocal, nyParts, nyToday, addDaysIso, weekOf, fmtDay, weekdayName,
} from "../../src/lib/reservation-time.js";

describe("parseSheetDate", () => {
  it("reads room-sheet dates with a 2-digit year", () => {
    expect(parseSheetDate("Tue, 6/23/26", "2026-10-14")).toBe("2026-06-23");
  });
  it("reads 4-digit years and bare dates", () => {
    expect(parseSheetDate("6/23/2026", "2026-10-14")).toBe("2026-06-23");
  });
  it("reads kitchen dates without a year in the reference year", () => {
    expect(parseSheetDate("Thu, 09/03", "2026-10-14")).toBe("2026-09-03");
  });
  it("rolls a yearless date into next year when it would be over 180 days past", () => {
    expect(parseSheetDate("Thu, 01/07", "2026-12-20")).toBe("2027-01-07");
  });
  it("returns null for non-dates", () => {
    expect(parseSheetDate("SAMPLE", "2026-10-14")).toBeNull();
    expect(parseSheetDate("", "2026-10-14")).toBeNull();
    expect(parseSheetDate("13/40/26", "2026-10-14")).toBeNull();
  });
});

describe("formatSheetDate", () => {
  it("writes the room-sheet format", () => {
    expect(formatSheetDate("2026-06-23")).toBe("Tue, 6/23/26");
  });
});

describe("parseSheetTime", () => {
  it("reads both sheet formats", () => {
    expect(parseSheetTime("6:00:00 PM")).toBe(18 * 60);
    expect(parseSheetTime("9:00 PM")).toBe(21 * 60);
    expect(parseSheetTime("12:00 AM")).toBe(0);
    expect(parseSheetTime("12:30 PM")).toBe(12 * 60 + 30);
    expect(parseSheetTime("11:59 PM")).toBe(23 * 60 + 59);
    expect(parseSheetTime("18:30")).toBe(18 * 60 + 30);
  });
  it("returns null for blanks and junk", () => {
    expect(parseSheetTime("")).toBeNull();
    expect(parseSheetTime(undefined)).toBeNull();
    expect(parseSheetTime("TBD")).toBeNull();
  });
});

describe("formatting", () => {
  it("hhmmToMin", () => {
    expect(hhmmToMin("14:30")).toBe(870);
    expect(hhmmToMin("25:00")).toBeNull();
    expect(hhmmToMin(null)).toBeNull();
  });
  it("fmtTime", () => {
    expect(fmtTime(0)).toBe("12:00 AM");
    expect(fmtTime(870)).toBe("2:30 PM");
    expect(fmtTime(12 * 60)).toBe("12:00 PM");
  });
  it("fmtRange", () => {
    expect(fmtRange(840, 960)).toBe("2:00–4:00 PM");
    expect(fmtRange(600, 840)).toBe("10:00 AM–2:00 PM");
    expect(fmtRange(null, null)).toBe("All day");
  });
  it("fmtDay and weekdayName", () => {
    expect(fmtDay("2026-10-17")).toBe("Sat 10/17");
    expect(weekdayName("2026-10-17")).toBe("Saturday");
  });
});

describe("overlaps", () => {
  it("is strict at the edges", () => {
    expect(overlaps(840, 960, 960, 1020)).toBe(false);
    expect(overlaps(840, 960, 900, 1020)).toBe(true);
  });
  it("treats null times as all day", () => {
    expect(overlaps(null, null, 900, 1020)).toBe(true);
  });
});

describe("NY time zone", () => {
  it("uses EDT before and EST after the November change", () => {
    expect(nyOffset("2026-10-31")).toBe("-04:00");
    expect(nyOffset("2026-11-01")).toBe("-05:00");
    expect(nyDateTime("2026-11-02", 840)).toBe("2026-11-02T14:00:00-05:00");
    expect(nyDateTime("2026-10-17", 840)).toBe("2026-10-17T14:00:00-04:00");
  });
  it("nyLocal has no offset", () => {
    expect(nyLocal("2026-10-17", 840)).toBe("2026-10-17T14:00:00");
  });
  it("nyParts converts an RFC3339 instant to NY date and minutes", () => {
    expect(nyParts("2026-10-17T18:00:00Z")).toEqual({ date: "2026-10-17", min: 14 * 60 });
    expect(nyParts("2026-10-18T02:30:00Z")).toEqual({ date: "2026-10-17", min: 22 * 60 + 30 });
  });
  it("nyToday uses the NY calendar day", () => {
    expect(nyToday(new Date("2026-10-15T03:00:00Z"))).toBe("2026-10-14");
  });
  it("addDaysIso", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
  });
  it("weekOf gives Monday to Sunday", () => {
    expect(weekOf(new Date("2026-10-12T12:00:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(weekOf(new Date("2026-10-18T12:00:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/reservation-time.test.js`
Expected: FAIL, cannot find module `reservation-time.js`.

- [ ] **Step 3: Implement**

```js
// src/lib/reservation-time.js
// Dates are "YYYY-MM-DD" strings and times are minutes after midnight, both
// in New York time. Lambda runs in UTC, so nothing here trusts the host zone.
export const TZ = "America/New_York";

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");

function utcNoon(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

export function addDaysIso(iso, n) {
  const d = utcNoon(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validIso(y, m, d) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const back = utcNoon(iso);
  return back.getUTCMonth() + 1 === m && back.getUTCDate() === d ? iso : null;
}

// "Tue, 6/23/26", "6/23/2026", or the kitchen sheet's yearless "Thu, 09/03".
// A yearless date more than 180 days before refIso belongs to next year: the
// kitchen sheet rolls forward, so in December "01/07" means January coming.
export function parseSheetDate(text, refIso) {
  const m = String(text || "").match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (m[3]) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validIso(year, month, day);
  }
  const refYear = Number(refIso.slice(0, 4));
  const iso = validIso(refYear, month, day);
  if (!iso) return null;
  const ageDays = (utcNoon(refIso) - utcNoon(iso)) / 86400000;
  return ageDays > 180 ? validIso(refYear + 1, month, day) : iso;
}

export function formatSheetDate(iso) {
  const d = utcNoon(iso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`;
}

// "6:00:00 PM", "9:00 PM", "18:30" -> minutes. Anything else -> null.
export function parseSheetTime(text) {
  const m = String(text || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].toUpperCase() === "PM";
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else if (h > 23) return null;
  return h * 60 + min;
}

export function hhmmToMin(hhmm) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

function hm(min) {
  const h24 = Math.floor(min / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return { text: `${h}:${pad(min % 60)}`, ampm: h24 < 12 ? "AM" : "PM" };
}

export function fmtTime(min) {
  const t = hm(min);
  return `${t.text} ${t.ampm}`;
}

export function fmtRange(start, end) {
  if (start == null || end == null) return "All day";
  const a = hm(start);
  const b = hm(end);
  return a.ampm === b.ampm ? `${a.text}–${b.text} ${b.ampm}` : `${a.text} ${a.ampm}–${b.text} ${b.ampm}`;
}

// Null times mean all day.
export function overlaps(aStart, aEnd, bStart, bEnd) {
  const as = aStart ?? 0, ae = aEnd ?? 1440, bs = bStart ?? 0, be = bEnd ?? 1440;
  return as < be && bs < ae;
}

export function nyOffset(iso) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(utcNoon(iso));
  const name = parts.find((p) => p.type === "timeZoneName").value; // "GMT-04:00"
  return name === "GMT" ? "+00:00" : name.slice(3);
}

export function nyLocal(iso, min) {
  return `${iso}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
}

export function nyDateTime(iso, min) {
  return `${nyLocal(iso, min)}${nyOffset(iso)}`;
}

export function nyParts(dateTime) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(dateTime)).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function nyToday(now = new Date()) {
  return nyParts(now.toISOString()).date;
}

export function weekOf(now = new Date()) {
  const today = nyToday(now);
  const dow = utcNoon(today).getUTCDay(); // 0 = Sunday
  const from = addDaysIso(today, dow === 0 ? -6 : 1 - dow);
  return { from, to: addDaysIso(from, 6) };
}

export function fmtDay(iso) {
  const d = utcNoon(iso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function weekdayName(iso) {
  return WEEKDAYS_LONG[utcNoon(iso).getUTCDay()];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/reservation-time.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-time.js tests/lib/reservation-time.test.js
git commit -m "feat(reservations): NY time zone and sheet date/time helpers"
```

---

### Task 3: Room catalog and rooms adapter

**Files:**
- Create: `src/lib/rooms-catalog.js`, `src/services/reservations/rooms.js`
- Test: `tests/lib/rooms-catalog.test.js`, `tests/services/reservations/rooms.test.js`

**Interfaces:**
- Consumes: Task 2 `parseSheetDate`, `formatSheetDate`, `parseSheetTime`, `fmtTime`, `overlaps`, `nyToday`.
- Produces: `ROOMS` (array of `{ name, aliases }`), `ALL_FH = "All FH"`, `normalizeRoom(text) -> string`, `splitRooms(cell) -> string[]`, `roomsConflict(a, b) -> boolean`; `createRoomsAdapter({ sheetsClient, spreadsheetId, tab, link, now }) -> Adapter` with `backend: "rooms"`.

- [ ] **Step 1: Write the failing catalog tests**

```js
// tests/lib/rooms-catalog.test.js
import { describe, it, expect } from "vitest";
import { normalizeRoom, splitRooms, roomsConflict, ROOMS, ALL_FH } from "../../src/lib/rooms-catalog.js";

describe("normalizeRoom", () => {
  it("maps aliases and spelling variants to one name", () => {
    expect(normalizeRoom("FH MPR")).toBe("MPR");
    expect(normalizeRoom("mpr")).toBe("MPR");
    expect(normalizeRoom("Maker Space")).toBe("Makerspace");
    expect(normalizeRoom("MakerSpace")).toBe("Makerspace");
    expect(normalizeRoom("120")).toBe("L120");
    expect(normalizeRoom("FH Glass Room")).toBe("Glass Room");
    expect(normalizeRoom("parking lot")).toBe("Parking Lot");
    expect(normalizeRoom("FH A2K Room")).toBe("A2K Room");
    expect(normalizeRoom("Staff Suite ")).toBe("Staff Suite");
    expect(normalizeRoom("All FH")).toBe(ALL_FH);
  });
  it("keeps unknown names as written", () => {
    expect(normalizeRoom("Shenandoah")).toBe("Shenandoah");
  });
});

describe("splitRooms", () => {
  it("splits on newlines and commas", () => {
    expect(splitRooms("FH Glass Room, L120, Youth Room")).toEqual(["Glass Room", "L120", "Youth Room"]);
    expect(splitRooms("Youth Room\nA2K Room")).toEqual(["Youth Room", "A2K Room"]);
    expect(splitRooms("MPR, parking lot")).toEqual(["MPR", "Parking Lot"]);
    expect(splitRooms("")).toEqual([]);
  });
});

describe("roomsConflict", () => {
  it("conflicts on any shared room", () => {
    expect(roomsConflict(["MPR"], ["Parking Lot", "MPR"])).toBe(true);
    expect(roomsConflict(["MPR"], ["L120"])).toBe(false);
  });
  it("All FH conflicts with everything", () => {
    expect(roomsConflict([ALL_FH], ["L120"])).toBe(true);
    expect(roomsConflict(["Youth Room"], [ALL_FH])).toBe(true);
  });
  it("Kitchen is not a bookable room here", () => {
    expect(ROOMS.some((r) => r.name === "Kitchen")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/rooms-catalog.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the catalog**

```js
// src/lib/rooms-catalog.js
// The room request sheet is typed by hand, so one room shows up as "MPR",
// "FH MPR" and "MPR, parking lot". Every alias here is lowercase with any
// leading "FH " already stripped. The kitchen is booked on its own sheet, so
// it is not a room here.
export const ALL_FH = "All FH";

export const ROOMS = [
  { name: "L120", aliases: ["l120", "ll120", "120", "1st floor suite", "l120: 1st floor suite"] },
  { name: "MPR", aliases: ["mpr", "multipurpose room", "multi-purpose room"] },
  { name: "Makerspace", aliases: ["makerspace", "maker space"] },
  { name: "Youth Room", aliases: ["youth room", "240", "240: youth room"] },
  { name: "A2K Room", aliases: ["a2k room", "a2k", "220", "220: a2k room"] },
  { name: "Childcare Room", aliases: ["childcare room", "childcare", "230", "230: childcare room"] },
  { name: "Dining Room", aliases: ["dining room", "dining", "200: dining room"] },
  { name: "Conference Room", aliases: ["conference room", "200: conference room"] },
  { name: "Glass Room", aliases: ["glass room", "glass conference room", "300", "300: glass conference room"] },
  { name: "Staff Suite", aliases: ["staff suite", "302", "302: staff suite"] },
  { name: "Parking Lot", aliases: ["parking lot", "parking"] },
];

const BY_ALIAS = new Map(ROOMS.flatMap((r) => [[r.name.toLowerCase(), r.name], ...r.aliases.map((a) => [a, r.name])]));

export function normalizeRoom(text) {
  const raw = String(text || "").trim();
  const key = raw.toLowerCase().replace(/^fh\s+/, "").replace(/\s+/g, " ");
  if (key === "all fh" || key === "all") return ALL_FH;
  return BY_ALIAS.get(key) || raw;
}

export function splitRooms(cell) {
  return String(cell || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeRoom);
}

export function roomsConflict(a, b) {
  if (a.includes(ALL_FH) || b.includes(ALL_FH)) return a.length > 0 && b.length > 0;
  return a.some((r) => b.includes(r));
}
```

- [ ] **Step 4: Run catalog tests**

Run: `npx vitest run tests/lib/rooms-catalog.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter tests**

```js
// tests/services/reservations/rooms.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoomsAdapter } from "../../../src/services/reservations/rooms.js";

const ROWS = [
  ["Bros LG", "Tue, 10/20/26", "6:00:00 PM", "9:00 PM", "Alex", "Alex", "L120"],
  ["Rally", "Sat, 10/24/26", "12:30:00 PM", "4:30 PM", "FFX", "Rick", "MPR, parking lot", "Approved"],
  ["Old ask", "Sat, 10/24/26", "1:00:00 PM", "2:00 PM", "RPG", "Julie", "MPR", "Denied"],
  ["Whole building", "Sun, 10/25/26", "", "", "Mgmt", "Vincent", "All FH"],
  ["AYM Xmas Event"],
];

function makeSheets(rows = ROWS) {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values: rows } }),
        append: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("rooms adapter", () => {
  let sheets;
  let adapter;
  beforeEach(() => {
    sheets = makeSheets();
    adapter = createRoomsAdapter({
      sheetsClient: sheets, spreadsheetId: "S1", tab: "Upcoming Room Requests",
      link: "https://rooms", now: () => new Date("2026-10-14T12:00:00Z"),
    });
  });

  it("reads the tab from row 2", async () => {
    await adapter.listReservations({ from: "2026-10-19", to: "2026-10-25" });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith({
      spreadsheetId: "S1", range: "'Upcoming Room Requests'!A2:I",
    });
  });

  it("lists active rows in the range, skipping denied and incomplete rows", async () => {
    const { reservations, errors } = await adapter.listReservations({ from: "2026-10-19", to: "2026-10-25" });
    expect(errors).toEqual([]);
    expect(reservations.map((r) => r.title)).toEqual(["Bros LG", "Rally", "Whole building"]);
    expect(reservations[1]).toEqual({
      category: "rooms", item: "MPR, Parking Lot", date: "2026-10-24", start: 750, end: 990,
      title: "Rally", holder: "Rick", holderUserId: null, holderEmail: null,
    });
  });

  it("filters the list by room when items are given", async () => {
    const { reservations } = await adapter.listReservations({
      from: "2026-10-19", to: "2026-10-25", items: [{ label: "L120" }],
    });
    expect(reservations.map((r) => r.title)).toEqual(["Bros LG", "Whole building"]);
  });

  it("finds an overlapping booking of a shared room", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-24", start: 840, end: 900, items: [{ label: "Parking Lot" }] });
    expect(hits.map((h) => h.title)).toEqual(["Rally"]);
  });

  it("ignores denied rows and non-overlapping times", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-24", start: 990, end: 1080, items: [{ label: "MPR" }] });
    expect(hits).toEqual([]);
  });

  it("All FH blocks every room all day", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-25", start: 600, end: 660, items: [{ label: "Youth Room" }] });
    expect(hits.map((h) => h.title)).toEqual(["Whole building"]);
  });

  it("appends a row with blank status", async () => {
    const res = await adapter.book({
      date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }, { label: "Parking Lot" }],
      title: "Youth night", ministry: "AYM", requesterName: "Deandra Shim",
    });
    expect(res).toEqual({ status: "booked", link: "https://rooms" });
    expect(sheets.spreadsheets.values.append).toHaveBeenCalledWith({
      spreadsheetId: "S1",
      range: "'Upcoming Room Requests'!A:I",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [["Youth night", "Wed, 10/28/26", "7:00 PM", "9:00 PM", "AYM", "Deandra Shim", "MPR\nParking Lot", "", "Booked via #reservations"]],
      },
    });
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/services/reservations/rooms.test.js`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement the adapter**

```js
// src/services/reservations/rooms.js
// Rooms live on Management's "Upcoming Room Requests" tab. Status is theirs to
// manage by hand, so the bot writes it blank and only treats Denied/Declined
// rows as not holding the room.
import { parseSheetDate, formatSheetDate, parseSheetTime, fmtTime, overlaps, nyToday } from "../../lib/reservation-time.js";
import { splitRooms, roomsConflict } from "../../lib/rooms-catalog.js";

const INACTIVE = new Set(["denied", "declined"]);

export function createRoomsAdapter({ sheetsClient, spreadsheetId, tab, link, now = () => new Date() }) {
  async function readRows() {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A2:I` });
    const today = nyToday(now());
    return (res.data.values || [])
      .map((r) => ({
        title: (r[0] || "").trim(),
        date: parseSheetDate(r[1], today),
        start: parseSheetTime(r[2]),
        end: parseSheetTime(r[3]),
        holder: (r[5] || "").trim(),
        rooms: splitRooms(r[6]),
        status: (r[7] || "").trim().toLowerCase(),
      }))
      .filter((r) => r.date && r.rooms.length > 0 && !INACTIVE.has(r.status));
  }

  const toReservation = (r) => ({
    category: "rooms", item: r.rooms.join(", "), date: r.date, start: r.start, end: r.end,
    title: r.title, holder: r.holder, holderUserId: null, holderEmail: null,
  });

  async function listReservations({ from, to, items }) {
    const wanted = items?.length ? items.map((i) => i.label) : null;
    const rows = (await readRows()).filter(
      (r) => r.date >= from && r.date <= to && (!wanted || roomsConflict(wanted, r.rooms))
    );
    return { reservations: rows.map(toReservation), errors: [] };
  }

  async function findConflicts({ date, start, end, items }) {
    const wanted = items.map((i) => i.label);
    return (await readRows())
      .filter((r) => r.date === date && overlaps(start, end, r.start, r.end) && roomsConflict(wanted, r.rooms))
      .map(toReservation);
  }

  async function book({ date, start, end, items, title, ministry, requesterName }) {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tab}'!A:I`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          title, formatSheetDate(date), fmtTime(start), fmtTime(end), ministry || "",
          requesterName, items.map((i) => i.label).join("\n"), "", "Booked via #reservations",
        ]],
      },
    });
    return { status: "booked", link };
  }

  return { backend: "rooms", link, listReservations, findConflicts, book };
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run tests/lib/rooms-catalog.test.js tests/services/reservations/rooms.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/rooms-catalog.js src/services/reservations/rooms.js tests/lib/rooms-catalog.test.js tests/services/reservations/rooms.test.js
git commit -m "feat(reservations): room catalog and room request sheet adapter"
```

---

### Task 4: Kitchen adapter

**Files:**
- Create: `src/services/reservations/kitchen.js`
- Test: `tests/services/reservations/kitchen.test.js`

**Interfaces:**
- Consumes: Task 2 `parseSheetDate`, `parseSheetTime`, `fmtTime`, `overlaps`, `nyToday`.
- Produces: `APPLIANCES` (array of `{ key, col, label, kind: "bool"|"count" }`), `createKitchenAdapter({ sheetsClient, spreadsheetId, tab, link, maxGroups = 3, now }) -> Adapter` with `backend: "kitchen"`. `book()` returns `unavailable` when the date has no empty row.

- [ ] **Step 1: Write the failing tests**

```js
// tests/services/reservations/kitchen.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKitchenAdapter, APPLIANCES } from "../../../src/services/reservations/kitchen.js";

const F = ["FALSE", "FALSE", "FALSE", "--", "--", "FALSE", "FALSE", "FALSE"];
const SHEET = [
  [],
  ["No more than 3 ministry groups at same cooking time frame please."],
  ["Date", "Name", "Phone Number ", "Start Time", "End Time", "Kitchen Island (3)"],
  ["SAMPLE", "Arie Chen", "530-902-3809", "5:00 PM", "7:00 PM", "TRUE"],
  ["To add MORE dates: ..."],
  [],
  ["Sat, 10/17", "RPG", "111", "5:00 PM", "7:00 PM", ...F],   // row 7
  ["Sat, 10/17", "AYM", "222", "6:00 PM", "8:00 PM", ...F],   // row 8
  ["Sat, 10/17", "", "", "", "", ...F],                        // row 9
  ["Sun, 10/18", "A", "1", "5:00 PM", "7:00 PM", ...F],       // row 10
  ["Sun, 10/18", "B", "2", "5:00 PM", "7:00 PM", ...F],       // row 11
  ["Sun, 10/18", "C", "3", "6:00 PM", "9:00 PM", ...F],       // row 12
  ["Mon, 10/19", "X", "9", "9:00 AM", "10:00 AM", ...F],      // row 13
  ["Mon, 10/19", "Y", "8", "11:00 AM", "12:00 PM", ...F],     // row 14
  ["Mon, 10/19", "Z", "7", "1:00 PM", "2:00 PM", ...F],       // row 15
];

function makeSheets(values = SHEET) {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values } }),
        batchUpdate: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("kitchen adapter", () => {
  let sheets;
  let adapter;
  beforeEach(() => {
    sheets = makeSheets();
    adapter = createKitchenAdapter({
      sheetsClient: sheets, spreadsheetId: "K1", tab: "FH-Kitchen-RSVP", link: "https://kitchen",
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
  });

  it("lists filled rows after the header, skipping SAMPLE rows", async () => {
    const { reservations } = await adapter.listReservations({ from: "2026-10-17", to: "2026-10-17" });
    expect(reservations).toEqual([
      { category: "kitchen", item: "Kitchen", date: "2026-10-17", start: 1020, end: 1140, title: "RPG", holder: "RPG (111)", holderUserId: null, holderEmail: null },
      { category: "kitchen", item: "Kitchen", date: "2026-10-17", start: 1080, end: 1200, title: "AYM", holder: "AYM (222)", holderUserId: null, holderEmail: null },
    ]);
  });

  it("has no conflict while fewer than 3 groups overlap", async () => {
    expect(await adapter.findConflicts({ date: "2026-10-17", start: 1080, end: 1140, items: [] })).toEqual([]);
  });

  it("conflicts when 3 groups already overlap, returning all three", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-18", start: 1080, end: 1110, items: [] });
    expect(hits.map((h) => h.title)).toEqual(["A", "B", "C"]);
  });

  it("fills the first empty row for the date, only touching requested appliances", async () => {
    const res = await adapter.book({
      date: "2026-10-17", start: 1020, end: 1080, requesterName: "Jina Kim", phone: "555-0100",
      appliances: { airFryer: true, largeRiceCooker: 2 },
    });
    expect(res).toEqual({ status: "booked", link: "https://kitchen" });
    expect(sheets.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "K1",
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: "'FH-Kitchen-RSVP'!B9:E9", values: [["Jina Kim", "555-0100", "5:00 PM", "6:00 PM"]] },
          { range: "'FH-Kitchen-RSVP'!L9", values: [["TRUE"]] },
          { range: "'FH-Kitchen-RSVP'!N9", values: [[2]] },
        ],
      },
    });
  });

  it("is unavailable when every row for the date is filled", async () => {
    const res = await adapter.book({ date: "2026-10-19", start: 1080, end: 1140, requesterName: "J", phone: "", appliances: {} });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/all 3 kitchen rows/i);
    expect(sheets.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
  });

  it("is unavailable when the date has no rows yet", async () => {
    const res = await adapter.book({ date: "2026-12-01", start: 1080, end: 1140, requesterName: "J", phone: "", appliances: {} });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/not open yet/i);
  });

  it("names the appliance keys the parser may use", () => {
    expect(APPLIANCES.map((a) => a.key)).toEqual([
      "island", "whiteCounter", "brownCounter", "freezer", "fridge", "toasterOven",
      "airFryer", "microwave", "largeRiceCooker", "smallRiceCooker", "instapot",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/reservations/kitchen.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/services/reservations/kitchen.js
// Arie's kitchen sheet has three pre-dated rows per day that people fill in.
// The sheet's own rule is "no more than 3 ministry groups at same cooking time
// frame". Arie rolls the dates forward by hand, so a future date may have no
// rows yet; then the bot sends people to the sheet instead of inventing rows.
import { parseSheetDate, parseSheetTime, fmtTime, overlaps, nyToday } from "../../lib/reservation-time.js";

export const APPLIANCES = [
  { key: "island", col: "F", label: "Kitchen Island", kind: "bool" },
  { key: "whiteCounter", col: "G", label: "White Counter", kind: "bool" },
  { key: "brownCounter", col: "H", label: "Brown Counter", kind: "bool" },
  { key: "freezer", col: "I", label: "Freezer shelves", kind: "count" },
  { key: "fridge", col: "J", label: "Fridge shelves", kind: "count" },
  { key: "toasterOven", col: "K", label: "Toaster Oven", kind: "bool" },
  { key: "airFryer", col: "L", label: "Air Fryer", kind: "bool" },
  { key: "microwave", col: "M", label: "Microwave", kind: "bool" },
  { key: "largeRiceCooker", col: "N", label: "Large Rice Cooker", kind: "count" },
  { key: "smallRiceCooker", col: "O", label: "8-cup Rice Cooker", kind: "count" },
  { key: "instapot", col: "P", label: "Instapot", kind: "count" },
];

export function createKitchenAdapter({ sheetsClient, spreadsheetId, tab, link, maxGroups = 3, now = () => new Date() }) {
  // Every dated row after the "Date" header, with its 1-based sheet row.
  async function readRows() {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A1:P1000` });
    const values = res.data.values || [];
    const header = values.findIndex((r) => (r[0] || "").trim() === "Date");
    const today = nyToday(now());
    const rows = [];
    for (let i = header + 1; i < values.length; i++) {
      const r = values[i] || [];
      const date = parseSheetDate(r[0], today);
      if (!date) continue;
      rows.push({
        row: i + 1,
        date,
        name: (r[1] || "").trim(),
        phone: (r[2] || "").trim(),
        start: parseSheetTime(r[3]),
        end: parseSheetTime(r[4]),
      });
    }
    return rows;
  }

  const toReservation = (r) => ({
    category: "kitchen", item: "Kitchen", date: r.date, start: r.start, end: r.end, title: r.name,
    holder: r.phone ? `${r.name} (${r.phone})` : r.name, holderUserId: null, holderEmail: null,
  });

  async function listReservations({ from, to }) {
    const rows = (await readRows()).filter((r) => r.name && r.date >= from && r.date <= to);
    return { reservations: rows.map(toReservation), errors: [] };
  }

  async function findConflicts({ date, start, end }) {
    const hits = (await readRows()).filter((r) => r.name && r.date === date && overlaps(start, end, r.start, r.end));
    return hits.length >= maxGroups ? hits.map(toReservation) : [];
  }

  async function book({ date, start, end, requesterName, phone, appliances = {} }) {
    const sameDay = (await readRows()).filter((r) => r.date === date);
    if (sameDay.length === 0) {
      return { status: "unavailable", reason: "The kitchen sheet is not open yet for that date.", link };
    }
    const free = sameDay.find((r) => !r.name);
    if (!free) {
      return { status: "unavailable", reason: `All ${sameDay.length} kitchen rows for that day are taken.`, link };
    }
    const data = [
      { range: `'${tab}'!B${free.row}:E${free.row}`, values: [[requesterName, phone || "", fmtTime(start), fmtTime(end)]] },
    ];
    for (const a of APPLIANCES) {
      const v = appliances[a.key];
      if (v == null || v === false) continue;
      data.push({ range: `'${tab}'!${a.col}${free.row}`, values: [[a.kind === "bool" ? "TRUE" : Number(v)]] });
    }
    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data },
    });
    return { status: "booked", link };
  }

  return { backend: "kitchen", link, listReservations, findConflicts, book };
}
```

Note: "All 3 kitchen rows" in the test matches `All ${sameDay.length} kitchen rows` because the fixture has 3 rows for 10/19.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/services/reservations/kitchen.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/reservations/kitchen.js tests/services/reservations/kitchen.test.js
git commit -m "feat(reservations): kitchen sheet adapter with 3-group limit"
```

---

### Task 5: RMS catalog and calendar adapter

**Files:**
- Create: `src/lib/rms-catalog.js`, `src/services/reservations/rms.js`
- Test: `tests/lib/rms-catalog.test.js`, `tests/services/reservations/rms.test.js`

**Interfaces:**
- Consumes: Task 2 `TZ`, `nyDateTime`, `nyLocal`, `nyParts`, `addDaysIso`, `overlaps`.
- Produces: `buildRmsCatalog(resourceCalendars) -> CatalogEntry[]` (`backend: "rms"`, category `tech|sports|outreach|accessories`); `calendarLink(calendarId) -> string`; `createRmsAdapter({ calendarClient, bookingEnabled = true, botCalendarId = "primary", concurrency = 8, sleep }) -> Adapter` with `backend: "rms"`. `listReservations` and `findConflicts` take `items` as RMS catalog entries; `listReservations` with no items needs `catalog` passed at construction — so the factory also takes `catalog`.

Final signature: `createRmsAdapter({ calendarClient, catalog, bookingEnabled = true, botCalendarId = "primary", concurrency = 8, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) })`.

- [ ] **Step 1: Write the failing catalog tests**

```js
// tests/lib/rms-catalog.test.js
import { describe, it, expect } from "vitest";
import { buildRmsCatalog, calendarLink } from "../../src/lib/rms-catalog.js";

const RC = {
  "DMV Tech Equipment-G-Tech Set 1": "tech1@resource.calendar.google.com",
  "DMV Sports Equipment-G-Kickball": "kick@resource.calendar.google.com",
  "DMV Sports Equipment-G-Cube Cooler": "cube-s@resource.calendar.google.com",
  "DMV Outreach Supplies-G-Sub soccer": "sub-o@resource.calendar.google.com",
  "DMV Accessories-Sub Soccer": "sub-a@resource.calendar.google.com",
  "DMV Accessories-1-Large chest cooler": "chest@resource.calendar.google.com",
  "DMV Accessories-Cube Cooler 1": "cube1@resource.calendar.google.com",
  "DMV Venues-3-FH MPR (100)": "mpr@resource.calendar.google.com",
  "DMV-Vehicles-Airstream": "air@resource.calendar.google.com",
};

describe("buildRmsCatalog", () => {
  it("labels and categorises bookable groups and drops venues and vehicles", () => {
    const cat = buildRmsCatalog(RC);
    expect(cat).toContainEqual({ label: "Tech Set 1", category: "tech", backend: "rms", calendarId: "tech1@resource.calendar.google.com" });
    expect(cat).toContainEqual({ label: "Kickball", category: "sports", backend: "rms", calendarId: "kick@resource.calendar.google.com" });
    expect(cat).toContainEqual({ label: "Large chest cooler", category: "accessories", backend: "rms", calendarId: "chest@resource.calendar.google.com" });
    expect(cat.some((e) => /MPR|Airstream/.test(e.label))).toBe(false);
  });
  it("disambiguates duplicate labels with the group name", () => {
    const labels = buildRmsCatalog(RC).map((e) => e.label);
    expect(labels).toContain("Sub soccer (Outreach)");
    expect(labels).toContain("Sub Soccer (Accessories)");
    expect(labels).toContain("Cube Cooler");
    expect(labels).toContain("Cube Cooler 1");
  });
  it("tolerates a missing or bad config", () => {
    expect(buildRmsCatalog(undefined)).toEqual([]);
    expect(buildRmsCatalog("nope")).toEqual([]);
  });
});

describe("calendarLink", () => {
  it("opens the resource calendar", () => {
    expect(calendarLink("a@b")).toBe("https://calendar.google.com/calendar/u/0/r?cid=a%40b");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/rms-catalog.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the catalog**

```js
// src/lib/rms-catalog.js
// RESOURCE_CALENDARS maps the Workspace resource name to its calendar id, e.g.
// "DMV Tech Equipment-G-Tech Set 1". Venues and vehicles are out of scope:
// rooms are booked on the room request sheet instead.
const GROUPS = [
  ["DMV Tech Equipment-", "tech", "Tech"],
  ["DMV Sports Equipment-", "sports", "Sports"],
  ["DMV Outreach Supplies-", "outreach", "Outreach"],
  ["DMV Accessories-", "accessories", "Accessories"],
];

export function buildRmsCatalog(resourceCalendars) {
  if (!resourceCalendars || typeof resourceCalendars !== "object") return [];
  const entries = [];
  for (const [name, calendarId] of Object.entries(resourceCalendars)) {
    const group = GROUPS.find(([prefix]) => name.startsWith(prefix));
    if (!group || typeof calendarId !== "string") continue;
    const label = name.slice(group[0].length).replace(/^G-/, "").replace(/^\d+-/, "").trim();
    entries.push({ label, category: group[1], groupName: group[2], calendarId });
  }
  const counts = new Map();
  for (const e of entries) counts.set(e.label.toLowerCase(), (counts.get(e.label.toLowerCase()) || 0) + 1);
  return entries.map(({ label, category, groupName, calendarId }) => ({
    label: counts.get(label.toLowerCase()) > 1 ? `${label} (${groupName})` : label,
    category,
    backend: "rms",
    calendarId,
  }));
}

export function calendarLink(calendarId) {
  return `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(calendarId)}`;
}
```

- [ ] **Step 4: Run catalog tests**

Run: `npx vitest run tests/lib/rms-catalog.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter tests**

```js
// tests/services/reservations/rms.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRmsAdapter } from "../../../src/services/reservations/rms.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "set2@resource.calendar.google.com" };
const POOL = { label: "Kiddie Pool", category: "accessories", backend: "rms", calendarId: "pool@resource.calendar.google.com" };

function ev(summary, startIso, endIso, extra = {}) {
  return { summary, start: { dateTime: startIso }, end: { dateTime: endIso }, status: "confirmed", ...extra };
}

function makeCalendar() {
  return {
    events: {
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
      insert: vi.fn().mockResolvedValue({ data: { id: "E1" } }),
      get: vi.fn().mockResolvedValue({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "accepted" }] } }),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("rms adapter", () => {
  let cal;
  let adapter;
  beforeEach(() => {
    cal = makeCalendar();
    adapter = createRmsAdapter({ calendarClient: cal, catalog: [SET2, POOL], sleep: async () => {} });
  });

  it("lists every catalog calendar over the NY window", async () => {
    cal.events.list.mockImplementation(async ({ calendarId }) => ({
      data: { items: calendarId === SET2.calendarId ? [ev("Youth night — Deandra", "2026-10-17T14:00:00-04:00", "2026-10-17T16:00:00-04:00", { organizer: { email: "alan@acts2.network", displayName: "Alan Chow" } })] : [] },
    }));
    const { reservations, errors } = await adapter.listReservations({ from: "2026-10-12", to: "2026-10-18" });
    expect(errors).toEqual([]);
    expect(cal.events.list).toHaveBeenCalledWith({
      calendarId: SET2.calendarId, timeMin: "2026-10-12T00:00:00-04:00", timeMax: "2026-10-19T00:00:00-04:00",
      singleEvents: true, orderBy: "startTime", maxResults: 250,
    });
    expect(reservations).toEqual([{
      category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 960,
      title: "Youth night — Deandra", holder: "Alan Chow", holderUserId: null, holderEmail: "alan@acts2.network",
    }]);
  });

  it("reads the requester back out of bot-made events", async () => {
    cal.events.list.mockResolvedValueOnce({
      data: { items: [ev("Rally — Jina", "2026-10-17T14:00:00-04:00", "2026-10-17T15:00:00-04:00", {
        organizer: { email: "bot@x", self: true },
        description: "Requested by: Jina Kim\nSlack: <@U123>\nhttps://slack/p1",
      })] },
    });
    const { reservations } = await adapter.listReservations({ from: "2026-10-17", to: "2026-10-17", items: [SET2] });
    expect(reservations[0]).toMatchObject({ holder: "Jina Kim", holderUserId: "U123" });
  });

  it("reports one failed calendar without failing the rest", async () => {
    cal.events.list.mockImplementation(async ({ calendarId }) => {
      if (calendarId === POOL.calendarId) throw new Error("403 forbidden");
      return { data: { items: [] } };
    });
    const { reservations, errors } = await adapter.listReservations({ from: "2026-10-12", to: "2026-10-18" });
    expect(reservations).toEqual([]);
    expect(errors).toEqual(["Kiddie Pool: 403 forbidden"]);
  });

  it("throws when every calendar fails", async () => {
    cal.events.list.mockRejectedValue(new Error("invalid_grant"));
    await expect(adapter.listReservations({ from: "2026-10-12", to: "2026-10-18" })).rejects.toThrow(/invalid_grant/);
  });

  it("finds an overlapping event and skips cancelled and all-day-free ones", async () => {
    cal.events.list.mockResolvedValue({ data: { items: [
      ev("A", "2026-10-17T13:00:00-04:00", "2026-10-17T14:30:00-04:00"),
      ev("B", "2026-10-17T16:00:00-04:00", "2026-10-17T17:00:00-04:00"),
      ev("C", "2026-10-17T14:00:00-04:00", "2026-10-17T15:00:00-04:00", { status: "cancelled" }),
    ] } });
    const hits = await adapter.findConflicts({ date: "2026-10-17", start: 840, end: 960, items: [SET2] });
    expect(hits.map((h) => h.title)).toEqual(["A"]);
  });

  it("books by inviting the resource and returns booked once accepted", async () => {
    const res = await adapter.book({
      date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night",
      requesterName: "Deandra Shim", requesterUserId: "U9", permalink: "https://slack/p",
    });
    expect(res).toEqual({ status: "booked", link: "https://calendar.google.com/calendar/u/0/r?cid=set2%40resource.calendar.google.com" });
    expect(cal.events.insert).toHaveBeenCalledWith({
      calendarId: "primary",
      sendUpdates: "none",
      requestBody: {
        summary: "Youth night — Deandra Shim",
        description: "Requested by: Deandra Shim\nSlack: <@U9>\nhttps://slack/p",
        start: { dateTime: "2026-10-17T14:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-10-17T16:00:00", timeZone: "America/New_York" },
        attendees: [{ email: SET2.calendarId, resource: true }],
      },
    });
  });

  it("deletes the event and reports unavailable when a resource declines", async () => {
    cal.events.get.mockResolvedValue({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "declined" }] } });
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/declined/i);
    expect(cal.events.delete).toHaveBeenCalledWith({ calendarId: "primary", eventId: "E1", sendUpdates: "none" });
  });

  it("does not write when booking is disabled", async () => {
    const off = createRmsAdapter({ calendarClient: cal, catalog: [SET2], bookingEnabled: false, sleep: async () => {} });
    const res = await off.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/Google Calendar/);
    expect(cal.events.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/services/reservations/rms.test.js`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement the adapter**

```js
// src/services/reservations/rms.js
// Tech, sports, outreach and accessories are Workspace resource calendars
// (RMS). The bot only has reader access to them, so it books by creating an
// event on its own calendar with the resource as an attendee; the resource
// accepts or declines it. RMS_BOOKING_ENABLED=false turns writes off, for when
// the bot's account can't book resources.
import { TZ, nyDateTime, nyLocal, nyParts, addDaysIso, overlaps } from "../../lib/reservation-time.js";
import { calendarLink } from "../../lib/rms-catalog.js";

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function holderOf(e) {
  const desc = e.description || "";
  const userId = desc.match(/Slack: <@([A-Z0-9]+)>/)?.[1] || null;
  const name = desc.match(/Requested by: (.+)/)?.[1]?.trim();
  if (e.organizer?.self && name) return { holder: name, holderUserId: userId, holderEmail: null };
  const email = e.organizer?.email || e.creator?.email || null;
  return { holder: e.organizer?.displayName || email || "someone", holderUserId: userId, holderEmail: email };
}

function toReservation(entry, e) {
  const allDay = !e.start?.dateTime;
  const s = allDay ? null : nyParts(e.start.dateTime);
  const en = allDay ? null : nyParts(e.end.dateTime);
  return {
    category: entry.category,
    item: entry.label,
    date: allDay ? e.start.date : s.date,
    start: allDay ? null : s.min,
    // An event running past midnight blocks the rest of its first day.
    end: allDay ? null : en.date === s.date ? en.min : 1440,
    title: e.summary || "",
    ...holderOf(e),
  };
}

export function createRmsAdapter({
  calendarClient, catalog, bookingEnabled = true, botCalendarId = "primary", concurrency = 8,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const link = "https://calendar.google.com";

  async function eventsFor(entry, from, to) {
    const res = await calendarClient.events.list({
      calendarId: entry.calendarId,
      timeMin: nyDateTime(from, 0),
      timeMax: nyDateTime(addDaysIso(to, 1), 0),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    return (res.data.items || []).filter((e) => e.status !== "cancelled").map((e) => toReservation(entry, e));
  }

  async function listReservations({ from, to, items }) {
    const entries = items?.length ? items : catalog;
    const results = await mapLimit(entries, concurrency, async (entry) => {
      try {
        return { ok: await eventsFor(entry, from, to) };
      } catch (err) {
        return { error: `${entry.label}: ${err.message}` };
      }
    });
    const errors = results.filter((r) => r.error).map((r) => r.error);
    if (entries.length > 0 && errors.length === entries.length) throw new Error(errors[0]);
    return { reservations: results.flatMap((r) => r.ok || []), errors };
  }

  async function findConflicts({ date, start, end, items }) {
    const lists = await mapLimit(items, concurrency, (entry) => eventsFor(entry, date, date));
    return lists.flat().filter((r) => r.date === date && overlaps(start, end, r.start, r.end));
  }

  async function book({ date, start, end, items, title, requesterName, requesterUserId, permalink }) {
    const itemLink = calendarLink(items[0].calendarId);
    if (!bookingEnabled) {
      return { status: "unavailable", reason: "Please book this one in Google Calendar (RMS) for now.", link: itemLink };
    }
    const res = await calendarClient.events.insert({
      calendarId: botCalendarId,
      sendUpdates: "none",
      requestBody: {
        summary: `${title} — ${requesterName}`,
        description: `Requested by: ${requesterName}\nSlack: <@${requesterUserId}>\n${permalink}`,
        start: { dateTime: nyLocal(date, start), timeZone: TZ },
        end: { dateTime: nyLocal(date, end), timeZone: TZ },
        attendees: items.map((i) => ({ email: i.calendarId, resource: true })),
      },
    });
    const eventId = res.data.id;
    // Resources answer the invite a moment after it is created.
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1000);
      const got = await calendarClient.events.get({ calendarId: botCalendarId, eventId });
      const resources = (got.data.attendees || []).filter((a) => a.resource);
      const declined = resources.filter((a) => a.responseStatus === "declined");
      if (declined.length > 0) {
        await calendarClient.events.delete({ calendarId: botCalendarId, eventId, sendUpdates: "none" });
        return { status: "unavailable", reason: "The calendar declined the booking (it may already be taken).", link: itemLink };
      }
      if (resources.every((a) => a.responseStatus === "accepted")) break;
    }
    return { status: "booked", link: itemLink };
  }

  return { backend: "rms", link, listReservations, findConflicts, book };
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run tests/lib/rms-catalog.test.js tests/services/reservations/rms.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/rms-catalog.js src/services/reservations/rms.js tests/lib/rms-catalog.test.js tests/services/reservations/rms.test.js
git commit -m "feat(reservations): RMS resource calendar catalog and adapter"
```

---

### Task 6: Catalog, request parsing and validation

**Files:**
- Create: `src/lib/reservation-catalog.js`, `src/lib/reservation-request.js`
- Modify: `src/services/llm.js` (add `parseReservationRequest` and its prompt; export it from the returned object)
- Test: `tests/lib/reservation-catalog.test.js`, `tests/lib/reservation-request.test.js`, `tests/services/llm.test.js` (append)

**Interfaces:**
- Consumes: Task 3 `ROOMS`; Task 4 `APPLIANCES`; Task 5 catalog entries; Task 2 `hhmmToMin`.
- Produces:
  - `CATEGORY_NAMES` (`{ rooms: "Rooms", kitchen: "Kitchen", tech: "Tech", sports: "Sports", outreach: "Outreach", accessories: "Accessories" }`)
  - `buildCatalog({ rooms: boolean, kitchen: boolean, rms: CatalogEntry[] }) -> CatalogEntry[]`
  - `findItem(catalog, label) -> CatalogEntry|null` (case-insensitive)
  - `catalogPromptText(catalog) -> string`
  - `normalizeRequest(raw, catalog) -> Request` where `Request = { intent, items: CatalogEntry[], unmatched: string[], ambiguous: [{ phrase, options: CatalogEntry[] }], date, toDate, start, end, title, ministry, appliances }` (`start`/`end` minutes or null)
  - `missingFields(req) -> string[]` (subset of `"what to book"`, `"date"`, `"start and end time"`, `"what it's for"`)
  - `llmService.parseReservationRequest(transcript, { catalogText, today, weekday }) -> object|null`

- [ ] **Step 1: Write the failing catalog and request tests**

```js
// tests/lib/reservation-catalog.test.js
import { describe, it, expect } from "vitest";
import { buildCatalog, findItem, catalogPromptText } from "../../src/lib/reservation-catalog.js";

const RMS = [
  { label: "Tech Set 1", category: "tech", backend: "rms", calendarId: "t1" },
  { label: "Kickball", category: "sports", backend: "rms", calendarId: "k" },
];

describe("reservation catalog", () => {
  it("joins rooms, kitchen and RMS entries", () => {
    const cat = buildCatalog({ rooms: true, kitchen: true, rms: RMS });
    expect(findItem(cat, "mpr")).toEqual({ label: "MPR", category: "rooms", backend: "rooms" });
    expect(findItem(cat, "Kitchen")).toEqual({ label: "Kitchen", category: "kitchen", backend: "kitchen" });
    expect(findItem(cat, "tech set 1")).toEqual(RMS[0]);
    expect(findItem(cat, "projector")).toBeNull();
  });
  it("leaves out backends that are not configured", () => {
    const cat = buildCatalog({ rooms: false, kitchen: false, rms: RMS });
    expect(findItem(cat, "MPR")).toBeNull();
    expect(findItem(cat, "Kitchen")).toBeNull();
  });
  it("lists items per category for the prompt", () => {
    const text = catalogPromptText(buildCatalog({ rooms: true, kitchen: true, rms: RMS }));
    expect(text).toContain("Rooms: L120, MPR");
    expect(text).toContain("Kitchen: Kitchen");
    expect(text).toContain("Tech: Tech Set 1");
    expect(text).toContain("Sports: Kickball");
  });
});
```

```js
// tests/lib/reservation-request.test.js
import { describe, it, expect } from "vitest";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { normalizeRequest, missingFields } from "../../src/lib/reservation-request.js";

const CAT = buildCatalog({ rooms: true, kitchen: true, rms: [{ label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" }] });

describe("normalizeRequest", () => {
  it("keeps known items, converts times, drops bad values", () => {
    const req = normalizeRequest({
      intent: "book", items: ["tech set 2", "Hologram"], date: "2026-10-17", start: "14:00", end: "16:00",
      title: "Youth night", ministry: "AYM", appliances: { airFryer: true, bogus: true, largeRiceCooker: 2 },
    }, CAT);
    expect(req.intent).toBe("book");
    expect(req.items.map((i) => i.label)).toEqual(["Tech Set 2"]);
    expect(req.unmatched).toEqual(["Hologram"]);
    expect([req.date, req.start, req.end]).toEqual(["2026-10-17", 840, 960]);
    expect(req.appliances).toEqual({ airFryer: true, largeRiceCooker: 2 });
  });
  it("treats an unknown intent as other", () => {
    expect(normalizeRequest({ intent: "chitchat" }, CAT).intent).toBe("other");
    expect(normalizeRequest(null, CAT).intent).toBe("other");
  });
  it("drops a time range whose end is not after its start", () => {
    const req = normalizeRequest({ intent: "book", items: ["MPR"], date: "2026-10-17", start: "16:00", end: "14:00", title: "x" }, CAT);
    expect([req.start, req.end]).toEqual([null, null]);
    expect(missingFields(req)).toEqual(["start and end time"]);
  });
  it("keeps only ambiguity options that exist", () => {
    const req = normalizeRequest({ intent: "book", ambiguous: [{ phrase: "the speaker", options: ["Tech Set 2", "Tech Set 9"] }] }, CAT);
    expect(req.ambiguous).toEqual([{ phrase: "the speaker", options: [CAT.find((c) => c.label === "Tech Set 2")] }]);
  });
  it("rejects malformed dates", () => {
    expect(normalizeRequest({ intent: "book", date: "next sat" }, CAT).date).toBeNull();
  });
});

describe("missingFields", () => {
  it("lists everything a booking still needs", () => {
    expect(missingFields(normalizeRequest({ intent: "book" }, CAT))).toEqual([
      "what to book", "date", "start and end time", "what it's for",
    ]);
  });
  it("is empty for a complete booking", () => {
    const req = normalizeRequest({ intent: "book", items: ["MPR"], date: "2026-10-17", start: "14:00", end: "16:00", title: "x" }, CAT);
    expect(missingFields(req)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/reservation-catalog.test.js tests/lib/reservation-request.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement catalog and request**

```js
// src/lib/reservation-catalog.js
// Every bookable thing across the three backends, so the parser can be told
// exactly what exists and every answer can be checked back against it.
import { ROOMS } from "./rooms-catalog.js";

export const CATEGORY_NAMES = {
  rooms: "Rooms", kitchen: "Kitchen", tech: "Tech", sports: "Sports", outreach: "Outreach", accessories: "Accessories",
};

export function buildCatalog({ rooms, kitchen, rms }) {
  return [
    ...(rooms ? ROOMS.map((r) => ({ label: r.name, category: "rooms", backend: "rooms" })) : []),
    ...(kitchen ? [{ label: "Kitchen", category: "kitchen", backend: "kitchen" }] : []),
    ...(rms || []),
  ];
}

export function findItem(catalog, label) {
  const key = String(label || "").trim().toLowerCase();
  return catalog.find((e) => e.label.toLowerCase() === key) || null;
}

export function catalogPromptText(catalog) {
  return Object.entries(CATEGORY_NAMES)
    .map(([id, name]) => [name, catalog.filter((e) => e.category === id).map((e) => e.label)])
    .filter(([, labels]) => labels.length > 0)
    .map(([name, labels]) => `${name}: ${labels.join(", ")}`)
    .join("\n");
}
```

```js
// src/lib/reservation-request.js
// The model's JSON is a suggestion. Everything is checked back against the
// catalog and simple formats, so a hallucinated item or a garbled time is
// asked about instead of booked.
import { findItem } from "./reservation-catalog.js";
import { hhmmToMin } from "./reservation-time.js";
import { APPLIANCES } from "../services/reservations/kitchen.js";

const INTENTS = new Set(["book", "check", "list", "other"]);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function normalizeRequest(raw, catalog) {
  const r = raw && typeof raw === "object" ? raw : {};
  const items = [];
  const unmatched = [];
  for (const label of Array.isArray(r.items) ? r.items : []) {
    const hit = findItem(catalog, label);
    if (hit) {
      if (!items.includes(hit)) items.push(hit);
    } else if (str(label)) unmatched.push(str(label));
  }
  for (const phrase of Array.isArray(r.unmatched) ? r.unmatched : []) if (str(phrase)) unmatched.push(str(phrase));

  const ambiguous = (Array.isArray(r.ambiguous) ? r.ambiguous : [])
    .map((a) => ({ phrase: str(a?.phrase) || "that", options: (a?.options || []).map((o) => findItem(catalog, o)).filter(Boolean) }))
    .filter((a) => a.options.length > 0);

  let start = hhmmToMin(r.start);
  let end = hhmmToMin(r.end);
  if (start == null || end == null || end <= start) {
    start = null;
    end = null;
  }

  const appliances = {};
  const raws = r.appliances && typeof r.appliances === "object" ? r.appliances : {};
  for (const a of APPLIANCES) {
    const v = raws[a.key];
    if (a.kind === "bool" && v === true) appliances[a.key] = true;
    if (a.kind === "count" && Number.isInteger(v) && v > 0) appliances[a.key] = v;
  }

  return {
    intent: INTENTS.has(r.intent) ? r.intent : "other",
    items,
    unmatched,
    ambiguous,
    date: ISO.test(r.date || "") ? r.date : null,
    toDate: ISO.test(r.toDate || "") ? r.toDate : null,
    start,
    end,
    title: str(r.title),
    ministry: str(r.ministry),
    appliances,
  };
}

export function missingFields(req) {
  const missing = [];
  if (req.items.length === 0) missing.push("what to book");
  if (!req.date) missing.push("date");
  if (req.start == null) missing.push("start and end time");
  if (!req.title) missing.push("what it's for");
  return missing;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/reservation-catalog.test.js tests/lib/reservation-request.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing LLM tests (append to `tests/services/llm.test.js`)**

```js
describe("parseReservationRequest", () => {
  function svcWith(content) {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: content }] });
    return { svc: createLlmService({ messages: { create } }), create };
  }
  const ctx = { catalogText: "Tech: Tech Set 2", today: "2026-10-14", weekday: "Wednesday" };

  it("returns the parsed JSON object", async () => {
    const { svc, create } = svcWith('Sure: {"intent":"book","items":["Tech Set 2"],"date":"2026-10-17","start":"14:00","end":"16:00","title":"Youth night"}');
    const out = await svc.parseReservationRequest("Member: book tech set 2 sat 2-4 for youth night", ctx);
    expect(out).toEqual({ intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" });
    const call = create.mock.calls[0][0];
    expect(call.system).toContain("Tech: Tech Set 2");
    expect(call.system).toContain("2026-10-14 (Wednesday)");
    expect(call.messages[0].content).toContain("book tech set 2");
  });

  it("returns null on a non-JSON reply", async () => {
    const { svc } = svcWith("I can't help with that");
    expect(await svc.parseReservationRequest("Member: hi", ctx)).toBeNull();
  });

  it("returns null when the call fails", async () => {
    const svc = createLlmService({ messages: { create: vi.fn().mockRejectedValue(new Error("throttled")) } });
    expect(await svc.parseReservationRequest("Member: hi", ctx)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/services/llm.test.js`
Expected: FAIL, `svc.parseReservationRequest is not a function`.

- [ ] **Step 7: Implement in `src/services/llm.js`**

Add after `SYSTEM_PROMPT_LANDLORD`:

```js
function reservationPrompt({ catalogText, today, weekday }) {
  return `You read messages in a community building's #reservations Slack channel. Output ONLY a JSON object describing the newest request in the conversation.

Today is ${today} (${weekday}). Time zone: America/New_York.

Bookable items, by category:
${catalogText}

Kitchen appliance keys: island, whiteCounter, brownCounter, toasterOven, airFryer, microwave (true when wanted); freezer, fridge (number of shelves); largeRiceCooker, smallRiceCooker, instapot (how many).

JSON fields:
- "intent": "book" (wants to reserve), "check" (asks if something is free), "list" (asks what is booked or who has something), or "other" (anything else, including thanks and chatter).
- "items": exact item names from the list above.
- "unmatched": phrases naming things to book that match nothing in the list.
- "ambiguous": [{"phrase": <what they wrote>, "options": [exact item names]}] when a phrase could mean several items, e.g. "a tech set".
- "date": "YYYY-MM-DD" for the day (the first day for a range). Resolve "Saturday", "tomorrow", "next Friday" from today.
- "toDate": "YYYY-MM-DD" last day of a range ("this weekend", "next week"), else null.
- "start", "end": 24-hour "HH:MM". "2-4" for an evening or youth event means 14:00-16:00 unless the context says morning.
- "title": what the booking is for, short. "ministry": the group, if named.
- "appliances": only for the kitchen, keys from the list above.

The conversation may include the bot's own questions; combine the member's answers with their original request. Use null or [] for anything not stated. Never invent items, dates or times.

Output only the JSON object, no prose.`;
}
```

Add inside `createLlmService`, after `writeLandlordTicket`:

```js
  // Turns a #reservations conversation into a request object. Returns null
  // when the call fails or the reply isn't JSON; the caller validates every
  // field against the catalog.
  async function parseReservationRequest(transcript, { catalogText, today, weekday }) {
    if (!String(transcript || "").trim()) return null;
    try {
      const raw = await complete("parseReservationRequest", reservationPrompt({ catalogText, today, weekday }), transcript, 512);
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return null;
      return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return null;
    }
  }
```

And add `parseReservationRequest,` to the returned object.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run tests/services/llm.test.js tests/lib/reservation-catalog.test.js tests/lib/reservation-request.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reservation-catalog.js src/lib/reservation-request.js src/services/llm.js tests/lib/reservation-catalog.test.js tests/lib/reservation-request.test.js tests/services/llm.test.js
git commit -m "feat(reservations): item catalog and LLM request parsing with validation"
```

---

### Task 7: Formatting and the Slack message flow

**Files:**
- Create: `src/lib/reservation-format.js`, `src/events/reservations.js`
- Test: `tests/lib/reservation-format.test.js`, `tests/events/reservations.test.js`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `reservationLine(r) -> string` e.g. `• 2:00–4:00 PM · Tech Set 2 · Youth night (Alan Chow)`
  - `buildDigest({ from, to, reservations, maxChars = 3500 }) -> string[]`
  - `CLOSED_METADATA = { event_type: "reservation_closed", event_payload: {} }`
  - `BOT_PERSONA = { username: "FH Reservations", icon_emoji: ":calendar:" }`
  - `createReservationsHandler({ llm, adapters, catalog, channelId, now }) -> { channelId, handleMessage({ event, client }) }` where `adapters` is `{ rooms?, kitchen?, rms? }` keyed by `backend`.

- [ ] **Step 1: Write the failing format tests**

```js
// tests/lib/reservation-format.test.js
import { describe, it, expect } from "vitest";
import { reservationLine, buildDigest } from "../../src/lib/reservation-format.js";

const R = (o) => ({ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 960, title: "Youth night", holder: "Alan Chow", holderUserId: null, holderEmail: null, ...o });

describe("reservationLine", () => {
  it("shows time, item, title and holder", () => {
    expect(reservationLine(R())).toBe("• 2:00–4:00 PM · Tech Set 2 · Youth night (Alan Chow)");
  });
  it("mentions a known Slack user and handles all-day and blank titles", () => {
    expect(reservationLine(R({ start: null, end: null, title: "", holderUserId: "U1" }))).toBe("• All day · Tech Set 2 (<@U1>)");
  });
});

describe("buildDigest", () => {
  it("groups by day then category in time order, skipping empty days", () => {
    const [msg] = buildDigest({
      from: "2026-10-12", to: "2026-10-18",
      reservations: [
        R({ date: "2026-10-17", start: 900, title: "Later" }),
        R({ date: "2026-10-17", start: 600, end: 660, title: "Earlier" }),
        R({ category: "rooms", item: "MPR", date: "2026-10-13", start: 1140, end: 1320, title: "Equipping", holder: "John" }),
      ],
    });
    expect(msg).toBe([
      "*Reservations this week: Mon 10/12 – Sun 10/18*",
      "",
      "*Tue 10/13*",
      "_Rooms_",
      "• 7:00–10:00 PM · MPR · Equipping (John)",
      "",
      "*Sat 10/17*",
      "_Tech_",
      "• 10:00–11:00 AM · Tech Set 2 · Earlier (Alan Chow)",
      "• 3:00–4:00 PM · Tech Set 2 · Later (Alan Chow)",
    ].join("\n"));
  });
  it("says so when the week is empty", () => {
    expect(buildDigest({ from: "2026-10-12", to: "2026-10-18", reservations: [] })).toEqual([
      "*Reservations this week: Mon 10/12 – Sun 10/18*\n\nNo reservations this week.",
    ]);
  });
  it("splits a long week at day boundaries", () => {
    const many = Array.from({ length: 40 }, (_, i) => R({ date: i < 20 ? "2026-10-13" : "2026-10-14", title: `Event ${i}` }));
    const parts = buildDigest({ from: "2026-10-12", to: "2026-10-18", reservations: many, maxChars: 1200 });
    expect(parts.length).toBe(2);
    expect(parts[1].startsWith("*Wed 10/14*")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/reservation-format.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement formatting**

```js
// src/lib/reservation-format.js
import { fmtRange, fmtDay } from "./reservation-time.js";
import { CATEGORY_NAMES } from "./reservation-catalog.js";

export const BOT_PERSONA = { username: "FH Reservations", icon_emoji: ":calendar:" };

// Marks a thread as finished so later replies ("thanks!") are never parsed
// into a second booking.
export const CLOSED_METADATA = { event_type: "reservation_closed", event_payload: {} };

export function holderText(r) {
  return r.holderUserId ? `<@${r.holderUserId}>` : r.holder || "someone";
}

export function reservationLine(r) {
  const title = r.title ? ` · ${r.title}` : "";
  return `• ${fmtRange(r.start, r.end)} · ${r.item}${title} (${holderText(r)})`;
}

const byStart = (a, b) => (a.start ?? -1) - (b.start ?? -1);

export function buildDigest({ from, to, reservations, maxChars = 3500 }) {
  const header = `*Reservations this week: ${fmtDay(from)} – ${fmtDay(to)}*`;
  if (reservations.length === 0) return [`${header}\n\nNo reservations this week.`];

  const days = [...new Set(reservations.map((r) => r.date))].sort();
  const blocks = days.map((date) => {
    const lines = [`*${fmtDay(date)}*`];
    for (const [id, name] of Object.entries(CATEGORY_NAMES)) {
      const rs = reservations.filter((r) => r.date === date && r.category === id).sort(byStart);
      if (rs.length === 0) continue;
      lines.push(`_${name}_`, ...rs.map(reservationLine));
    }
    return lines.join("\n");
  });

  const parts = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > maxChars && current !== header) {
      parts.push(current);
      current = block;
    } else {
      current = `${current}\n\n${block}`;
    }
  }
  parts.push(current);
  return parts;
}
```

- [ ] **Step 4: Run format tests**

Run: `npx vitest run tests/lib/reservation-format.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing flow tests**

```js
// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });

function makeAdapter(backend) {
  return {
    backend,
    link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn().mockResolvedValue({ status: "booked", link: `https://${backend}/item` }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
      getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack/p1" }),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555-0100" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

const BOOK = { intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" };
const msg = (o = {}) => ({ type: "message", channel: "CRES", user: "U9", text: "book tech set 2 sat 2-4 for youth night", ts: "100.1", ...o });

describe("reservations handler", () => {
  let llm, adapters, client, h;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => new Date("2026-10-14T16:00:00Z") });
  });
  const posts = () => client.chat.postMessage.mock.calls.map((c) => c[0]);

  it("exposes its channel", () => {
    expect(h.channelId).toBe("CRES");
  });

  it("ignores other channels, bots and edits", async () => {
    await h.handleMessage({ event: msg({ channel: "COTHER" }), client });
    await h.handleMessage({ event: msg({ bot_id: "B1" }), client });
    await h.handleMessage({ event: msg({ subtype: "message_changed" }), client });
    expect(llm.parseReservationRequest).not.toHaveBeenCalled();
  });

  it("parses a top-level message with today's date context", async () => {
    await h.handleMessage({ event: msg(), client });
    expect(llm.parseReservationRequest).toHaveBeenCalledWith(
      "Member: book tech set 2 sat 2-4 for youth night",
      expect.objectContaining({ today: "2026-10-14", weekday: "Wednesday", catalogText: expect.stringContaining("Tech Set 2") })
    );
  });

  it("books a free slot and broadcasts the confirmation", async () => {
    await h.handleMessage({ event: msg(), client });
    expect(adapters.rms.book).toHaveBeenCalledWith({
      date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night", ministry: null,
      requesterName: "Deandra", requesterUserId: "U9", phone: "555-0100", permalink: "https://slack/p1", appliances: {},
    });
    const [p] = posts();
    expect(p).toMatchObject({ channel: "CRES", thread_ts: "100.1", reply_broadcast: true, username: "FH Reservations", metadata: CLOSED_METADATA });
    expect(p.text).toContain("✅ Tech Set 2 · Sat 10/17 · 2:00–4:00 PM · Youth night · <@U9>");
    expect(p.text).toContain("ENTIRE time");
  });

  it("writes nothing on conflict and names the holder", async () => {
    adapters.rms.findConflicts.mockResolvedValue([{
      category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 930, title: "Fall rally", holder: "Alan Chow", holderUserId: null, holderEmail: "alan@x",
    }]);
    client.users.lookupByEmail.mockResolvedValue({ user: { id: "UALAN" } });
    await h.handleMessage({ event: msg(), client });
    expect(adapters.rms.book).not.toHaveBeenCalled();
    const [p] = posts();
    expect(p.text).toBe("❌ Tech Set 2 is taken Sat 10/17:\n• 2:00–3:30 PM · Tech Set 2 · Fall rally (<@UALAN>)\nPlease check with them.");
    expect(p.reply_broadcast).toBeUndefined();
    expect(p.metadata).toEqual(CLOSED_METADATA);
  });

  it("asks for missing details without closing the thread", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"] });
    await h.handleMessage({ event: msg(), client });
    const [p] = posts();
    expect(p.text).toBe("Happy to book Tech Set 2. I still need: date, start and end time, what it's for.");
    expect(p.metadata).toBeUndefined();
  });

  it("asks which item when ambiguous", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "book", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
    await h.handleMessage({ event: msg(), client });
    expect(posts()[0].text).toBe("Which one did you mean by \"a speaker\": Tech Set 2, MPR?");
  });

  it("says when it doesn't know an item", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Hologram"] });
    await h.handleMessage({ event: msg(), client });
    expect(posts()[0].text).toMatch(/^I don't know "Hologram"\./);
  });

  it("refuses to mix backends in one booking", async () => {
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Tech Set 2", "MPR"] });
    await h.handleMessage({ event: msg(), client });
    expect(posts()[0].text).toMatch(/one request per kind/i);
    expect(adapters.rms.book).not.toHaveBeenCalled();
  });

  it("stays silent on chatter", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
    await h.handleMessage({ event: msg({ text: "lol nice" }), client });
    expect(posts()).toEqual([]);
  });

  it("apologises when the model call fails", async () => {
    llm.parseReservationRequest.mockResolvedValue(null);
    await h.handleMessage({ event: msg(), client });
    expect(posts()[0].text).toBe("Sorry, I couldn't read that. Please try again.");
  });

  it("reports a backend write failure with the direct link", async () => {
    adapters.rms.book.mockRejectedValue(new Error("403 forbidden"));
    await h.handleMessage({ event: msg(), client });
    expect(posts()[0].text).toBe("⚠️ I couldn't save that booking (403 forbidden). Please book it directly: https://rms");
  });

  it("passes on an unavailable result", async () => {
    adapters.kitchen.book.mockResolvedValue({ status: "unavailable", reason: "The kitchen sheet is not open yet for that date.", link: "https://kitchen" });
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Kitchen"], appliances: { airFryer: true } });
    await h.handleMessage({ event: msg(), client });
    expect(adapters.kitchen.book.mock.calls[0][0].appliances).toEqual({ airFryer: true });
    expect(posts()[0].text).toBe("The kitchen sheet is not open yet for that date. You can book it here: https://kitchen");
  });

  it("answers a check without booking", async () => {
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
    await h.handleMessage({ event: msg(), client });
    expect(adapters.rms.book).not.toHaveBeenCalled();
    expect(posts()[0].text).toBe("Tech Set 2 is free Sat 10/17, 2:00–4:00 PM.");
  });

  it("lists across all backends when no item is named", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "list", date: "2026-10-17", toDate: "2026-10-18" });
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [{ category: "rooms", item: "MPR", date: "2026-10-17", start: 600, end: 720, title: "MBS", holder: "Arie", holderUserId: null, holderEmail: null }], errors: [] });
    await h.handleMessage({ event: msg(), client });
    for (const a of Object.values(adapters)) expect(a.listReservations).toHaveBeenCalledWith({ from: "2026-10-17", to: "2026-10-18", items: [] });
    expect(posts()[0].text).toBe("*Sat 10/17*\n• 10:00 AM–12:00 PM · MPR · MBS (Arie)");
  });

  describe("thread replies", () => {
    const reply = msg({ text: "Saturday 2-4, youth night", ts: "100.5", thread_ts: "100.1" });

    it("ignores threads the bot is not part of", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [{ user: "U9", text: "hi", ts: "100.1" }, { user: "U8", text: "yo", ts: "100.5" }] });
      await h.handleMessage({ event: reply, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    });

    it("never acts again in a closed thread", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { user: "U9", text: "book tech set 2", ts: "100.1" },
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: "100.2", metadata: CLOSED_METADATA },
        { user: "U9", text: "also the MPR", ts: "100.5" },
      ] });
      await h.handleMessage({ event: { ...reply, text: "also the MPR" }, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(posts()).toEqual([]);
    });

    it("parses the whole conversation when the bot asked a question", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { user: "U9", text: "book tech set 2", ts: "100.1" },
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: "100.2" },
        { user: "U9", text: "Saturday 2-4, youth night", ts: "100.5" },
      ] });
      await h.handleMessage({ event: reply, client });
      expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "CRES", ts: "100.1", limit: 50, include_all_metadata: true });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: Saturday 2-4, youth night"
      );
      expect(posts()[0].thread_ts).toBe("100.1");
    });
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement the handler**

```js
// src/events/reservations.js
// #reservations: members ask in plain English, the bot books first come
// first served. The conversation is stateless: a thread reply re-reads the
// thread and re-parses it whole, and a finished thread carries
// CLOSED_METADATA on the bot's last reply so it is never acted on twice.
import { log, metric } from "../lib/logger.js";
import { nyToday, weekdayName, fmtDay, fmtRange } from "../lib/reservation-time.js";
import { catalogPromptText } from "../lib/reservation-catalog.js";
import { normalizeRequest, missingFields } from "../lib/reservation-request.js";
import { reservationLine, BOT_PERSONA, CLOSED_METADATA } from "../lib/reservation-format.js";

const TECH_NOTE = "Reminder: keep the set for the ENTIRE reserved time, return it to the tech room, and charge the speaker and mic receivers after.";

export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date() }) {
  const catalogText = catalogPromptText(catalog);

  async function transcriptFor(event, client) {
    if (!event.thread_ts || event.thread_ts === event.ts) return `Member: ${event.text}`;
    const res = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 50, include_all_metadata: true });
    const messages = res.messages || [];
    if (!messages.some((m) => m.bot_id)) return null;
    if (messages.some((m) => m.bot_id && m.metadata?.event_type === CLOSED_METADATA.event_type)) return null;
    return messages.map((m) => `${m.bot_id ? "Bot" : "Member"}: ${m.text || ""}`).join("\n");
  }

  async function withMentions(client, reservations) {
    return Promise.all(reservations.map(async (r) => {
      if (r.holderUserId || !r.holderEmail) return r;
      try {
        const res = await client.users.lookupByEmail({ email: r.holderEmail });
        return { ...r, holderUserId: res.user?.id || null };
      } catch {
        return r;
      }
    }));
  }

  async function handleQuery(req, reply, client) {
    const groups = req.items.length ? [...new Set(req.items.map((i) => i.backend))] : Object.keys(adapters);
    if (req.intent === "check" && req.items.length && req.date && req.start != null) {
      const backend = groups[0];
      const hits = await withMentions(client, await adapters[backend].findConflicts({
        date: req.date, start: req.start, end: req.end, items: req.items.filter((i) => i.backend === backend),
      }));
      const names = req.items.map((i) => i.label).join(", ");
      return reply(hits.length
        ? `${names} is taken ${fmtDay(req.date)}:\n${hits.map(reservationLine).join("\n")}`
        : `${names} is free ${fmtDay(req.date)}, ${fmtRange(req.start, req.end)}.`, { closed: true });
    }
    const from = req.date || nyToday(now());
    const to = req.toDate || from;
    const found = [];
    for (const backend of groups) {
      if (!adapters[backend]) continue;
      const { reservations } = await adapters[backend].listReservations({ from, to, items: req.items.filter((i) => i.backend === backend) });
      found.push(...reservations);
    }
    if (found.length === 0) return reply(`Nothing booked ${from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`}.`, { closed: true });
    const people = await withMentions(client, found);
    const days = [...new Set(people.map((r) => r.date))].sort();
    const text = days.map((d) => [`*${fmtDay(d)}*`, ...people.filter((r) => r.date === d).sort((a, b) => (a.start ?? -1) - (b.start ?? -1)).map(reservationLine)].join("\n")).join("\n\n");
    return reply(text, { closed: true });
  }

  async function handleMessage({ event, client }) {
    if (event.channel !== channelId || event.bot_id || event.subtype || !String(event.text || "").trim()) return;
    const rootTs = event.thread_ts || event.ts;
    const reply = (text, { closed = false, broadcast = false } = {}) =>
      client.chat.postMessage({
        channel: event.channel, thread_ts: rootTs, text, ...BOT_PERSONA,
        ...(broadcast ? { reply_broadcast: true } : {}),
        ...(closed ? { metadata: CLOSED_METADATA } : {}),
      });

    const transcript = await transcriptFor(event, client);
    if (!transcript) return;

    const today = nyToday(now());
    const raw = await llm.parseReservationRequest(transcript, { catalogText, today, weekday: weekdayName(today) });
    if (!raw) return reply("Sorry, I couldn't read that. Please try again.");
    const req = normalizeRequest(raw, catalog);
    if (req.intent === "other") return;

    if (req.ambiguous.length) {
      const a = req.ambiguous[0];
      return reply(`Which one did you mean by "${a.phrase}": ${a.options.map((o) => o.label).join(", ")}?`);
    }
    if (req.unmatched.length && req.items.length === 0) {
      return reply(`I don't know "${req.unmatched.join('", "')}". I can book rooms, the kitchen, tech sets, and sports, outreach and accessories equipment.`);
    }
    if (req.intent === "check" || req.intent === "list") return handleQuery(req, reply, client);

    const missing = missingFields(req);
    if (missing.length) {
      const what = req.items.length ? req.items.map((i) => i.label).join(", ") : "that";
      return reply(`Happy to book ${what}. I still need: ${missing.join(", ")}.`);
    }
    const backends = [...new Set(req.items.map((i) => i.backend))];
    if (backends.length > 1) {
      return reply("Please send one request per kind of booking (rooms, kitchen, or equipment).", { closed: true });
    }
    const adapter = adapters[backends[0]];
    const names = req.items.map((i) => i.label).join(", ");

    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    if (conflicts.length) {
      return reply(`❌ ${names} is taken ${fmtDay(req.date)}:\n${conflicts.map(reservationLine).join("\n")}\nPlease check with them.`, { closed: true });
    }

    const info = await client.users.info({ user: event.user });
    const profile = info.user?.profile || {};
    const requesterName = profile.display_name || info.user?.real_name || "Someone";
    const { permalink } = await client.chat.getPermalink({ channel: event.channel, message_ts: rootTs });

    let result;
    try {
      result = await adapter.book({
        date: req.date, start: req.start, end: req.end, items: req.items, title: req.title, ministry: req.ministry,
        requesterName, requesterUserId: event.user, phone: profile.phone || "", permalink, appliances: req.appliances,
      });
    } catch (error) {
      metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
      log.error("reservation write failed", { backend: adapter.backend, error });
      return reply(`⚠️ I couldn't save that booking (${error.message}). Please book it directly: ${adapter.link}`, { closed: true });
    }
    if (result.status !== "booked") {
      return reply(`${result.reason} You can book it here: ${result.link}`, { closed: true });
    }
    metric("ReservationBooked", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
    const note = req.items.some((i) => i.category === "tech") ? `\n${TECH_NOTE}` : "";
    return reply(
      `✅ ${names} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)} · ${req.title} · <@${event.user}>\n<${result.link}|Open the booking>${note}`,
      { closed: true, broadcast: true }
    );
  }

  return { channelId, handleMessage };
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run tests/lib/reservation-format.test.js tests/events/reservations.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reservation-format.js src/events/reservations.js tests/lib/reservation-format.test.js tests/events/reservations.test.js
git commit -m "feat(reservations): #reservations message flow — book, check, list, clarify"
```

---

### Task 8: Wiring — config, clients, receiver, dispatch, worker

**Files:**
- Modify: `src/config.js`, `src/lambda/clients.js`, `src/lambda/receiver.js`, `src/lambda/dispatch.js`, `src/lambda/worker.js`
- Test: `tests/config.test.js` (append), `tests/lambda/receiver.test.js` (append), `tests/lambda/dispatch.test.js` (append), `tests/lambda/worker.test.js` (check it still passes)

**Interfaces:**
- Consumes: Tasks 3–7 factories.
- Produces: `loadConfig().reservations` = `null` or `{ channelId, roomsSheetId, roomsTab, roomsGid, kitchenSheetId, kitchenTab, kitchenGid, resourceCalendars, rmsBookingEnabled, escalationUserId }`; `getDeps()` adds `reservationsHandler` (`{ channelId, handleMessage }` or undefined) and `reservationAdapters` (`{ rooms?, kitchen?, rms? }`) and `config`; `shouldEnqueueEvent(parsed, { reservationsChannelId })`; `dispatchSlackEvent({ ..., reservationsHandler })`.

- [ ] **Step 1: Write the failing config tests (append to `tests/config.test.js`)**

First read the top of `tests/config.test.js` and reuse its env setup helper (it sets the REQUIRED vars before each test). Then add:

```js
describe("reservations config", () => {
  it("is null without a channel", () => {
    delete process.env.RESERVATIONS_CHANNEL_ID;
    expect(loadConfig().reservations).toBeNull();
  });

  it("reads ids, defaults the tabs, and parses the calendar map from env", () => {
    process.env.RESERVATIONS_CHANNEL_ID = "CRES";
    process.env.ROOM_REQUESTS_SHEET_ID = "R1";
    process.env.KITCHEN_SHEET_ID = "K1";
    process.env.RESOURCE_CALENDARS = JSON.stringify({ "DMV Tech Equipment-G-Tech Set 1": "t1" });
    process.env.ESCALATION_USER_ID = "UOPS";
    const r = loadConfig().reservations;
    expect(r).toEqual({
      channelId: "CRES", roomsSheetId: "R1", roomsTab: "Upcoming Room Requests", roomsGid: "1580896517",
      kitchenSheetId: "K1", kitchenTab: "FH-Kitchen-RSVP", kitchenGid: "2109987656",
      resourceCalendars: { "DMV Tech Equipment-G-Tech Set 1": "t1" }, rmsBookingEnabled: true, escalationUserId: "UOPS",
    });
  });

  it("never throws on a bad calendar map and honours RMS_BOOKING_ENABLED=false", () => {
    process.env.RESERVATIONS_CHANNEL_ID = "CRES";
    process.env.RESOURCE_CALENDARS = "{not json";
    process.env.RMS_BOOKING_ENABLED = "false";
    const r = loadConfig().reservations;
    expect(r.resourceCalendars).toEqual({});
    expect(r.rmsBookingEnabled).toBe(false);
  });
});
```

Clean up these env vars in that file's `afterEach` (add `RESERVATIONS_CHANNEL_ID`, `ROOM_REQUESTS_SHEET_ID`, `KITCHEN_SHEET_ID`, `RESOURCE_CALENDARS`, `RMS_BOOKING_ENABLED`, `ESCALATION_USER_ID` to whatever it deletes).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL, `reservations` is undefined.

- [ ] **Step 3: Implement config**

At the top of `src/config.js`:

```js
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
```

Add before `loadConfig`:

```js
function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// RESOURCE_CALENDARS is ~11 KB: too big for a CloudFormation parameter (4096
// chars) or Lambda env vars (4 KB total). The deploy workflow writes it to
// runtime-config/ before `sam build`, so it ships inside the package. Order:
// bundled file, then the env var (local .env, raw JSON or base64), then the
// fallback. A bad value must never throw, or getDeps crashes and the whole
// worker dies on every event.
function loadJsonConfig(fileName, rawEnv, fallback) {
  try {
    const path = fileURLToPath(new URL(`../runtime-config/${fileName}`, import.meta.url));
    if (existsSync(path)) {
      const parsed = tryParseJson(readFileSync(path, "utf8"));
      if (parsed !== undefined) return parsed;
      console.warn(`[config] ${fileName} present but unparseable; trying env/fallback`);
    }
  } catch (err) {
    console.warn(`[config] reading ${fileName} failed: ${err.message}`);
  }
  if (rawEnv) {
    const value = tryParseJson(rawEnv) ?? tryParseJson(Buffer.from(rawEnv, "base64").toString("utf8"));
    if (value !== undefined) return value;
    console.warn("[config] env JSON unparseable (raw or base64); using fallback");
  }
  return fallback;
}

// #reservations is on only when its channel is set. Each backend is on only
// when its own id (or calendar map) is set.
function loadReservations() {
  const channelId = process.env.RESERVATIONS_CHANNEL_ID;
  if (!channelId) return null;
  const calendars = loadJsonConfig("resource-calendars.json", process.env.RESOURCE_CALENDARS, {});
  return {
    channelId,
    roomsSheetId: process.env.ROOM_REQUESTS_SHEET_ID || null,
    roomsTab: process.env.ROOM_REQUESTS_TAB || "Upcoming Room Requests",
    roomsGid: process.env.ROOM_REQUESTS_GID || "1580896517",
    kitchenSheetId: process.env.KITCHEN_SHEET_ID || null,
    kitchenTab: process.env.KITCHEN_TAB || "FH-Kitchen-RSVP",
    kitchenGid: process.env.KITCHEN_GID || "2109987656",
    resourceCalendars: calendars && typeof calendars === "object" && !Array.isArray(calendars) ? calendars : {},
    rmsBookingEnabled: (process.env.RMS_BOOKING_ENABLED || "true").toLowerCase() !== "false",
    escalationUserId: process.env.ESCALATION_USER_ID || null,
  };
}
```

Add `reservations: loadReservations(),` to the object `loadConfig` returns.

Note: `tryParseJson(Buffer.from("{not json","base64")...)` returns undefined, so the fallback `{}` is used — the test pins that.

- [ ] **Step 4: Run config tests**

Run: `npx vitest run tests/config.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing receiver and dispatch tests**

Append to `tests/lambda/receiver.test.js`:

```js
describe("shouldEnqueueEvent for #reservations", () => {
  const opts = { reservationsChannelId: "CRES" };
  it("enqueues top-level member messages in the reservations channel", () => {
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "CRES", text: "book the MPR" } }, opts)).toBe(true);
  });
  it("still drops bots, edits and other channels' top-level messages", () => {
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "CRES", text: "x", bot_id: "B" } }, opts)).toBe(false);
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "CRES", text: "x", subtype: "message_changed" } }, opts)).toBe(false);
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "COTHER", text: "x" } }, opts)).toBe(false);
  });
});
```

(Import `shouldEnqueueEvent` at the top if the file doesn't already.)

Append to `tests/lambda/dispatch.test.js`:

```js
describe("dispatch to #reservations", () => {
  const reservationsHandler = { channelId: "CRES", handleMessage: vi.fn().mockResolvedValue() };

  it("routes every message in the reservations channel to its handler only", async () => {
    const handler = vi.fn();
    const client = makeClient();
    const event = { type: "message", channel: "CRES", text: "book the MPR", user: "U1", ts: "1" };
    await dispatchSlackEvent({ slackEnvelope: { event }, handler, reservationsHandler, client });
    expect(reservationsHandler.handleMessage).toHaveBeenCalledWith({ event, client });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops app_mention events there so a mention isn't handled twice", async () => {
    reservationsHandler.handleMessage.mockClear();
    const handler = vi.fn();
    await dispatchSlackEvent({ slackEnvelope: { event: { type: "app_mention", channel: "CRES", text: "<@B> hi", ts: "1" } }, handler, reservationsHandler, client: makeClient() });
    expect(reservationsHandler.handleMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/lambda/receiver.test.js tests/lambda/dispatch.test.js`
Expected: the new tests FAIL.

- [ ] **Step 7: Implement receiver and dispatch**

`src/lambda/receiver.js` — change the signature and add one rule after the `bot_id` check:

```js
export function shouldEnqueueEvent(parsed, { reservationsChannelId = process.env.RESERVATIONS_CHANNEL_ID } = {}) {
  const event = parsed.event;
  if (!event) return false;
  // Every reaction in every channel the bot is in arrives here; only the
  // ticket emoji means anything, so drop the rest before they cost a Lambda.
  if (event.type === "reaction_added") return isCreaTicketReaction(event.reaction);
  if (event.type !== "message") return true;
  if (event.bot_id) return false; // never enqueue our own / other bots' messages
  // #reservations is ambient: members ask without mentioning the bot.
  if (reservationsChannelId && event.channel === reservationsChannelId) return !event.subtype;
  const text = event.text || "";
  if (matchesGenderEvent(text)) return true;
  if (/<@[A-Z0-9_]+>/.test(text)) return true;
  if (event.thread_ts) return true;
  return false;
}
```

`src/lambda/dispatch.js` — add `reservationsHandler` to the destructured params and, right after `if (!event) return;` and before the `reaction_added` branch:

```js
  // #reservations belongs to the reservations flow alone. A mention there
  // arrives as both app_mention and message; only the message is handled.
  if (reservationsHandler && event.channel === reservationsHandler.channelId) {
    if (event.type === "message") await reservationsHandler.handleMessage({ event, client });
    return;
  }
```

- [ ] **Step 8: Implement clients and worker**

`src/lambda/clients.js` — add imports:

```js
import { createRoomsAdapter } from "../services/reservations/rooms.js";
import { createKitchenAdapter } from "../services/reservations/kitchen.js";
import { createRmsAdapter } from "../services/reservations/rms.js";
import { buildRmsCatalog } from "../lib/rms-catalog.js";
import { buildCatalog } from "../lib/reservation-catalog.js";
import { createReservationsHandler } from "../events/reservations.js";
```

Before `cached = { ... }`:

```js
  let reservationsHandler;
  const reservationAdapters = {};
  const res = config.reservations;
  if (res) {
    const sheetLink = (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;
    if (res.roomsSheetId) {
      reservationAdapters.rooms = createRoomsAdapter({
        sheetsClient, spreadsheetId: res.roomsSheetId, tab: res.roomsTab, link: sheetLink(res.roomsSheetId, res.roomsGid),
      });
    }
    if (res.kitchenSheetId) {
      reservationAdapters.kitchen = createKitchenAdapter({
        sheetsClient, spreadsheetId: res.kitchenSheetId, tab: res.kitchenTab, link: sheetLink(res.kitchenSheetId, res.kitchenGid),
      });
    }
    const rmsCatalog = buildRmsCatalog(res.resourceCalendars);
    if (rmsCatalog.length) {
      const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });
      reservationAdapters.rms = createRmsAdapter({ calendarClient, catalog: rmsCatalog, bookingEnabled: res.rmsBookingEnabled });
    }
    reservationsHandler = createReservationsHandler({
      llm: llmService,
      adapters: reservationAdapters,
      catalog: buildCatalog({ rooms: !!reservationAdapters.rooms, kitchen: !!reservationAdapters.kitchen, rms: rmsCatalog }),
      channelId: res.channelId,
    });
  }
```

Change the cache line to:

```js
  cached = { config, client: slack, handler, maintenanceFormHandler, creaTicketHandler, genderHandler, slashRefreshHandler, reservationsHandler, reservationAdapters };
```

`src/lambda/worker.js` — destructure `reservationsHandler` from `getDeps()` and pass `reservationsHandler,` into `dispatchSlackEvent({...})`.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS (all existing tests plus the new ones).

- [ ] **Step 10: Commit**

```bash
git add src/config.js src/lambda/clients.js src/lambda/receiver.js src/lambda/dispatch.js src/lambda/worker.js tests/config.test.js tests/lambda/receiver.test.js tests/lambda/dispatch.test.js
git commit -m "feat(reservations): wire #reservations into config, receiver, dispatch and worker"
```

---

### Task 9: Weekly digest Lambda

**Files:**
- Create: `src/lambda/digest.js`
- Test: `tests/lambda/digest.test.js`

**Interfaces:**
- Consumes: `getDeps()` → `{ config, client, reservationAdapters }`; Task 2 `weekOf`; Task 7 `buildDigest`, `BOT_PERSONA`, `CLOSED_METADATA`.
- Produces: `runDigest({ client, adapters, channelId, escalationUserId, now }) -> { posted: number, failures: string[] }`; `handler()` (Lambda entry).

- [ ] **Step 1: Write the failing tests**

```js
// tests/lambda/digest.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDigest } from "../../src/lambda/digest.js";

const RES = { category: "rooms", item: "MPR", date: "2026-10-13", start: 1140, end: 1320, title: "Equipping", holder: "John", holderUserId: null, holderEmail: null };

function makeAdapter(backend, result) {
  return { backend, listReservations: vi.fn().mockImplementation(async () => (result instanceof Error ? Promise.reject(result) : result)) };
}

describe("runDigest", () => {
  let client;
  beforeEach(() => {
    client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: "500.1" }) } };
  });
  const now = () => new Date("2026-10-12T12:00:00Z");

  it("reads the Monday–Sunday week from every adapter and posts one message", async () => {
    const adapters = { rooms: makeAdapter("rooms", { reservations: [RES], errors: [] }), kitchen: makeAdapter("kitchen", { reservations: [], errors: [] }) };
    const out = await runDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS", now });
    expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-12", to: "2026-10-18" });
    expect(out).toEqual({ posted: 1, failures: [] });
    const p = client.chat.postMessage.mock.calls[0][0];
    expect(p).toMatchObject({ channel: "CRES", username: "FH Reservations", metadata: { event_type: "reservation_closed", event_payload: {} } });
    expect(p.text).toContain("• 7:00–10:00 PM · MPR · Equipping (John)");
  });

  it("still posts when a source fails, and DMs the operator", async () => {
    const adapters = {
      rooms: makeAdapter("rooms", { reservations: [RES], errors: [] }),
      kitchen: makeAdapter("kitchen", new Error("The caller does not have permission")),
      rms: makeAdapter("rms", { reservations: [], errors: ["Kiddie Pool: 404"] }),
    };
    const out = await runDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS", now });
    expect(out.failures).toEqual(["Kitchen: The caller does not have permission", "Equipment calendars: Kiddie Pool: 404"]);
    const calls = client.chat.postMessage.mock.calls.map((c) => c[0]);
    expect(calls[0].channel).toBe("CRES");
    expect(calls[0].text).toContain("⚠️ Couldn't read: Kitchen, Equipment calendars");
    expect(calls[1]).toMatchObject({ channel: "UOPS" });
    expect(calls[1].text).toBe("The weekly reservations digest couldn't read some sources:\n• Kitchen: The caller does not have permission\n• Equipment calendars: Kiddie Pool: 404");
  });

  it("posts extra parts as thread replies", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...RES, date: i < 100 ? "2026-10-13" : "2026-10-14", title: `Event number ${i}` }));
    const adapters = { rooms: makeAdapter("rooms", { reservations: many, errors: [] }) };
    const out = await runDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS", now });
    expect(out.posted).toBeGreaterThan(1);
    expect(client.chat.postMessage.mock.calls[1][0].thread_ts).toBe("500.1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lambda/digest.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/lambda/digest.js
// Monday 8 AM: the week's reservations from every backend in one post, so
// bookings made straight in a doc or calendar are seen too. A source that
// can't be read never stops the post; it is named in it and DMed to the
// operator, since a quietly missing source looks like a quiet week.
import { getDeps } from "./clients.js";
import { weekOf } from "../lib/reservation-time.js";
import { buildDigest, BOT_PERSONA, CLOSED_METADATA } from "../lib/reservation-format.js";
import { log, metric } from "../lib/logger.js";

const SOURCE_NAMES = { rooms: "Rooms", kitchen: "Kitchen", rms: "Equipment calendars" };

export async function runDigest({ client, adapters, channelId, escalationUserId, now = () => new Date() }) {
  const { from, to } = weekOf(now());
  const reservations = [];
  const failures = [];
  for (const [backend, adapter] of Object.entries(adapters)) {
    const name = SOURCE_NAMES[backend] || backend;
    try {
      const res = await adapter.listReservations({ from, to });
      reservations.push(...res.reservations);
      for (const e of res.errors) failures.push(`${name}: ${e}`);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }

  const parts = buildDigest({ from, to, reservations });
  if (failures.length) {
    const names = [...new Set(failures.map((f) => f.split(":")[0]))];
    parts[0] = `${parts[0]}\n\n⚠️ Couldn't read: ${names.join(", ")}. This list may be incomplete.`;
  }

  // Every digest post is closed, so replies to it are never parsed as bookings.
  const first = await client.chat.postMessage({ channel: channelId, text: parts[0], ...BOT_PERSONA, metadata: CLOSED_METADATA });
  for (const part of parts.slice(1)) {
    await client.chat.postMessage({ channel: channelId, thread_ts: first.ts, text: part, ...BOT_PERSONA, metadata: CLOSED_METADATA });
  }

  if (failures.length) {
    metric("DigestSourceFailed", failures.length, { dimensions: { Flow: "digest" } });
    log.error("digest source failed", { failures });
    if (escalationUserId) {
      await client.chat.postMessage({
        channel: escalationUserId,
        text: `The weekly reservations digest couldn't read some sources:\n${failures.map((f) => `• ${f}`).join("\n")}`,
        ...BOT_PERSONA,
      });
    }
  }
  return { posted: parts.length, failures };
}

export async function handler() {
  const { config, client, reservationAdapters } = getDeps();
  if (!config.reservations) {
    log.warn("digest skipped: RESERVATIONS_CHANNEL_ID not set");
    return;
  }
  await runDigest({
    client,
    adapters: reservationAdapters,
    channelId: config.reservations.channelId,
    escalationUserId: config.reservations.escalationUserId,
  });
}
```

Check `src/lib/logger.js` exports `log.warn`; if it only has `info`/`error`, use `log.info`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lambda/digest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/digest.js tests/lambda/digest.test.js
git commit -m "feat(reservations): weekly Monday digest with source-failure DM"
```

---

### Task 10: Infra, deploy and docs

**Files:**
- Modify: `template.yaml`, `.github/workflows/deploy.yml`, `.env.example`, `README.md`, `docs/RUNBOOK.md`

No unit tests; verification is `sam validate` plus `npm test`.

- [ ] **Step 1: `template.yaml` parameters** (after `CreaTicketUserIds`)

```yaml
  # #reservations front door. Off unless ReservationsChannelId is set; each
  # backend is off unless its sheet id (or the bundled calendar map) is set.
  ReservationsChannelId: { Type: String, Default: "" }
  RoomRequestsSheetId:   { Type: String, Default: "" }
  KitchenSheetId:        { Type: String, Default: "" }
  RmsBookingEnabled:     { Type: String, Default: "true", AllowedValues: ["true", "false"] }
```

- [ ] **Step 2: `template.yaml` env vars**

ReceiverFn `Environment.Variables` add:

```yaml
          RESERVATIONS_CHANNEL_ID: !Ref ReservationsChannelId
```

WorkerFn `Environment.Variables` add:

```yaml
          RESERVATIONS_CHANNEL_ID: !Ref ReservationsChannelId
          ROOM_REQUESTS_SHEET_ID: !Ref RoomRequestsSheetId
          KITCHEN_SHEET_ID:       !Ref KitchenSheetId
          RMS_BOOKING_ENABLED:    !Ref RmsBookingEnabled
```

- [ ] **Step 3: `template.yaml` DigestFn** (after `WorkerLogGroup`)

```yaml
  # Monday 8 AM New York time, whatever the DST state: EventBridge Scheduler
  # evaluates the cron in the given zone.
  DigestFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/digest.handler
      Description: Posts the week's reservations to #reservations
      MemorySize: 256
      Timeout: 120
      Environment:
        Variables:
          SLACK_BOT_TOKEN:         !Ref SlackBotToken
          SLACK_CHANNEL_IDS:       !Join [",", !Ref SlackChannelIds]
          GOOGLE_SHEET_ID:         !Ref GoogleSheetId
          GOOGLE_CLIENT_ID:        !Ref GoogleClientId
          GOOGLE_CLIENT_SECRET:    !Ref GoogleClientSecret
          GOOGLE_REFRESH_TOKEN:    !Ref GoogleRefreshToken
          ESCALATION_USER_ID:      !Ref EscalationUserId
          RESERVATIONS_CHANNEL_ID: !Ref ReservationsChannelId
          ROOM_REQUESTS_SHEET_ID:  !Ref RoomRequestsSheetId
          KITCHEN_SHEET_ID:        !Ref KitchenSheetId
      Events:
        Weekly:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 8 ? * MON *)
            ScheduleExpressionTimezone: America/New_York

  DigestLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${DigestFn}
      RetentionInDays: 14

  # The digest crashing outright (bad token, Slack down) means no post at all.
  DigestFailedAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: fh-community-digest-failed
      AlarmDescription: The weekly reservations digest Lambda errored and nothing was posted.
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions:
        - Name: FunctionName
          Value: !Ref DigestFn
      Statistic: Sum
      Period: 3600
      EvaluationPeriods: 1
      Threshold: 0
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      AlarmActions:
        - !Ref AlarmTopic
```

- [ ] **Step 4: Validate**

Run: `sam validate --lint`
Expected: `template.yaml is a valid SAM Template`. If `sam` is not installed locally, note it and rely on CI.

- [ ] **Step 5: `.github/workflows/deploy.yml`**

Insert before `- name: SAM build`:

```yaml
      # RESOURCE_CALENDARS (~11 KB) is too large for a CloudFormation parameter
      # (4096 chars) or Lambda env vars (4 KB), so it ships as a file inside the
      # package and config.js reads it at runtime. Written BEFORE `sam build`
      # so it is in the build artifact; runtime-config/ must not be gitignored.
      - name: Write runtime config files
        env:
          RESOURCE_CALENDARS: ${{ vars.RESOURCE_CALENDARS }}
        run: |
          mkdir -p runtime-config
          [ -n "$RESOURCE_CALENDARS" ] && printf %s "$RESOURCE_CALENDARS" > runtime-config/resource-calendars.json
          echo "runtime-config written:"; ls -l runtime-config
```

In the `SAM deploy` step `env:` add:

```yaml
          RESERVATIONS_CHANNEL_ID: ${{ vars.RESERVATIONS_CHANNEL_ID }}
          ROOM_REQUESTS_SHEET_ID: ${{ vars.ROOM_REQUESTS_SHEET_ID }}
          KITCHEN_SHEET_ID: ${{ vars.KITCHEN_SHEET_ID }}
          RMS_BOOKING_ENABLED: ${{ vars.RMS_BOOKING_ENABLED }}
```

and in its `run:` script, before `sam deploy`:

```bash
          if [ -n "$RESERVATIONS_CHANNEL_ID" ]; then
            OPTIONAL_PARAMS+=("ReservationsChannelId=$RESERVATIONS_CHANNEL_ID")
          fi
          if [ -n "$ROOM_REQUESTS_SHEET_ID" ]; then
            OPTIONAL_PARAMS+=("RoomRequestsSheetId=$ROOM_REQUESTS_SHEET_ID")
          fi
          if [ -n "$KITCHEN_SHEET_ID" ]; then
            OPTIONAL_PARAMS+=("KitchenSheetId=$KITCHEN_SHEET_ID")
          fi
          if [ -n "$RMS_BOOKING_ENABLED" ]; then
            OPTIONAL_PARAMS+=("RmsBookingEnabled=$RMS_BOOKING_ENABLED")
          fi
```

- [ ] **Step 6: Deploy role check**

EventBridge Scheduler needs the deploy role to have `scheduler:CreateSchedule`, `scheduler:UpdateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule` and `iam:PassRole` for the schedule's role. Check `docs/RUNBOOK.md` for the deploy-role permission list (commit `0938604` documented SNS/CloudWatch ones) and add these lines there. Tell the user they must add them to the AWS deploy role before merging.

- [ ] **Step 7: `.env.example`, `README.md`, `docs/RUNBOOK.md`**

`.env.example` add:

```
# #reservations (optional)
RESERVATIONS_CHANNEL_ID=
ROOM_REQUESTS_SHEET_ID=1F70ce8Gd1JEvjXTsBIeV0PBi85Ii3ggf2z1tFIh1Eg4
KITCHEN_SHEET_ID=1xUA0EG95241Ndb3HBOLw-iYGxU9nBTswzFn8ob49o5c
# JSON map "resource name" -> resource calendar id (raw or base64). In CI it
# ships as runtime-config/resource-calendars.json instead.
RESOURCE_CALENDARS=
RMS_BOOKING_ENABLED=true
```

`README.md`: add a "#reservations" section — what it does (book/check/list in plain English, first come first served, weekly Monday 8 AM digest), the four backends with owners, the repo variables above, and that the bot must be a member of #reservations.

`docs/RUNBOOK.md`: add entries for `fh-community-digest-failed` (check DigestFn logs; usually Google token or Slack token) and for the `DigestSourceFailed` DM (open the named sheet/calendar with the bot's Google account; most often lost sharing access), and for `ReservationFailed` logs.

- [ ] **Step 8: Run tests and commit**

Run: `npm test`
Expected: PASS.

```bash
git add template.yaml .github/workflows/deploy.yml .env.example README.md docs/RUNBOOK.md
git commit -m "feat(reservations): SAM digest schedule, deploy params, runtime-config, docs"
```

---

### Task 11: Smoke test against the real backends, then launch

Real writes to shared sheets and calendars. Confirm with the user before each write step.

- [ ] **Step 1: Local smoke script** (scratch, never commit; copy into repo root as `./.smoke.mjs` to run, delete after)

```js
// .smoke.mjs — exercises the real adapters on a far-future date.
import "dotenv/config";
import { google } from "googleapis";
import { createRoomsAdapter } from "./src/services/reservations/rooms.js";
import { createKitchenAdapter } from "./src/services/reservations/kitchen.js";
import { createRmsAdapter } from "./src/services/reservations/rms.js";
import { buildRmsCatalog } from "./src/lib/rms-catalog.js";
import { execSync } from "node:child_process";

const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const sheetsClient = google.sheets({ version: "v4", auth });
const calendarClient = google.calendar({ version: "v3", auth });
const catalog = buildRmsCatalog(JSON.parse(execSync("gh variable get RESOURCE_CALENDARS").toString()));

const rooms = createRoomsAdapter({ sheetsClient, spreadsheetId: "1F70ce8Gd1JEvjXTsBIeV0PBi85Ii3ggf2z1tFIh1Eg4", tab: "Upcoming Room Requests", link: "rooms" });
const kitchen = createKitchenAdapter({ sheetsClient, spreadsheetId: "1xUA0EG95241Ndb3HBOLw-iYGxU9nBTswzFn8ob49o5c", tab: "FH-Kitchen-RSVP", link: "kitchen" });
const rms = createRmsAdapter({ calendarClient, catalog });

const week = { from: "2026-10-12", to: "2026-10-18" };
for (const [n, a] of Object.entries({ rooms, kitchen, rms })) {
  const r = await a.listReservations(week);
  console.log(n, r.reservations.length, "reservations,", r.errors.length, "errors", r.reservations.slice(0, 3));
}
if (process.argv[2] === "write") {
  const pool = catalog.find((c) => c.label === "Kiddie Pool");
  console.log("rms book:", await rms.book({ date: "2027-12-30", start: 180, end: 210, items: [pool], title: "SMOKE TEST delete me", requesterName: "Bot test", requesterUserId: "U05SWHWFTEH", permalink: "n/a" }));
  console.log("rms conflict check:", await rms.findConflicts({ date: "2027-12-30", start: 180, end: 210, items: [pool] }));
}
```

Run read-only: `node ./.smoke.mjs`
Expected: each source lists this week's real bookings with 0 errors; spot-check 2–3 against the sheets.

With user consent, run `node ./.smoke.mjs write`, confirm booking + conflict detection, then delete the test event from the bot's primary calendar. Rooms and kitchen writes are NOT smoke-tested against the live sheets (they'd show to Management/Arie); their payloads are pinned by unit tests.

Delete the script: `rm -f ./.smoke.mjs`.

- [ ] **Step 2: Set repo variables** (ask the user to confirm first)

```bash
gh variable set ROOM_REQUESTS_SHEET_ID --body 1F70ce8Gd1JEvjXTsBIeV0PBi85Ii3ggf2z1tFIh1Eg4
gh variable set KITCHEN_SHEET_ID --body 1xUA0EG95241Ndb3HBOLw-iYGxU9nBTswzFn8ob49o5c
# Only if Task 1 failed:
gh variable set RMS_BOOKING_ENABLED --body false
```

`RESERVATIONS_CHANNEL_ID` (`C0BCSJNECRL`) and `RESOURCE_CALENDARS` already exist.

- [ ] **Step 3: PR**

Push the branch and open a PR with `gh pr create`. Body: summary, the four backends, the Task 1 result, the deploy-role permissions needed, and that the obsolete `RESERVATIONS_SHEET_ID`, `RESERVATION_ROOMS`, `VENUE_CALENDARS` variables can be deleted after launch.

- [ ] **Step 4: After merge and deploy**

In #reservations: post a test request on a far-future date for an accessory, see the ✅ broadcast, then delete the event. Ask a check and a list question. Manually invoke the digest once:

```bash
aws lambda invoke --function-name "$(aws cloudformation describe-stack-resource --stack-name fh-maintenance-bot --logical-resource-id DigestFn --query StackResourceDetail.PhysicalResourceId --output text)" /dev/stdout
```

Expected: one digest post in #reservations, no DM (or a DM naming a real failure to fix).
