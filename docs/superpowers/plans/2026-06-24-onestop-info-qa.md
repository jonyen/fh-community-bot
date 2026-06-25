# OneStop Info Q&A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer FH/OneStop questions in the `#onestop` channel from the OneStop sheet's reference tabs (read-only, no-invent), reusing the existing ambient handler; rename the channel/persona from "reservations" to "OneStop".

**Architecture:** A new read-only `onestopInfo` service caches an allowlisted "info corpus" rendered from the OneStop sheet's reference tabs. Groq's reservation parse gains an `"info"` intent (top-level router) and an `answerInfoQuestion(question, corpus)` method. The channel handler routes `info` intents to corpus→answer→reply; reservation intents are unchanged. The bot's ambient channel id is renamed `#reservations`→`#onestop` with an env fallback.

**Tech Stack:** Node 22 ESM, Google Sheets v4, Groq (llama-3.3-70b-versatile), Vitest, AWS SAM.

## Global Constraints

- **Runtime:** Node 22 ESM (`"type": "module"`). **No new dependencies.**
- **Read-only:** the info feature never writes the sheet.
- **No-invent:** `answerInfoQuestion` answers strictly from the supplied corpus; absent info → "I don't see that in OneStop."
- **Reuse sheet id:** the corpus reads `config.reservationsSheetId` (the OneStop sheet `163Qo6xAr0DZvBv3MdPsE3aQCX7BurRROA7FcRJFHcOw`). No new sheet id.
- **Channel id:** read as `process.env.ONESTOP_CHANNEL_ID || process.env.RESERVATIONS_CHANNEL_ID` (fallback so a deploy mid-migration never goes dark). Config key is `onestopChannelId`.
- **Persona:** `BOT_USERNAME = "OneStop (beta)"`; `icon_emoji = ":calendar:"` unchanged.
- **Info corpus allowlist (exact tabs):** `BULLETIN, Links, Rotations, Zoom & WR & DT, IH, Category/Legend, Cleaning Assignments, Summer Cleaning Assignments`. Corpus TTL default **5 min**. Overridable via `ONESTOP_INFO_TABS` (comma-separated).
- **Tests:** Vitest, deps mocked, no real I/O. One file: `npx vitest run <path>`; full suite `npm test`.
- **Spec:** `docs/superpowers/specs/2026-06-24-onestop-info-qa-design.md`.

---

## File Structure

- **Create** `src/services/onestopInfo.js` — `createOneStopInfoService` (corpus + TTL cache). (+test)
- **Modify** `src/services/groq.js` — `info` intent in the prompt + `answerInfoQuestion`. (+test)
- **Modify** `src/events/reservations.js` — info branch + persona rename. (+test)
- **Modify** `src/config.js`, `src/lambda/receiver.js`, `src/lambda/dispatch.js`, `src/lambda/worker.js`, `src/lambda/clients.js`, `template.yaml`, `.github/workflows/deploy.yml` — channel rename + wire the info service. (+config/receiver/dispatch tests)

---

### Task 1: OneStop info corpus service

**Files:**
- Create: `src/services/onestopInfo.js`
- Test: `tests/services/onestopInfo.test.js`

**Interfaces:**
- Produces `createOneStopInfoService({ sheetsClient, sheetId, tabs, ttlMs, now })` →
  - `corpus(): Promise<string>` — fetch each allowlisted tab's `A1:Z`, render `### <tab>\n` + each non-empty row as `cell | cell | …`, join tabs with a blank line; cached for `ttlMs` (default 5 min). A tab whose fetch throws is skipped. `tabs` defaults to the allowlist; `now` defaults to `() => new Date()`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/services/onestopInfo.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOneStopInfoService } from "../../src/services/onestopInfo.js";

describe("OneStopInfoService", () => {
  let mockSheets, clock, service;
  beforeEach(() => {
    clock = 0;
    mockSheets = { spreadsheets: { values: { get: vi.fn(async ({ range }) => {
      if (range.startsWith("'BULLETIN'")) return { data: { values: [
        ["Subject", "Details"], ["FH Door code", "0326"], ["", ""],
      ] } };
      if (range.startsWith("'Links'")) return { data: { values: [
        ["DMV Travel Workspace", "Wanda Stucki"],
      ] } };
      if (range.startsWith("'Boom'")) throw new Error("no such tab");
      return { data: { values: [] } };
    }) } } };
    service = createOneStopInfoService({
      sheetsClient: mockSheets, sheetId: "OS1",
      tabs: ["BULLETIN", "Links", "Boom"], ttlMs: 1000,
      now: () => new Date(clock),
    });
  });

  it("renders allowlisted tabs, skips empty rows, skips an erroring tab", async () => {
    const text = await service.corpus();
    expect(text).toContain("### BULLETIN");
    expect(text).toContain("FH Door code | 0326");
    expect(text).toContain("### Links");
    expect(text).toContain("DMV Travel Workspace | Wanda Stucki");
    expect(text).not.toContain("### Boom"); // erroring tab skipped
    expect(text).not.toMatch(/\n\s*\|\s*\n/); // no all-empty row rendered
  });

  it("only requests the configured tabs (never an excluded tab)", async () => {
    await service.corpus();
    const ranges = mockSheets.spreadsheets.values.get.mock.calls.map((c) => c[0].range);
    expect(ranges.some((r) => r.startsWith("'Config'"))).toBe(false);
    expect(ranges.some((r) => r.startsWith("'BULLETIN'"))).toBe(true);
  });

  it("caches within the TTL and refetches after it", async () => {
    await service.corpus();
    await service.corpus();
    expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledTimes(3); // 3 tabs, one round
    clock = 2000; // past ttl
    await service.corpus();
    expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledTimes(6);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/services/onestopInfo.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement**

```javascript
// src/services/onestopInfo.js
const DEFAULT_TABS = [
  "BULLETIN", "Links", "Rotations", "Zoom & WR & DT", "IH",
  "Category/Legend", "Cleaning Assignments", "Summer Cleaning Assignments",
];

export function createOneStopInfoService({
  sheetsClient, sheetId, tabs = DEFAULT_TABS, ttlMs = 5 * 60 * 1000, now = () => new Date(),
}) {
  let cache = { fetchedAt: 0, text: null };

  async function fetchCorpus() {
    const blocks = [];
    for (const tab of tabs) {
      let rows = [];
      try {
        const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A1:Z` });
        rows = res.data.values || [];
      } catch {
        continue; // a missing/erroring tab shouldn't break the corpus
      }
      const lines = [];
      for (const row of rows) {
        const cells = (row || []).map((c) => String(c == null ? "" : c).trim());
        if (cells.every((c) => c === "")) continue; // skip empty rows
        lines.push(cells.join(" | "));
      }
      if (lines.length) blocks.push(`### ${tab}\n${lines.join("\n")}`);
    }
    return blocks.join("\n\n");
  }

  async function corpus() {
    const t = now().getTime();
    if (cache.text !== null && t - cache.fetchedAt < ttlMs) return cache.text;
    const text = await fetchCorpus();
    cache = { fetchedAt: t, text };
    return text;
  }

  return { corpus };
}
```

- [ ] **Step 4: Run** the test file — PASS. Then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/services/onestopInfo.js tests/services/onestopInfo.test.js
git commit -m "feat(onestop): info corpus service (allowlisted tabs, TTL cache)"
```

---

### Task 2: Groq info intent + answerInfoQuestion

**Files:**
- Modify: `src/services/groq.js`
- Test: `tests/services/groq.test.js`

**Interfaces:**
- Produces:
  - `parseReservationRequest` may now return `intent:"info"` for general OneStop reference questions (parser passes the model's JSON through — the change is the prompt).
  - `answerInfoQuestion(question, corpus): Promise<string>` — calls the model with the corpus + question; returns the answer text, or `"Can't reach OneStop right now."` on API failure.

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("parseReservationRequest", …)` block, and add a new `describe` for the answerer)

```javascript
  it("routes a general OneStop question to intent 'info'", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"info","target":null,"date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("what's the FH door code?", "2026-06-24T12:00:00Z");
    expect(out.intent).toBe("info");
  });
```

```javascript
describe("answerInfoQuestion", () => {
  it("passes the corpus + question to the model and returns its answer", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "The FH door code is 0326." } }] });
    const svc = createGroqService({ chat: { completions: { create } } });
    const out = await svc.answerInfoQuestion("what's the door code?", "### BULLETIN\nFH Door code | 0326");
    expect(out).toBe("The FH door code is 0326.");
    const userMsg = create.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("0326");                 // corpus included
    expect(userMsg).toContain("what's the door code?"); // question included
  });
  it("returns a graceful fallback on API failure", async () => {
    const svc = createGroqService({ chat: { completions: { create: vi.fn().mockRejectedValue(new Error("boom")) } } });
    expect(await svc.answerInfoQuestion("q", "corpus")).toBe("Can't reach OneStop right now.");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/services/groq.test.js` — the `info` parse test PASSES (passthrough); the `answerInfoQuestion` tests FAIL (method missing).

- [ ] **Step 3a: Update `SYSTEM_PROMPT_RESERVATION` in `src/services/groq.js`**

Change the opening clause `…a community member's message in a reservations channel into JSON.` → `…a community member's message in a community OneStop channel into JSON.`

Add this intent bullet immediately BEFORE the `- "none":` line:

```
- "info": the person asks for OneStop REFERENCE information that is NOT a room/resource booking or schedule — door/lock codes, links, zoom links, duty rotations ("who's on lockup this week?"), interhigh sites ("where does IH Cabin John meet?"), cleaning assignments, categories, or who is in charge of something (e.g. "what's the door code?", "zoom link for AYM?", "who runs the travel workspace?"). Room/resource availability or scheduling stays check/list/reserve/history; off-topic chatter stays none.
```

- [ ] **Step 3b: Add the system prompt constant** (next to the other `SYSTEM_PROMPT_*` consts)

```javascript
const SYSTEM_PROMPT_INFO = `You answer questions for an FH community ("OneStop") using ONLY the provided OneStop reference data. Quote the specific value(s) that answer the question (e.g. a code, a link, a name). If the answer is not present in the data, reply exactly: "I don't see that in OneStop." Never invent, guess, or use outside knowledge. Keep the answer short.`;
```

- [ ] **Step 3c: Add the method inside `createGroqService` and export it**

```javascript
  async function answerInfoQuestion(question, corpus) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_INFO },
          { role: "user", content: `OneStop data:\n${corpus}\n\nQuestion: ${question}` },
        ],
        max_tokens: 400,
      });
      return res.choices[0].message.content.trim();
    } catch {
      return "Can't reach OneStop right now.";
    }
  }
```

Add `answerInfoQuestion` to the object returned by `createGroqService` (alongside `parseReservationRequest`, `chooseCandidates`, etc.).

- [ ] **Step 4: Run** `npx vitest run tests/services/groq.test.js` then `npm test` — green.

- [ ] **Step 5: Commit**

```bash
git add src/services/groq.js tests/services/groq.test.js
git commit -m "feat(onestop): groq 'info' intent + answerInfoQuestion (no-invent)"
```

---

### Task 3: Handler info branch + persona rename

**Files:**
- Modify: `src/events/reservations.js`
- Test: `tests/events/reservations.test.js`

**Interfaces:**
- Consumes: `onestopInfoService.corpus()` (Task 1), `groqService.answerInfoQuestion` (Task 2).
- Produces: `createReservationHandler` accepts an `onestopInfoService` param; `handleChannelMessage` routes `parsed.intent === "info"` to corpus→answer→reply (using the thread-joined `text`). `BOT_USERNAME` becomes `"OneStop (beta)"`.

- [ ] **Step 1: Update the persona assertions in the existing test**

In `tests/events/reservations.test.js`, replace every `"Reservations (beta)"` with `"OneStop (beta)"` (6 occurrences: lines ~25, ~58 description, ~66, ~167, ~233, ~271).

- [ ] **Step 2: Write the failing test** (append a new `describe` block)

```javascript
describe("ReservationHandler onestop info", () => {
  let reservationsService, groqService, onestopInfoService, client, handler;
  beforeEach(() => {
    reservationsService = { classifyTarget: vi.fn(), checkRoom: vi.fn(), makeRoomReservation: vi.fn(), listReservations: vi.fn(), resourceLastUsed: vi.fn() };
    groqService = { parseReservationRequest: vi.fn(), chooseCandidates: vi.fn().mockResolvedValue([]), answerInfoQuestion: vi.fn() };
    onestopInfoService = { corpus: vi.fn() };
    client = { chat: { postMessage: vi.fn().mockResolvedValue({}) }, conversations: { replies: vi.fn() }, users: { info: vi.fn() } };
    handler = createReservationHandler({ reservationsService, groqService, onestopInfoService, now: () => new Date("2026-06-24T12:00:00Z") });
  });
  const msg = (over = {}) => ({ type: "message", channel: "Cres", user: "U1", ts: "1.1", text: "", ...over });

  it("answers an info question from the corpus", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "info", target: null, date: null, startTime: null, endTime: null });
    onestopInfoService.corpus.mockResolvedValue("### BULLETIN\nFH Door code | 0326");
    groqService.answerInfoQuestion.mockResolvedValue("The FH door code is 0326.");
    await handler.handleChannelMessage({ event: msg({ text: "what's the door code?" }), client });
    expect(onestopInfoService.corpus).toHaveBeenCalled();
    expect(groqService.answerInfoQuestion).toHaveBeenCalledWith("what's the door code?", "### BULLETIN\nFH Door code | 0326");
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({ username: "OneStop (beta)", text: "The FH door code is 0326." });
  });

  it("replies gracefully when the corpus fetch fails", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "info", target: null });
    onestopInfoService.corpus.mockRejectedValue(new Error("sheets down"));
    await handler.handleChannelMessage({ event: msg({ text: "door code?" }), client });
    expect(client.chat.postMessage.mock.calls[0][0].text.toLowerCase()).toContain("can't reach onestop");
  });

  it("does not call the info service for a reservation intent", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: "FH MPR", date: "2026-06-27" });
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleChannelMessage({ event: msg({ text: "what's booked in the MPR saturday" }), client });
    expect(onestopInfoService.corpus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run** `npx vitest run tests/events/reservations.test.js` — FAIL (persona + info branch).

- [ ] **Step 4a: Rename the persona** in `src/events/reservations.js`

```javascript
const BOT_USERNAME = "OneStop (beta)";
```

- [ ] **Step 4b: Add the `onestopInfoService` factory param**

```javascript
export function createReservationHandler({ reservationsService, groqService, onestopInfoService, now }) {
```

- [ ] **Step 4c: Add the info branch** in `handleChannelMessage`, immediately AFTER the line `if (!parsed || parsed.intent === "none") return;` and BEFORE the `history` branch:

```javascript
    if (parsed.intent === "info") {
      if (!onestopInfoService) return;
      let answer;
      try {
        const corpus = await onestopInfoService.corpus();
        answer = await groqService.answerInfoQuestion(text, corpus);
      } catch {
        answer = "Can't reach OneStop right now.";
      }
      await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI, text: answer });
      return;
    }
```

(The handler's local `text` is the thread-joined message — pass it as the question. `say`, `BOT_ICON_EMOJI` already exist.)

- [ ] **Step 5: Run** `npx vitest run tests/events/reservations.test.js` then `npm test` — green.

- [ ] **Step 6: Commit**

```bash
git add src/events/reservations.js tests/events/reservations.test.js
git commit -m "feat(onestop): route 'info' intent to corpus answerer; persona 'OneStop (beta)'"
```

---

### Task 4: Channel rename (`#reservations` → `#onestop`)

**Files:**
- Modify: `src/config.js`, `src/lambda/receiver.js`, `src/lambda/dispatch.js`, `src/lambda/worker.js`, `src/lambda/clients.js`, `template.yaml`, `.github/workflows/deploy.yml`
- Test: `tests/config.test.js`, `tests/lambda/receiver.test.js`, `tests/lambda/dispatch.test.js`

**Interfaces:**
- Produces: `config.onestopChannelId` (= `ONESTOP_CHANNEL_ID || RESERVATIONS_CHANNEL_ID || null`). Receiver/dispatch ambient-route on it. `dispatchSlackEvent`/`worker` thread `onestopChannelId` (renamed from `reservationsChannelId`).

- [ ] **Step 1: Update `tests/config.test.js`** (the `reservationsChannelId` test, ~line 167)

```javascript
  it("loads onestopChannelId from ONESTOP_CHANNEL_ID, falling back to RESERVATIONS_CHANNEL_ID", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.ONESTOP_CHANNEL_ID;
    delete process.env.RESERVATIONS_CHANNEL_ID;
    expect(loadConfig().onestopChannelId).toBeNull();
    process.env.RESERVATIONS_CHANNEL_ID = "Cold";
    expect(loadConfig().onestopChannelId).toBe("Cold"); // fallback
    process.env.ONESTOP_CHANNEL_ID = "Conestop";
    expect(loadConfig().onestopChannelId).toBe("Conestop"); // new var wins
  });
```

- [ ] **Step 2: Update `tests/lambda/dispatch.test.js`** — replace the three `reservationsChannelId: "Cres"` arguments with `onestopChannelId: "Cres"` (lines ~344, ~354, ~364).

- [ ] **Step 3: Update `tests/lambda/receiver.test.js`** — add an ONESTOP var case alongside the existing `RESERVATIONS_CHANNEL_ID = "Cres"` cases. After the block that sets `process.env.RESERVATIONS_CHANNEL_ID = "Cres"` (~line 183), add a test asserting the new var also enqueues:

```javascript
  it("enqueues every human message in the ONESTOP_CHANNEL_ID channel", () => {
    process.env.ONESTOP_CHANNEL_ID = "Cnew";
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "Cnew", text: "what's the door code?" } })).toBe(true);
    delete process.env.ONESTOP_CHANNEL_ID;
  });
```

- [ ] **Step 4: Run** `npx vitest run tests/config.test.js tests/lambda/dispatch.test.js tests/lambda/receiver.test.js` — FAIL.

- [ ] **Step 5a: Edit `src/config.js`** — replace the `reservationsChannelId` line:

```javascript
    onestopChannelId: process.env.ONESTOP_CHANNEL_ID || process.env.RESERVATIONS_CHANNEL_ID || null,
```

- [ ] **Step 5b: Edit `src/lambda/receiver.js`** — replace the channel check:

```javascript
  const onestopChannelId = process.env.ONESTOP_CHANNEL_ID || process.env.RESERVATIONS_CHANNEL_ID;
  if (onestopChannelId && event.channel === onestopChannelId) {
    return true; // ambient OneStop channel: every human message
  }
```

- [ ] **Step 5c: Edit `src/lambda/dispatch.js`** — rename the param and its uses (`reservationsChannelId` → `onestopChannelId`) in the `dispatchSlackEvent` signature and the `event.channel === onestopChannelId` guard.

- [ ] **Step 5d: Edit `src/lambda/worker.js`** — rename `reservationsChannelId` → `onestopChannelId` in the `getDeps()` destructure and the `dispatchSlackEvent({ … })` call.

- [ ] **Step 5e: Edit `src/lambda/clients.js`** — in the `cached = { … }` object, change `reservationsChannelId: config.reservationsChannelId` → `onestopChannelId: config.onestopChannelId`.

- [ ] **Step 5f: Edit `template.yaml`** — add a param and env (keep the old ones as the fallback source):

Add param next to `ReservationsChannelId`:
```yaml
  OneStopChannelId:      { Type: String, Default: "" }
```
Add to the Globals `Function.Environment.Variables` (next to `RESERVATIONS_CHANNEL_ID`):
```yaml
          ONESTOP_CHANNEL_ID: !Ref OneStopChannelId
```
And to the `WorkerFn` `Environment.Variables` (next to its `RESERVATIONS_CHANNEL_ID`):
```yaml
          ONESTOP_CHANNEL_ID: !Ref OneStopChannelId
```

- [ ] **Step 5g: Edit `.github/workflows/deploy.yml`** — add the env var and an optional override (keep the existing `RESERVATIONS_CHANNEL_ID` lines as fallback):

In the SAM deploy `env:`:
```yaml
          ONESTOP_CHANNEL_ID: ${{ vars.ONESTOP_CHANNEL_ID }}
```
In the `OPTIONAL_PARAMS` section:
```bash
          if [ -n "$ONESTOP_CHANNEL_ID" ]; then
            OPTIONAL_PARAMS+=("OneStopChannelId=$ONESTOP_CHANNEL_ID")
          fi
```

- [ ] **Step 6: Run** the three test files, then `npm test` — all green.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/lambda/receiver.js src/lambda/dispatch.js src/lambda/worker.js src/lambda/clients.js template.yaml .github/workflows/deploy.yml tests/config.test.js tests/lambda/dispatch.test.js tests/lambda/receiver.test.js
git commit -m "refactor(onestop): rename channel config #reservations -> #onestop (env fallback)"
```

---

### Task 5: Wire the info service + ONESTOP_INFO_TABS

**Files:**
- Modify: `src/config.js`, `src/lambda/clients.js`, `template.yaml`, `.github/workflows/deploy.yml`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `config.onestopInfoTabs` (array from `ONESTOP_INFO_TABS`, or `undefined` → service default). `clients.js` builds `onestopInfoService` when `config.reservationsSheetId` is set and passes it into `createReservationHandler`.

- [ ] **Step 1: Extend `tests/config.test.js`**

```javascript
  it("parses ONESTOP_INFO_TABS into a trimmed array (undefined when unset)", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.ONESTOP_INFO_TABS;
    expect(loadConfig().onestopInfoTabs).toBeUndefined();
    process.env.ONESTOP_INFO_TABS = "BULLETIN, Links ,IH";
    expect(loadConfig().onestopInfoTabs).toEqual(["BULLETIN", "Links", "IH"]);
  });
```

- [ ] **Step 2: Run** `npx vitest run tests/config.test.js` — FAIL.

- [ ] **Step 3: Edit `src/config.js`** — add next to `reservationsSheetId`:

```javascript
    onestopInfoTabs: process.env.ONESTOP_INFO_TABS
      ? process.env.ONESTOP_INFO_TABS.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
```

- [ ] **Step 4: Edit `src/lambda/clients.js`**

Add the import near the other service imports:
```javascript
import { createOneStopInfoService } from "../services/onestopInfo.js";
```

Inside the `if (config.reservationsSheetId) { … }` block, before `reservationHandler = createReservationHandler({ … })`, build the info service and pass it in:
```javascript
    const onestopInfoService = createOneStopInfoService({
      sheetsClient: google.sheets({ version: "v4", auth: oauth2Client }),
      sheetId: config.reservationsSheetId,
      tabs: config.onestopInfoTabs, // undefined → service allowlist default
      now: () => new Date(),
    });
    reservationHandler = createReservationHandler({
      reservationsService,
      groqService,
      onestopInfoService,
      now: () => new Date(),
    });
```

(Replace the existing `createReservationHandler({ reservationsService, groqService, now: … })` call with the one above — just adds `onestopInfoService`.)

- [ ] **Step 5: Edit `template.yaml`** — add an optional param + worker env for the tab override:

Param:
```yaml
  OneStopInfoTabs:       { Type: String, Default: "" }
```
In `WorkerFn` `Environment.Variables`:
```yaml
          ONESTOP_INFO_TABS:  !Ref OneStopInfoTabs
```

- [ ] **Step 6: Edit `.github/workflows/deploy.yml`** — env + optional override:

```yaml
          ONESTOP_INFO_TABS: ${{ vars.ONESTOP_INFO_TABS }}
```
```bash
          if [ -n "$ONESTOP_INFO_TABS" ]; then
            OPTIONAL_PARAMS+=("OneStopInfoTabs=$ONESTOP_INFO_TABS")
          fi
```

- [ ] **Step 7: Run** `npx vitest run tests/config.test.js` then `npm test` — all green.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/lambda/clients.js template.yaml .github/workflows/deploy.yml tests/config.test.js
git commit -m "feat(onestop): wire info service + optional ONESTOP_INFO_TABS override"
```

---

## Final verification

- [ ] `npm test` — every suite passes.
- [ ] Create the `#onestop` channel, invite the bot, set GitHub variable `ONESTOP_CHANNEL_ID` to its id (the old `RESERVATIONS_CHANNEL_ID` keeps working until then).
- [ ] (Optional) set `ONESTOP_INFO_TABS` only to override the default allowlist.
- [ ] Smoke test in `#onestop`: "what's the FH door code?", "zoom link for AYM?", "who's on lockup this week?", "where does IH Cabin John meet?" (info) and "is the MPR free saturday 5-7pm?" (reservation, unchanged).
- [ ] Archive `#reservations` once `#onestop` is confirmed live.

## Self-Review (against the spec)

- **Info Q&A in #onestop from reference tabs**: Tasks 1–3. ✓
- **Whole-corpus retrieval, allowlist, TTL cache, graceful tab skip**: Task 1. ✓
- **`info` intent as top-level router; reservation intents unchanged**: Tasks 2–3. ✓
- **No-invent answer + "I don't see that in OneStop" / graceful failure**: Task 2 (prompt + fallback), Task 3 (corpus-failure reply). ✓
- **Channel rename with env fallback; persona "OneStop (beta)"**: Tasks 3–4. ✓
- **Reuse RESERVATIONS_SHEET_ID; optional ONESTOP_INFO_TABS; gated on reservationsSheetId**: Task 5. ✓
- **No new dependencies**: all tasks use existing libs/clients. ✓
