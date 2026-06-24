# Ambient Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the bot handle reservations from plain messages in a configured `#reservations` channel (no `@mention`), understanding intent with Groq, acting when complete, asking a threaded follow-up when info is missing, and staying silent on chatter.

**Architecture:** A configured `RESERVATIONS_CHANNEL_ID` makes the receiver enqueue every non-bot message in that channel; dispatch routes those to a new `reservationHandler.handleChannelMessage`, which classifies via Groq (intent now includes `none`), reuses the existing reply/list/broadcast paths, and asks for missing slots. Mentions and slash commands are unchanged.

**Tech Stack:** Node 22 ESM, Groq via `parseReservationRequest`, Vitest, AWS SAM.

## Global Constraints

- **Runtime:** Node 22 ESM (`"type": "module"`). No new dependencies.
- **Persona:** reservation replies post as `username: "Reservations (beta)"`, `icon_emoji: ":calendar:"` (constants in `src/events/reservations.js`).
- **Silent on non-reservation:** in the ambient channel, a `none` intent or a `null` parse produces NO reply. (Unlike slash, which prompts on null.)
- **Replies** post in-channel, threaded under the triggering message (`thread_ts = event.thread_ts || event.ts`); `reserve` success broadcasts to the channel mentioning the requester.
- **Required slots:** `reserve` & `check` need room + date + start + end; `list` needs none.
- **Feature gate:** ambient handling only when `RESERVATIONS_CHANNEL_ID` is set.
- **Tests:** Vitest, deps mocked, no real I/O. Run one file `npx vitest run <path>`; full suite `npm test`.
- **Spec:** `docs/superpowers/specs/2026-06-24-ambient-reservations-design.md`.

---

## File Structure

- **Modify** `src/services/groq.js` — add `none` to the reservation-intent prompt. (+ test)
- **Create** `src/lib/reservation-intent.js` — pure helpers `isIgnorableChatter`, `missingSlots`, `followUpText`. (+ test)
- **Modify** `src/events/reservations.js` — add `handleChannelMessage`. (+ test)
- **Modify** `src/lambda/dispatch.js` + `src/lambda/worker.js` — route channel messages. (+ dispatch test)
- **Modify** `src/lambda/receiver.js`, `src/config.js`, `src/lambda/clients.js`, `template.yaml`, `.github/workflows/deploy.yml` — wire `RESERVATIONS_CHANNEL_ID`. (+ config/receiver tests)

---

### Task 1: Groq classifies non-reservation messages as `none`

**Files:**
- Modify: `src/services/groq.js`
- Test: `tests/services/groq.test.js`

**Interfaces:**
- Produces: `parseReservationRequest(text, referenceDateIso)` may now return `{ intent: "none", ... }` for a non-reservation message (the handler treats `none` as "ignore"). Still returns `null` only on parse/API failure.

- [ ] **Step 1: Write the failing test** (append to `tests/services/groq.test.js`, inside the existing `parseReservationRequest` describe or a sibling)

```javascript
  it("passes through a 'none' intent for non-reservation chatter", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"none","target":null,"date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("lol that meeting was wild", "2026-06-24T12:00:00Z");
    expect(out.intent).toBe("none");
  });
```

- [ ] **Step 2: Run it to verify it passes structurally but the prompt lacks `none`**

Run: `npx vitest run tests/services/groq.test.js`
Expected: PASS (the parser already passes JSON through). This test pins the contract; Step 3 makes the model actually emit `none` by updating the prompt.

- [ ] **Step 3: Update the prompt in `src/services/groq.js`**

Replace `SYSTEM_PROMPT_RESERVATION` with:

```javascript
const SYSTEM_PROMPT_RESERVATION = `You convert a community member's reservation message into JSON. The reference date is provided. Output ONLY a JSON object with keys: intent ("check" | "list" | "reserve" | "none"), target (the room or resource name as written, or null), date (YYYY-MM-DD or null), startTime (e.g. "7:00 PM" or null), endTime (or null), what (short purpose or null), who (group/person or null). Use intent "none" when the message is not about reserving, checking, or listing reservations (e.g. greetings, thanks, off-topic chat). Resolve relative dates ("friday", "next week") against the reference date. Output no prose, only JSON.`;
```

- [ ] **Step 4: Run the groq test file**

Run: `npx vitest run tests/services/groq.test.js`
Expected: PASS (existing parse tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/services/groq.js tests/services/groq.test.js
git commit -m "feat(reservations): groq classifies non-reservation messages as 'none'"
```

---

### Task 2: Pure intent helpers

**Files:**
- Create: `src/lib/reservation-intent.js`
- Test: `tests/lib/reservation-intent.test.js`

**Interfaces:**
- Produces:
  - `isIgnorableChatter(text): boolean` — true for empty/greeting/ack messages that shouldn't reach the LLM.
  - `missingSlots(parsed): string[]` — for `reserve`/`check`, the missing required slots as labels from `["room","date","time"]` (start OR end missing → `"time"`); `[]` for `list`/`none`/null.
  - `followUpText(missing): string` — a friendly one-line ask listing only the missing labels.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/reservation-intent.test.js
import { describe, it, expect } from "vitest";
import { isIgnorableChatter, missingSlots, followUpText } from "../../src/lib/reservation-intent.js";

describe("isIgnorableChatter", () => {
  it("ignores greetings, acks, and empties", () => {
    for (const t of ["", "  ", "hi", "hello", "thanks", "ty", "lol", "ok", "👍"]) {
      expect(isIgnorableChatter(t)).toBe(true);
    }
  });
  it("does not ignore real requests", () => {
    expect(isIgnorableChatter("is the MPR free friday 7-10pm?")).toBe(false);
    expect(isIgnorableChatter("reserve the childcare room saturday")).toBe(false);
  });
});

describe("missingSlots", () => {
  it("reserve needs room, date, time", () => {
    expect(missingSlots({ intent: "reserve", target: null, date: null, startTime: null, endTime: null }))
      .toEqual(["room", "date", "time"]);
  });
  it("reports only what's missing", () => {
    expect(missingSlots({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: null }))
      .toEqual(["time"]);
  });
  it("check has the same requirements", () => {
    expect(missingSlots({ intent: "check", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM" }))
      .toEqual([]);
  });
  it("list and none require nothing", () => {
    expect(missingSlots({ intent: "list" })).toEqual([]);
    expect(missingSlots({ intent: "none" })).toEqual([]);
    expect(missingSlots(null)).toEqual([]);
  });
});

describe("followUpText", () => {
  it("asks for a single missing field", () => {
    expect(followUpText(["room"]).toLowerCase()).toContain("which room");
  });
  it("joins multiple asks naturally", () => {
    const t = followUpText(["room", "date", "time"]).toLowerCase();
    expect(t).toContain("which room");
    expect(t).toContain("what date");
    expect(t).toContain("what time");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/reservation-intent.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// src/lib/reservation-intent.js
const JUNK = [
  /^$/,
  /^(hi|hello|hey|yo|sup|hola|howdy|morning|gm)$/,
  /^(ok|okay|yes|no|yep|nope|sure|k)$/,
  /^(thanks|thank you|thx|ty|tysm|np)$/,
  /^(lol|lmao|haha|heh|hmm|wow|nice|cool|great|awesome)$/,
  /^[\p{Emoji}\s]+$/u,
];

export function isIgnorableChatter(text) {
  const t = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s\p{Emoji}]/gu, "").trim();
  if (!t) return true;
  return JUNK.some((re) => re.test(t));
}

const LABELS = { room: "which room", date: "what date", time: "what time" };

export function missingSlots(parsed) {
  if (!parsed || (parsed.intent !== "reserve" && parsed.intent !== "check")) return [];
  const missing = [];
  if (!parsed.target) missing.push("room");
  if (!parsed.date) missing.push("date");
  if (!parsed.startTime || !parsed.endTime) missing.push("time");
  return missing;
}

export function followUpText(missing) {
  const asks = missing.map((m) => LABELS[m]).filter(Boolean);
  let joined;
  if (asks.length <= 1) joined = asks[0] || "a few details";
  else joined = asks.slice(0, -1).join(", ") + " and " + asks[asks.length - 1];
  return `Happy to help with that — ${joined}?`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/reservation-intent.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-intent.js tests/lib/reservation-intent.test.js
git commit -m "feat(reservations): pure helpers for ambient intent (chatter, missing slots, follow-up)"
```

---

### Task 3: `handleChannelMessage`

**Files:**
- Modify: `src/events/reservations.js`
- Test: `tests/events/reservations.test.js`

**Interfaces:**
- Consumes: `isIgnorableChatter`, `missingSlots`, `followUpText` (Task 2); existing `replyForParsed`, `replyForList`, `BOT_USERNAME`, `BOT_ICON_EMOJI`; `groqService.parseReservationRequest`; `now`.
- Produces: `createReservationHandler` returns an additional method `handleChannelMessage({ event, client })`.

Behavior: ignore bot/edit messages and junk; if threaded, read `client.conversations.replies` and combine non-bot message texts; Groq parse; `none`/`null` → no reply; `list` → `replyForList`; `reserve`/`check` with missing slots → threaded follow-up; otherwise act via `replyForParsed` (`reserve` broadcasts). Replies post in-channel threaded under the message.

- [ ] **Step 1: Write the failing test** (append to `tests/events/reservations.test.js`)

```javascript
describe("ReservationHandler.handleChannelMessage", () => {
  let reservationsService, groqService, client, handler;
  beforeEach(() => {
    reservationsService = {
      classifyTarget: vi.fn(),
      checkRoom: vi.fn(),
      makeRoomReservation: vi.fn(),
      listReservations: vi.fn(),
    };
    groqService = { parseReservationRequest: vi.fn() };
    client = {
      chat: { postMessage: vi.fn().mockResolvedValue({}), postEphemeral: vi.fn() },
      conversations: { replies: vi.fn() },
    };
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-24T12:00:00Z") });
  });
  const msg = (over = {}) => ({ type: "message", channel: "Cres", user: "U1", ts: "100.1", text: "", ...over });

  it("stays silent on non-reservation chatter (intent none)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "none" });
    await handler.handleChannelMessage({ event: msg({ text: "that was a fun service" }), client });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("never calls the LLM or replies for obvious chatter", async () => {
    await handler.handleChannelMessage({ event: msg({ text: "thanks!" }), client });
    expect(groqService.parseReservationRequest).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("ignores bot messages", async () => {
    await handler.handleChannelMessage({ event: msg({ bot_id: "B1", text: "reserve MPR" }), client });
    expect(groqService.parseReservationRequest).not.toHaveBeenCalled();
  });

  it("asks a threaded follow-up when a reservation is missing slots", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: null, startTime: null, endTime: null });
    await handler.handleChannelMessage({ event: msg({ text: "can I book the MPR?" }), client });
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "Cres", thread_ts: "100.1", username: "Reservations (beta)" });
    expect(arg.text.toLowerCase()).toContain("what date");
    expect(arg.text.toLowerCase()).toContain("what time");
  });

  it("books and broadcasts a complete reserve request", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.makeRoomReservation.mockResolvedValue({ ok: true, mirrored: true });
    await handler.handleChannelMessage({ event: msg({ text: "book FH MPR friday 7-10pm for practice" }), client });
    // broadcast (channel post) names the requester
    const posts = client.chat.postMessage.mock.calls.map((c) => c[0]);
    expect(posts.some((p) => p.channel === "Cres" && /<@U1>/.test(p.text) && /FH MPR/.test(p.text))).toBe(true);
  });

  it("combines a threaded reply with the original request", async () => {
    client.conversations.replies.mockResolvedValue({ messages: [
      { user: "U1", text: "can I book the MPR friday?" },
      { user: "U1", text: "7 to 10 pm for practice" },
    ] });
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.makeRoomReservation.mockResolvedValue({ ok: true });
    await handler.handleChannelMessage({ event: msg({ thread_ts: "100.1", text: "7 to 10 pm for practice" }), client });
    expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "Cres", ts: "100.1" });
    const combined = groqService.parseReservationRequest.mock.calls[0][0];
    expect(combined).toContain("can I book the MPR friday?");
    expect(combined).toContain("7 to 10 pm for practice");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: FAIL — `handler.handleChannelMessage is not a function`.

- [ ] **Step 3: Implement in `src/events/reservations.js`**

Add the import at the top of the file:

```javascript
import { isIgnorableChatter, missingSlots, followUpText } from "../lib/reservation-intent.js";
```

Add `handleChannelMessage` inside `createReservationHandler`, before the `return { ... }`:

```javascript
  async function handleChannelMessage({ event, client }) {
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== "file_share") return;
    const baseText = event.text || "";
    if (isIgnorableChatter(baseText)) return;

    let text = baseText;
    if (event.thread_ts) {
      try {
        const res = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts });
        const human = (res.messages || []).filter((m) => !m.bot_id).map((m) => m.text || "").filter(Boolean);
        if (human.length) text = human.join("\n");
      } catch {
        // fall back to the single message's text
      }
    }

    const parsed = await groqService.parseReservationRequest(text, now().toISOString());
    if (!parsed || parsed.intent === "none") return; // silent on non-reservations

    const thread_ts = event.thread_ts || event.ts;
    const say = (msg) => client.chat.postMessage({ channel: event.channel, thread_ts, ...msg });

    if (parsed.intent === "list") {
      await replyForList(parsed, say);
      return;
    }

    const missing = missingSlots(parsed);
    if (missing.length) {
      await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI, text: followUpText(missing) });
      return;
    }

    const opts =
      parsed.intent === "reserve"
        ? { broadcast: (msg) => client.chat.postMessage({ channel: event.channel, ...msg }), requester: event.user }
        : {};
    await replyForParsed(parsed, say, thread_ts, opts);
  }
```

Update the return statement:

```javascript
  return { handleMention, handleSlash, handleChannelMessage };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/events/reservations.test.js`
Expected: PASS (existing handler tests still green). Then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/events/reservations.js tests/events/reservations.test.js
git commit -m "feat(reservations): handleChannelMessage for ambient channel requests"
```

---

### Task 4: Route channel messages in dispatch + worker

**Files:**
- Modify: `src/lambda/dispatch.js`
- Modify: `src/lambda/worker.js`
- Test: `tests/lambda/dispatch.test.js`

**Interfaces:**
- Consumes: `reservationHandler.handleChannelMessage` (Task 3); a new `reservationsChannelId` value threaded from `getDeps()` (Task 5).
- Produces: `dispatchSlackEvent` accepts `reservationsChannelId`; a non-bot `message` in that channel routes to `handleChannelMessage` before the gender/mention/maintenance branches.

- [ ] **Step 1: Write the failing test** (append to `tests/lambda/dispatch.test.js`)

```javascript
describe("dispatchSlackEvent ambient reservations channel", () => {
  function client() { return { chat: { postMessage: vi.fn().mockResolvedValue({}) } }; }

  it("routes a plain message in the reservations channel to handleChannelMessage", async () => {
    const reservationHandler = { handleChannelMessage: vi.fn().mockResolvedValue(), handleMention: vi.fn(), handleSlash: vi.fn() };
    const maintenance = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "Cres", user: "U1", ts: "1.1", text: "book the MPR friday" } },
      handler: maintenance, reservationHandler, reservationsChannelId: "Cres", client: client(),
    });
    expect(reservationHandler.handleChannelMessage).toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
  });

  it("ignores bot messages in the reservations channel", async () => {
    const reservationHandler = { handleChannelMessage: vi.fn(), handleMention: vi.fn(), handleSlash: vi.fn() };
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "Cres", bot_id: "B1", ts: "1.1", text: "x" } },
      reservationHandler, reservationsChannelId: "Cres", client: client(),
    });
    expect(reservationHandler.handleChannelMessage).not.toHaveBeenCalled();
  });

  it("does not ambient-route a message in another channel", async () => {
    const reservationHandler = { handleChannelMessage: vi.fn(), handleMention: vi.fn(), handleSlash: vi.fn() };
    const maintenance = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "Cother", user: "U1", thread_ts: "1.1", ts: "1.2", text: "the sink is leaking" } },
      handler: maintenance, reservationHandler, reservationsChannelId: "Cres", client: client(),
    });
    expect(reservationHandler.handleChannelMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: FAIL — ambient routing not implemented.

- [ ] **Step 3: Edit `src/lambda/dispatch.js`**

Add `reservationsChannelId` to the destructured params and insert the ambient branch immediately after `if (!event) return;` (before the gender branch):

```javascript
export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, reservationHandler, reservationsChannelId, client }) {
```

```javascript
  const event = slackEnvelope.event;
  if (!event) return;

  if (
    reservationHandler &&
    reservationsChannelId &&
    event.type === "message" &&
    !event.bot_id &&
    event.channel === reservationsChannelId
  ) {
    await reservationHandler.handleChannelMessage({ event, client });
    return;
  }
```

(Keep the existing slash block above `const event` and the gender/mention/maintenance branches below, unchanged.)

- [ ] **Step 4: Edit `src/lambda/worker.js`**

Destructure and pass `reservationsChannelId`:

```javascript
export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler, slashRefreshHandler, reservationHandler, reservationsChannelId } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      genderHandler,
      slashRefreshHandler,
      reservationHandler,
      reservationsChannelId,
      client,
    });
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/lambda/dispatch.test.js` → PASS. Then `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/lambda/dispatch.js src/lambda/worker.js tests/lambda/dispatch.test.js
git commit -m "feat(reservations): route ambient channel messages through dispatch"
```

---

### Task 5: Wire `RESERVATIONS_CHANNEL_ID` (receiver, config, clients, template, deploy)

**Files:**
- Modify: `src/lambda/receiver.js`, `src/config.js`, `src/lambda/clients.js`, `template.yaml`, `.github/workflows/deploy.yml`
- Test: `tests/config.test.js`, `tests/lambda/receiver.test.js`

**Interfaces:**
- Consumes: nothing new. Produces: `config.reservationsChannelId`; `getDeps()` returns `reservationsChannelId`; the receiver enqueues non-bot messages in that channel; both Lambdas receive `RESERVATIONS_CHANNEL_ID`.

- [ ] **Step 1: Extend `tests/config.test.js`**

```javascript
  it("loads reservationsChannelId from env (null when unset)", () => {
    delete process.env.RESERVATIONS_CHANNEL_ID;
    expect(loadConfig().reservationsChannelId).toBeNull();
    process.env.RESERVATIONS_CHANNEL_ID = "Cres";
    expect(loadConfig().reservationsChannelId).toBe("Cres");
  });
```

- [ ] **Step 2: Add a receiver test** (`tests/lambda/receiver.test.js` — add to the existing file)

First check the existing receiver test for how it invokes the handler / builds events; mirror that. Add:

```javascript
  it("enqueues a non-bot message in the reservations channel", async () => {
    process.env.RESERVATIONS_CHANNEL_ID = "Cres";
    const parsed = { event: { type: "message", channel: "Cres", user: "U1", ts: "1.1", text: "book the MPR" } };
    expect(shouldEnqueueEvent(parsed)).toBe(true);
  });

  it("does not enqueue a bot message in the reservations channel", async () => {
    process.env.RESERVATIONS_CHANNEL_ID = "Cres";
    const parsed = { event: { type: "message", channel: "Cres", bot_id: "B1", ts: "1.1", text: "x" } };
    expect(shouldEnqueueEvent(parsed)).toBe(false);
  });
```

If `shouldEnqueueEvent` is not currently exported from `receiver.js`, export it (`export function shouldEnqueueEvent(...)`) so the test can call it directly; this is a pure helper and safe to export.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/config.test.js tests/lambda/receiver.test.js`
Expected: FAIL — `reservationsChannelId` undefined; `shouldEnqueueEvent` not exported / channel rule missing.

- [ ] **Step 4: Edit `src/config.js`**

Add to the returned object (next to `reservationsSheetId`):

```javascript
    reservationsChannelId: process.env.RESERVATIONS_CHANNEL_ID || null,
```

- [ ] **Step 5: Edit `src/lambda/receiver.js`**

Export `shouldEnqueueEvent` and add the channel rule at the top of the `message` branch:

```javascript
export function shouldEnqueueEvent(parsed) {
  const event = parsed.event;
  if (!event) return false;
  if (event.type !== "message") return true;
  if (event.bot_id) {
    // never enqueue our own / other bots' messages
  } else if (process.env.RESERVATIONS_CHANNEL_ID && event.channel === process.env.RESERVATIONS_CHANNEL_ID) {
    return true; // ambient reservations channel: every human message
  }
  const text = event.text || "";
  if (matchesGenderEvent(text)) return true;
  if (/<@[A-Z0-9_]+>/.test(text)) return true;
  if (event.thread_ts) return true;
  return false;
}
```

- [ ] **Step 6: Edit `src/lambda/clients.js`**

Add `reservationsChannelId` to the cached object returned by `getDeps()` (find the `cached = { ... }` line and add the field):

```javascript
  cached = { client: slack, handler, genderHandler, slashRefreshHandler, reservationHandler, reservationsChannelId: config.reservationsChannelId };
```

- [ ] **Step 7: Edit `template.yaml`**

Add a parameter:

```yaml
  ReservationsChannelId: { Type: String, Default: "" }
```

Add the env var to BOTH functions. Under `ReceiverFn` → `Environment` → `Variables` (which currently has only `SLACK_SIGNING_SECRET` and `EVENT_QUEUE_URL`):

```yaml
          RESERVATIONS_CHANNEL_ID: !Ref ReservationsChannelId
```

And under `WorkerFn` → `Environment` → `Variables` (next to `RESERVATIONS_SHEET_ID`):

```yaml
          RESERVATIONS_CHANNEL_ID: !Ref ReservationsChannelId
```

- [ ] **Step 8: Edit `.github/workflows/deploy.yml`**

In the SAM deploy step's `env:` add:

```yaml
          RESERVATIONS_CHANNEL_ID: ${{ vars.RESERVATIONS_CHANNEL_ID }}
```

And in the `OPTIONAL_PARAMS` block (a small, space-free id — safe as a normal override):

```bash
          if [ -n "$RESERVATIONS_CHANNEL_ID" ]; then
            OPTIONAL_PARAMS+=("ReservationsChannelId=$RESERVATIONS_CHANNEL_ID")
          fi
```

- [ ] **Step 9: Run the suites**

Run: `npx vitest run tests/config.test.js tests/lambda/receiver.test.js` → PASS. Then `npm test` → all green.

- [ ] **Step 10: Commit**

```bash
git add src/config.js src/lambda/receiver.js src/lambda/clients.js template.yaml .github/workflows/deploy.yml tests/config.test.js tests/lambda/receiver.test.js
git commit -m "feat(reservations): wire RESERVATIONS_CHANNEL_ID (receiver, config, deploy)"
```

---

## Final verification

- [ ] `npm test` — every suite passes.
- [ ] Set the `RESERVATIONS_CHANNEL_ID` GitHub Actions variable to the `#reservations` channel id.
- [ ] Invite the bot to `#reservations` (it needs `channels:history` to read messages + `conversations.replies`; confirm the scope is present, same as the maintenance thread-reconstruction path).

## Self-Review (against the spec)

- **Ambient channel, no mention**: Task 4 dispatch routing + Task 5 receiver enqueue. ✓
- **Intent via Groq incl. `none` → silent**: Task 1 prompt + Task 3 `none`/null guard. ✓
- **Complete → act; incomplete → threaded follow-up**: Task 3 `missingSlots`/`followUpText`. ✓
- **list always answerable; reserve/check require room+date+start+end**: Task 2 `missingSlots`. ✓
- **reserve broadcasts; replies threaded in-channel**: Task 3 `say` thread_ts + broadcast opts. ✓
- **Thread re-parse via conversations.replies**: Task 3 thread context. ✓
- **Junk guard avoids LLM on chatter**: Task 2 `isIgnorableChatter` + Task 3 early return. ✓
- **Single channel, feature gated**: Task 4 `reservationsChannelId &&` + Task 5 config/env. ✓
- **Mentions & slash unchanged**: dispatch ambient branch is additive and channel-scoped; existing branches untouched. ✓
- **Both Lambdas get the env var**: Task 5 template (receiver + worker). ✓
