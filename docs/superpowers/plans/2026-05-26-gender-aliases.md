# Gender Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the `~/Projects/gender-aliases` Slack bot into this Lambda-based `fh-community-bot` so `!bros` / `@sis` / `!refresh-genders` (and `@`-prefixed variants) ping channel members by gender from a Google Sheet, alongside the existing maintenance-request flow.

**Architecture:** Add a new `genderMap` Sheets service + `gender` event handler. `dispatch.js` gains a router step that sends `message`-type events with gender-trigger text to the new handler before falling through to the existing maintenance path. In-memory module-scope cache (7-day TTL), refilled on cold start or `!refresh-genders`. No new AWS infrastructure.

**Tech Stack:** Node.js 22, ES modules, `googleapis` Sheets v4, `@slack/web-api`, AWS Lambda + SQS via SAM, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-05-26-gender-aliases-design.md`

---

## File Map

**New:**
- `src/lib/gender-triggers.js` — regex constants + helpers, single source of truth for trigger detection.
- `src/services/genderMap.js` — Sheets reader factory with TTL cache.
- `src/events/gender.js` — handler factory.
- `tests/lib/gender-triggers.test.js`
- `tests/services/genderMap.test.js`
- `tests/events/gender.test.js`

**Modified:**
- `src/lambda/dispatch.js` — route gender events before existing maintenance logic.
- `src/lambda/clients.js` — wire `genderMapService` and `genderHandler` into deps.
- `src/lambda/worker.js` — pass `genderHandler` into `dispatchSlackEvent`.
- `src/lambda/receiver.js` — text-based prefilter for `message` events.
- `tests/lambda/dispatch.test.js` — extend.
- `tests/lambda/worker.test.js` — extend (genderHandler wiring).
- `tests/lambda/receiver.test.js` — extend (prefilter).
- `src/config.js` — optional `GENDER_SHEET_TAB`, `GENDER_CACHE_TTL_DAYS` reads with defaults.
- `tests/config.test.js` — extend.
- `README.md` — Slack scopes/events prerequisites + Gender Map sheet docs.

---

## Task 1: Gender trigger regexes

**Files:**
- Create: `src/lib/gender-triggers.js`
- Test: `tests/lib/gender-triggers.test.js`

The Python source uses two regexes:
- Trigger: `(?:^|\s)[!@](bros|brothers|sis|sisters)\b` (case-insensitive)
- Refresh: `(?:^|\s)[!@]refresh-genders\b` (case-insensitive)

This task ports them and adds two helper functions used by the receiver prefilter and dispatch router.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/gender-triggers.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  GENDER_TRIGGER_RE,
  GENDER_REFRESH_RE,
  matchesGenderEvent,
  resolveTarget,
} from "../../src/lib/gender-triggers.js";

describe("GENDER_TRIGGER_RE", () => {
  it.each([
    ["!bros", true],
    ["!brothers", true],
    ["@bros", true],
    ["@brothers", true],
    ["!sis", true],
    ["!sisters", true],
    ["@sis", true],
    ["@sisters", true],
    ["  !bros at start of trim", true],
    ["hey !bros stand up", true],
    ["hey @SISTERS", true],
    ["bros without prefix", false],
    ["!brosx", false],
    ["!sissy", false],
    ["foo!bros mid-word", false],
    ["", false],
  ])("matches %p -> %p", (text, expected) => {
    expect(GENDER_TRIGGER_RE.test(text)).toBe(expected);
  });
});

describe("GENDER_REFRESH_RE", () => {
  it.each([
    ["!refresh-genders", true],
    ["@refresh-genders", true],
    [" @REFRESH-genders ", true],
    ["refresh-genders no prefix", false],
    ["!refresh-gendersX", false],
    ["", false],
  ])("matches %p -> %p", (text, expected) => {
    expect(GENDER_REFRESH_RE.test(text)).toBe(expected);
  });
});

describe("matchesGenderEvent", () => {
  it("is true if either trigger or refresh matches", () => {
    expect(matchesGenderEvent("hello !bros")).toBe(true);
    expect(matchesGenderEvent("!refresh-genders")).toBe(true);
    expect(matchesGenderEvent("just chatter")).toBe(false);
    expect(matchesGenderEvent("")).toBe(false);
    expect(matchesGenderEvent(undefined)).toBe(false);
  });
});

describe("resolveTarget", () => {
  it("returns 'male' for bros/brothers", () => {
    expect(resolveTarget("!bros")).toBe("male");
    expect(resolveTarget("@BROTHERS check this")).toBe("male");
  });

  it("returns 'female' for sis/sisters", () => {
    expect(resolveTarget("!sis")).toBe("female");
    expect(resolveTarget("hey @SISTERS")).toBe("female");
  });

  it("prefers 'male' when both appear (matches Python precedence)", () => {
    expect(resolveTarget("!bros !sis")).toBe("male");
    expect(resolveTarget("!sis !bros")).toBe("male");
  });

  it("returns null on no match", () => {
    expect(resolveTarget("bros")).toBe(null);
    expect(resolveTarget("")).toBe(null);
    expect(resolveTarget(undefined)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/gender-triggers.test.js`
Expected: FAIL with "Failed to load url ... src/lib/gender-triggers.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/gender-triggers.js`:

```js
export const GENDER_TRIGGER_RE = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/i;
export const GENDER_REFRESH_RE = /(?:^|\s)[!@]refresh-genders\b/i;

const MALE_ALIASES = new Set(["bros", "brothers"]);
const FEMALE_ALIASES = new Set(["sis", "sisters"]);

export function matchesGenderEvent(text) {
  if (!text) return false;
  return GENDER_TRIGGER_RE.test(text) || GENDER_REFRESH_RE.test(text);
}

export function resolveTarget(text) {
  if (!text) return null;
  const matches = new Set();
  const re = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.add(m[1].toLowerCase());
  }
  if (matches.size === 0) return null;
  for (const a of matches) if (MALE_ALIASES.has(a)) return "male";
  for (const a of matches) if (FEMALE_ALIASES.has(a)) return "female";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/gender-triggers.test.js`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gender-triggers.js tests/lib/gender-triggers.test.js
git commit -m "feat(gender): regex helpers for trigger and refresh detection"
```

---

## Task 2: genderMap service (Sheets reader + cache)

**Files:**
- Create: `src/services/genderMap.js`
- Test: `tests/services/genderMap.test.js`

Reads a sheet tab into `{ userId: 'male' | 'female' }`. Caches in module-scope `let` inside the factory (per-instance) with a TTL. Range `'<tab>'!A2:B` (skipping header).

- [ ] **Step 1: Write the failing test**

Create `tests/services/genderMap.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderMapService } from "../../src/services/genderMap.js";

function makeSheetsClient(values) {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values } }),
      },
    },
  };
}

describe("createGenderMapService", () => {
  let sheets;
  let service;

  beforeEach(() => {
    sheets = makeSheetsClient([
      ["U01ABC123", "male"],
      ["U02DEF456", "FEMALE"],
      ["U03GHI789", "Other"],
      ["", "male"],
      ["U04JKL012"],
    ]);
    service = createGenderMapService({
      sheetsClient: sheets,
      spreadsheetId: "sheet-1",
      ttlMs: 7 * 24 * 3600 * 1000,
      tabName: "Gender Map",
    });
  });

  it("parses valid rows, normalizes gender to lowercase, skips malformed", async () => {
    const map = await service.getMap();
    expect(map).toEqual({
      U01ABC123: "male",
      U02DEF456: "female",
    });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      range: "'Gender Map'!A2:B",
    });
  });

  it("returns cached map on second call within TTL", async () => {
    await service.getMap();
    await service.getMap();
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces a refetch and returns the entry count", async () => {
    await service.getMap();
    const count = await service.invalidate();
    expect(count).toBe(2);
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(2);
  });

  it("refetches after TTL expiry", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    const svc = createGenderMapService({
      sheetsClient: sheets,
      spreadsheetId: "sheet-1",
      ttlMs: 1000,
      tabName: "Gender Map",
    });

    await svc.getMap();
    vi.setSystemTime(t0 + 1500);
    await svc.getMap();
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("treats empty values array as empty map", async () => {
    const emptySheets = makeSheetsClient(undefined);
    const svc = createGenderMapService({
      sheetsClient: emptySheets,
      spreadsheetId: "sheet-1",
      ttlMs: 1000,
      tabName: "Gender Map",
    });
    expect(await svc.getMap()).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/genderMap.test.js`
Expected: FAIL with "Failed to load url ... src/services/genderMap.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/services/genderMap.js`:

```js
const VALID_GENDERS = new Set(["male", "female"]);

export function createGenderMapService({ sheetsClient, spreadsheetId, ttlMs, tabName }) {
  let cache = { fetchedAt: 0, data: null };

  async function fetchFromSheet() {
    const range = `'${tabName}'!A2:B`;
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
    const rows = res.data.values || [];
    const data = {};
    for (const row of rows) {
      if (!row || row.length < 2) continue;
      const userId = String(row[0] || "").trim();
      const gender = String(row[1] || "").trim().toLowerCase();
      if (!userId) continue;
      if (!VALID_GENDERS.has(gender)) continue;
      data[userId] = gender;
    }
    return data;
  }

  async function getMap() {
    const now = Date.now();
    if (cache.data && now - cache.fetchedAt < ttlMs) {
      return cache.data;
    }
    const data = await fetchFromSheet();
    cache = { fetchedAt: now, data };
    return data;
  }

  async function invalidate() {
    cache = { fetchedAt: 0, data: null };
    const data = await getMap();
    return Object.keys(data).length;
  }

  return { getMap, invalidate };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/genderMap.test.js`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/genderMap.js tests/services/genderMap.test.js
git commit -m "feat(gender): genderMap service with 7-day TTL cache"
```

---

## Task 3: Gender event handler

**Files:**
- Create: `src/events/gender.js`
- Test: `tests/events/gender.test.js`

Handler does: refresh / lookup target / fetch map / paginate channel members / filter / post ping.

- [ ] **Step 1: Write the failing test**

Create `tests/events/gender.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderHandler } from "../../src/events/gender.js";

function makeSay() {
  return vi.fn().mockResolvedValue({});
}

function makeClient({ membersPages = [["U_MALE_1", "U_MALE_2", "U_FEMALE_1", "U_OTHER"]], membersError = null } = {}) {
  let call = 0;
  const conversations = {
    members: vi.fn().mockImplementation(async () => {
      if (membersError) throw membersError;
      const page = membersPages[call] || [];
      const nextCursor = call < membersPages.length - 1 ? `c${call + 1}` : "";
      call += 1;
      return { members: page, response_metadata: { next_cursor: nextCursor } };
    }),
  };
  return {
    conversations,
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
  };
}

function makeService({ map = { U_MALE_1: "male", U_MALE_2: "male", U_FEMALE_1: "female" }, getMapError = null } = {}) {
  return {
    getMap: vi.fn().mockImplementation(async () => {
      if (getMapError) throw getMapError;
      return map;
    }),
    invalidate: vi.fn().mockResolvedValue(Object.keys(map).length),
  };
}

describe("createGenderHandler", () => {
  let say;
  let client;
  let service;
  let handler;

  beforeEach(() => {
    say = makeSay();
    client = makeClient();
    service = makeService();
    handler = createGenderHandler({ genderMapService: service });
  });

  it("pings male members on !bros and excludes others", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros let's go", ts: "1" },
      say,
      client,
    });
    expect(say).toHaveBeenCalledTimes(1);
    const arg = say.mock.calls[0][0];
    expect(arg.text).toBe("<@U_CALLER> pinged males: <@U_MALE_1> <@U_MALE_2>");
    expect(arg.thread_ts).toBeUndefined();
  });

  it("pings female members on !sis", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "hey !sis", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_CALLER> pinged females: <@U_FEMALE_1>");
  });

  it("paginates conversations.members until cursor empty", async () => {
    client = makeClient({ membersPages: [["U_MALE_1"], ["U_MALE_2"]] });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(client.conversations.members).toHaveBeenCalledTimes(2);
    const firstCall = client.conversations.members.mock.calls[0][0];
    expect(firstCall.channel).toBe("C1");
    expect(firstCall.limit).toBe(200);
    expect(firstCall.cursor).toBeUndefined();
    const secondCall = client.conversations.members.mock.calls[1][0];
    expect(secondCall.cursor).toBe("c1");
  });

  it("posts the empty-target message when no members match", async () => {
    service = makeService({ map: { U_FEMALE_1: "female" } });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("No male members configured for this channel.");
  });

  it("uses generic prefix when caller user is absent", async () => {
    await handler({
      event: { type: "message", channel: "C1", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("male ping: <@U_MALE_1> <@U_MALE_2>");
  });

  it("on !refresh-genders, invalidates and replies with count", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders", ts: "1" },
      say,
      client,
    });
    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(client.conversations.members).not.toHaveBeenCalled();
    expect(say.mock.calls[0][0].text).toBe("Refreshed gender map. 3 entries loaded.");
  });

  it("refresh wins when both refresh and trigger appear", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders !bros", ts: "1" },
      say,
      client,
    });
    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(client.conversations.members).not.toHaveBeenCalled();
  });

  it("replies with error message when getMap throws", async () => {
    service = makeService({ getMapError: new Error("sheets down") });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("Could not load gender map: sheets down");
  });

  it("replies with error message when conversations.members throws", async () => {
    client = makeClient({ membersError: new Error("slack down") });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("Could not list channel members: slack down");
  });

  it("replies with refresh error message when invalidate throws", async () => {
    service.invalidate = vi.fn().mockRejectedValue(new Error("network"));
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("Refresh failed: network");
  });

  it("when both !bros and !sis appear, resolves to male", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!sis !bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_CALLER> pinged males: <@U_MALE_1> <@U_MALE_2>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/gender.test.js`
Expected: FAIL with "Failed to load url ... src/events/gender.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/events/gender.js`:

```js
import { GENDER_REFRESH_RE, resolveTarget } from "../lib/gender-triggers.js";

async function fetchAllMembers(client, channel) {
  const all = [];
  let cursor;
  for (;;) {
    const args = { channel, limit: 200 };
    if (cursor) args.cursor = cursor;
    const res = await client.conversations.members(args);
    if (Array.isArray(res.members)) all.push(...res.members);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!cursor) break;
  }
  return all;
}

export function createGenderHandler({ genderMapService }) {
  return async function handleGender({ event, say, client }) {
    const text = event.text || "";

    if (GENDER_REFRESH_RE.test(text)) {
      try {
        const count = await genderMapService.invalidate();
        await say({ text: `Refreshed gender map. ${count} entries loaded.` });
      } catch (err) {
        await say({ text: `Refresh failed: ${err.message}` });
      }
      return;
    }

    const target = resolveTarget(text);
    if (!target) return;

    let map;
    try {
      map = await genderMapService.getMap();
    } catch (err) {
      await say({ text: `Could not load gender map: ${err.message}` });
      return;
    }

    let members;
    try {
      members = await fetchAllMembers(client, event.channel);
    } catch (err) {
      await say({ text: `Could not list channel members: ${err.message}` });
      return;
    }

    const targets = members.filter((u) => map[u] === target);
    if (targets.length === 0) {
      await say({ text: `No ${target} members configured for this channel.` });
      return;
    }

    const mentions = targets.map((u) => `<@${u}>`).join(" ");
    const prefix = event.user ? `<@${event.user}> pinged ${target}s:` : `${target} ping:`;
    await say({ text: `${prefix} ${mentions}` });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/gender.test.js`
Expected: PASS (all eleven tests).

- [ ] **Step 5: Commit**

```bash
git add src/events/gender.js tests/events/gender.test.js
git commit -m "feat(gender): event handler for trigger and refresh"
```

---

## Task 4: dispatch router routes gender events first

**Files:**
- Modify: `src/lambda/dispatch.js`
- Test: `tests/lambda/dispatch.test.js`

The router now accepts an optional `genderHandler`. When the event is a `message` whose text matches a gender regex, route to `genderHandler` and skip the maintenance path. Otherwise fall through to existing behavior. `say()` in this path posts top-level (no `thread_ts` from the event), since gender pings are channel-wide.

Existing tests pass no `genderHandler` — those must continue to pass (treat missing handler as a no-op route, fall through).

- [ ] **Step 1: Write the failing tests (extend existing file)**

Append to `tests/lambda/dispatch.test.js` (inside the existing `describe("dispatchSlackEvent", ...)` block, before its closing brace):

```js
  it("routes a !bros message to genderHandler (top-level, no thread_ts)", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn().mockResolvedValue();
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!bros let's go", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client,
    });
    expect(genderHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    const args = genderHandler.mock.calls[0][0];
    await args.say({ text: "ping" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "ping" });
  });

  it("routes !refresh-genders to genderHandler", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!refresh-genders", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not route !bros to gender path when genderHandler is undefined", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!bros", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not route !bros from an app_mention event (gender is message-only)", async () => {
    const handler = vi.fn().mockResolvedValue();
    const genderHandler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", channel: "C1", text: "<@U_BOT> !bros", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still routes non-gender thread messages to the maintenance handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    const genderHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: the four new `gender` / `routes`-named tests FAIL; existing tests still pass.

- [ ] **Step 3: Modify `src/lambda/dispatch.js`**

Replace the file contents with:

```js
import { matchesGenderEvent } from "../lib/gender-triggers.js";

function shouldSkip(event) {
  if (event.type === "app_mention") return false;

  if (event.type === "message") {
    if (!event.thread_ts) return true;
    if (event.bot_id || event.subtype) return true;
    if (/<@[A-Z0-9_]+>/.test(event.text || "")) return true;
    return false;
  }

  return true;
}

export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, client }) {
  const event = slackEnvelope.event;
  if (!event) return;

  if (
    genderHandler &&
    event.type === "message" &&
    !event.bot_id &&
    !event.subtype &&
    matchesGenderEvent(event.text || "")
  ) {
    const sayTopLevel = (msg) =>
      client.chat.postMessage({ channel: event.channel, ...msg });
    await genderHandler({ event, say: sayTopLevel, client });
    return;
  }

  if (shouldSkip(event)) return;

  const say = (msg) =>
    client.chat.postMessage({
      channel: event.channel,
      ...msg,
    });

  await handler({ event, say, client });
}
```

- [ ] **Step 4: Run all dispatch tests to verify they pass**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: PASS (original tests + five new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lambda/dispatch.js tests/lambda/dispatch.test.js
git commit -m "feat(dispatch): route gender-trigger messages to genderHandler"
```

---

## Task 5: Wire genderHandler into clients + worker

**Files:**
- Modify: `src/lambda/clients.js`
- Modify: `src/lambda/worker.js`
- Test: `tests/lambda/worker.test.js`

`getDeps()` constructs the `genderMapService` (TTL 7 days, tab name `Gender Map`) and the `genderHandler`. `worker.handler` passes both `handler` and `genderHandler` into `dispatchSlackEvent`.

- [ ] **Step 1: Write the failing test (extend worker test)**

Replace the entire contents of `tests/lambda/worker.test.js` with:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchMock = vi.fn().mockResolvedValue();
const handlerMock = vi.fn().mockResolvedValue();
const genderHandlerMock = vi.fn().mockResolvedValue();
const fakeClient = { id: "slack" };

vi.mock("../../src/lambda/dispatch.js", () => ({
  dispatchSlackEvent: dispatchMock,
}));

vi.mock("../../src/lambda/clients.js", () => ({
  getDeps: () => ({ client: fakeClient, handler: handlerMock, genderHandler: genderHandlerMock }),
}));

describe("worker.handler", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    handlerMock.mockClear();
    genderHandlerMock.mockClear();
  });

  it("calls dispatchSlackEvent for each SQS record and passes both handlers", async () => {
    const { handler } = await import("../../src/lambda/worker.js");

    const body1 = JSON.stringify({ event: { type: "app_mention", channel: "C1", ts: "1" } });
    const body2 = JSON.stringify({ event: { type: "message", channel: "C1", text: "!bros", user: "U1", ts: "1" } });

    await handler({ Records: [{ body: body1 }, { body: body2 }] });

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[0][0].slackEnvelope.event.type).toBe("app_mention");
    expect(dispatchMock.mock.calls[1][0].slackEnvelope.event.type).toBe("message");
    expect(dispatchMock.mock.calls[0][0].handler).toBe(handlerMock);
    expect(dispatchMock.mock.calls[0][0].genderHandler).toBe(genderHandlerMock);
    expect(dispatchMock.mock.calls[0][0].client).toBe(fakeClient);
  });

  it("propagates errors so SQS can retry", async () => {
    const { handler } = await import("../../src/lambda/worker.js");
    dispatchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      handler({ Records: [{ body: JSON.stringify({ event: { type: "app_mention" } }) }] })
    ).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run worker test to verify it fails**

Run: `npx vitest run tests/lambda/worker.test.js`
Expected: FAIL — `genderHandler` is undefined in dispatch call (current worker only passes `handler`).

- [ ] **Step 3: Modify `src/lambda/worker.js`**

Replace contents with:

```js
import { dispatchSlackEvent } from "./dispatch.js";
import { getDeps } from "./clients.js";

export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      genderHandler,
      client,
    });
  }
}
```

- [ ] **Step 4: Modify `src/lambda/clients.js`**

Replace contents with:

```js
import { WebClient } from "@slack/web-api";
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createMentionHandler } from "../events/mention.js";
import { createGenderMapService } from "../services/genderMap.js";
import { createGenderHandler } from "../events/gender.js";

let cached;

export function getDeps() {
  if (cached) return cached;

  const config = loadConfig();

  const slack = new WebClient(config.slackBotToken);

  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret
  );
  oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
  const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
  const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

  const groqClient = new OpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: config.groqApiKey,
  });
  const groqService = createGroqService(groqClient);
  const dedupService = createDedupService(groqService);

  const handler = createMentionHandler({
    sheetsService,
    groqService,
    dedupService,
    channelIds: config.slackChannelIds,
    spreadsheetId: config.googleSheetId,
  });

  const genderMapService = createGenderMapService({
    sheetsClient,
    spreadsheetId: config.googleSheetId,
    ttlMs: config.genderCacheTtlDays * 24 * 3600 * 1000,
    tabName: config.genderSheetTab,
  });
  const genderHandler = createGenderHandler({ genderMapService });

  cached = { client: slack, handler, genderHandler };
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
```

- [ ] **Step 5: Run worker test to verify it passes**

Run: `npx vitest run tests/lambda/worker.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lambda/clients.js src/lambda/worker.js tests/lambda/worker.test.js
git commit -m "feat(gender): wire genderHandler through clients and worker"
```

---

## Task 6: Optional config knobs for tab name and TTL

**Files:**
- Modify: `src/config.js`
- Test: `tests/config.test.js`

Add two optional reads with defaults so Task 5's `clients.js` can rely on them.

- [ ] **Step 1: Write the failing tests (extend existing file)**

Open `tests/config.test.js` and add these tests inside the existing top-level `describe` (after the last existing test). If the file uses a different top-level layout, place them as sibling tests at the same level as existing config tests.

```js
  it("defaults genderSheetTab to 'Gender Map' and genderCacheTtlDays to 7", async () => {
    process.env.SLACK_BOT_TOKEN = "x";
    process.env.SLACK_CHANNEL_IDS = "C1";
    process.env.GOOGLE_SHEET_ID = "s";
    process.env.GOOGLE_CLIENT_ID = "g";
    process.env.GOOGLE_CLIENT_SECRET = "g";
    process.env.GOOGLE_REFRESH_TOKEN = "g";
    process.env.GROQ_API_KEY = "g";
    delete process.env.GENDER_SHEET_TAB;
    delete process.env.GENDER_CACHE_TTL_DAYS;

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.genderSheetTab).toBe("Gender Map");
    expect(config.genderCacheTtlDays).toBe(7);
  });

  it("honors GENDER_SHEET_TAB and GENDER_CACHE_TTL_DAYS env overrides", async () => {
    process.env.SLACK_BOT_TOKEN = "x";
    process.env.SLACK_CHANNEL_IDS = "C1";
    process.env.GOOGLE_SHEET_ID = "s";
    process.env.GOOGLE_CLIENT_ID = "g";
    process.env.GOOGLE_CLIENT_SECRET = "g";
    process.env.GOOGLE_REFRESH_TOKEN = "g";
    process.env.GROQ_API_KEY = "g";
    process.env.GENDER_SHEET_TAB = "Roster";
    process.env.GENDER_CACHE_TTL_DAYS = "1";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.genderSheetTab).toBe("Roster");
    expect(config.genderCacheTtlDays).toBe(1);
  });
```

- [ ] **Step 2: Run config tests to verify they fail**

Run: `npx vitest run tests/config.test.js`
Expected: the two new tests FAIL — `genderSheetTab`/`genderCacheTtlDays` undefined.

- [ ] **Step 3: Modify `src/config.js`**

Replace contents with:

```js
const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_IDS",
  "GOOGLE_SHEET_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GROQ_API_KEY",
];

function parseChannelIds(raw) {
  const ids = (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("SLACK_CHANNEL_IDS must contain at least one channel ID");
  }
  return new Set(ids);
}

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const ttlRaw = process.env.GENDER_CACHE_TTL_DAYS;
  const genderCacheTtlDays = ttlRaw ? Number(ttlRaw) : 7;

  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackChannelIds: parseChannelIds(process.env.SLACK_CHANNEL_IDS),
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    groqApiKey: process.env.GROQ_API_KEY,
    eventQueueUrl: process.env.EVENT_QUEUE_URL,
    genderSheetTab: process.env.GENDER_SHEET_TAB || "Gender Map",
    genderCacheTtlDays,
  };
}
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `npx vitest run tests/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat(config): GENDER_SHEET_TAB and GENDER_CACHE_TTL_DAYS knobs"
```

---

## Task 7: Receiver prefilter (perf optimization)

**Files:**
- Modify: `src/lambda/receiver.js`
- Test: `tests/lambda/receiver.test.js`

Drop noisy `message` chatter at the receiver so we don't spend SQS+Lambda invocations on every public-channel message once `message.channels` is subscribed. Pass-through rules for `event.type === 'message'`:

- text matches `matchesGenderEvent` OR
- text contains a `<@U...>` Slack mention OR
- `thread_ts` is present

All other event types (`app_mention`, etc.) unchanged.

- [ ] **Step 1: Write the failing tests (extend existing file)**

Append to `tests/lambda/receiver.test.js` (inside the existing `describe("receiver.handler", ...)` block, before its closing brace):

```js
  function eventCallback(eventObj) {
    return JSON.stringify({ type: "event_callback", event: eventObj });
  }

  it("enqueues a !bros plain message", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", text: "!bros let's go", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues a thread reply with no mention", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues a top-level message with a Slack mention", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("drops ordinary top-level chatter (no trigger, no mention, no thread)", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", text: "good morning everyone", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("always enqueues app_mention events regardless of text", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "app_mention", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run receiver tests to verify they fail**

Run: `npx vitest run tests/lambda/receiver.test.js`
Expected: the "drops ordinary chatter" test FAILS (currently enqueues everything). Others may pass already.

- [ ] **Step 3: Modify `src/lambda/receiver.js`**

Replace contents with:

```js
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifySlackSignature } from "./slack-signature.js";
import { matchesGenderEvent } from "../lib/gender-triggers.js";

const sqs = new SQSClient({});

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function readBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function shouldEnqueue(parsed) {
  const event = parsed.event;
  if (!event) return false;
  if (event.type !== "message") return true;
  const text = event.text || "";
  if (matchesGenderEvent(text)) return true;
  if (/<@[A-Z0-9_]+>/.test(text)) return true;
  if (event.thread_ts) return true;
  return false;
}

export async function handler(event) {
  const body = readBody(event);
  const timestamp = getHeader(event.headers, "x-slack-request-timestamp");
  const signature = getHeader(event.headers, "x-slack-signature");

  const ok = verifySlackSignature({
    secret: process.env.SLACK_SIGNING_SECRET,
    body,
    timestamp,
    signature,
  });
  if (!ok) {
    return { statusCode: 401, body: "invalid signature" };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: "invalid json" };
  }

  if (parsed.type === "url_verification") {
    return { statusCode: 200, body: parsed.challenge };
  }

  if (!shouldEnqueue(parsed)) {
    return { statusCode: 200, body: "" };
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.EVENT_QUEUE_URL,
      MessageBody: body,
    })
  );

  return { statusCode: 200, body: "" };
}
```

- [ ] **Step 4: Run all receiver tests to verify they pass**

Run: `npx vitest run tests/lambda/receiver.test.js`
Expected: PASS (original tests + five new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lambda/receiver.js tests/lambda/receiver.test.js
git commit -m "feat(receiver): drop chatter, keep gender/mention/thread messages"
```

---

## Task 8: README docs for Slack scopes and Gender Map tab

**Files:**
- Modify: `README.md`

Two new sections users need to read before deployment will function. No tests; this is documentation.

- [ ] **Step 1: Read current README to find the right insertion point**

Run: `head -80 README.md` and note where the existing setup / Slack / Google Sheet sections live, so the new sections are placed adjacent to related content. If no obvious "Slack setup" section exists, append the new sections at the bottom of the file.

- [ ] **Step 2: Add the two new sections**

Append (or insert near existing setup docs) the following markdown:

```markdown
## Gender Aliases

Users can ping channel members by gender by typing `!bros` / `!brothers` / `@bros` / `@brothers` (pings members mapped to `male`) or `!sis` / `!sisters` / `@sis` / `@sisters` (pings `female`). `!refresh-genders` reloads the map from the sheet.

Triggers fire in any public or private channel the bot is a member of. They do **not** honor `SLACK_CHANNEL_IDS` (that allowlist still gates the maintenance handler only).

### Gender Map sheet tab

Add a tab named `Gender Map` (override with `GENDER_SHEET_TAB`) to the spreadsheet at `GOOGLE_SHEET_ID`:

| user_id     | gender |
|-------------|--------|
| U01ABC123   | male   |
| U02DEF456   | female |

- Row 1: header. Data starts at row 2.
- Column A: Slack user ID. Find via the user's profile → `...` → Copy member ID.
- Column B: literal `male` or `female` (case-insensitive on read).

Rows with blank `user_id` or with `gender` outside `{male, female}` are skipped.

The map is cached in memory for 7 days per warm Lambda container (override with `GENDER_CACHE_TTL_DAYS`). Cold starts always refetch. `!refresh-genders` invalidates the cache and refetches immediately.

### Slack app prerequisites

Before the gender feature works in production, update the Slack app config:

- **OAuth scopes (bot):** add `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`. Reinstall the app afterwards.
- **Event Subscriptions:** subscribe to `message.channels` (public) and `message.groups` (private) bot events, in addition to `app_mention`.
- Invite the bot to each channel where these triggers should work.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(gender): document triggers, sheet tab, and Slack prerequisites"
```

---

## Task 9: Full test suite + manual smoke checklist

**Files:** none modified

- [ ] **Step 1: Run the full vitest suite**

Run: `npm test`
Expected: all tests pass (existing + new). Note the count delta vs. before this work — should be roughly `+30` new tests.

- [ ] **Step 2: Manual smoke checklist (post-deploy, not part of this branch)**

This branch is code-complete after Task 8. Before declaring the feature working end-to-end, the operator must do the following out-of-band (record the result in the PR description, not in this plan):

1. Apply the Slack scope/event changes from the README. Reinstall the app.
2. Populate the `Gender Map` tab with at least one `male` and one `female` row pointing to real Slack user IDs.
3. Deploy to AWS: `git push origin <branch>` (CI builds and deploys via existing `deploy.yml`) — or, locally, `sam build && sam deploy`.
4. In a channel the bot has joined:
   - Send `!bros` — expect a top-level reply listing mapped male members.
   - Send `!sis` — expect a top-level reply listing mapped female members.
   - Send `!refresh-genders` — expect `Refreshed gender map. N entries loaded.`
   - Send plain chatter — expect no reply and no log spam.
5. Tail CloudWatch logs for `WorkerFn` to confirm no errors during the run.

- [ ] **Step 3: Final commit (none — verification only)**

No commit needed. If issues surface, file follow-up tasks; do not patch them blindly into this plan.

---

## Self-review notes (from author)

- **Spec coverage:** every component listed in the spec (`gender-triggers`, `genderMap`, `gender` handler, `dispatch`, `receiver`, `clients`, `worker`, config knobs, README) maps to a task above (Tasks 1–8). Manual smoke covered in Task 9.
- **Precedence edge case** (`!bros` + `!sis` in one message → `male`) covered in Task 1 (`resolveTarget`) and Task 3 (handler test).
- **Refresh precedence** (`!refresh-genders !bros` → refresh wins) covered in Task 3.
- **Bot/self filtering:** intentionally not filtered. Matches Python source. Documented in spec, not enforced.
- **Channel scope** (gender works in any channel; maintenance still allowlist-gated) implicit in the dispatch routing — the gender route in Task 4 never consults `channelIds`. The maintenance handler still does (no change to `mention.js`).
- **Type / name consistency:** `genderMapService`, `genderHandler`, `createGenderMapService`, `createGenderHandler`, `getMap`, `invalidate`, `matchesGenderEvent`, `resolveTarget`, `GENDER_TRIGGER_RE`, `GENDER_REFRESH_RE` used uniformly across all tasks.
