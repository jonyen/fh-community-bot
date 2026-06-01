# Fold ffx-bball-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the basketball roll-call bot (`../ffx-bball-bot`) into this repo so one Slack app, one SAM stack, and one repo serve fh-maintenance, gender aliases, and bball features.

**Architecture:** ffx's reaction and `/ball` handlers are rewritten onto fh's `@slack/web-api` `WebClient` and routed through the existing `ReceiverFn → SQS → WorkerFn → dispatch` async pipeline. The twice-weekly roll-call post becomes a standalone EventBridge-scheduled Lambda (`PostMessageFn`). Runtime `/ball schedule` control is dropped; the schedule expression lives in the SAM template default.

**Tech Stack:** Node.js 22 (ESM), AWS SAM (Lambda + SQS + EventBridge Scheduler), `@slack/web-api`, vitest. Source for the fold lives at `../ffx-bball-bot` (sibling checkout).

**Design spec:** `docs/superpowers/specs/2026-06-01-fold-ffx-bball-bot-design.md`

---

## File map

| File | Responsibility | Action |
|------|----------------|--------|
| `src/lib/formatMessage.js` | Render/parse the roll-call message text (pure) | Create (port verbatim) |
| `src/lib/categorize.js` | Reactions → in/out/maybe roster (pure) | Create (port verbatim) |
| `src/services/weather.js` | NWS weather fetch (fetch-based) | Create (port, edit User-Agent) |
| `src/lib/ephemeral.js` | Post an ephemeral reply (postEphemeral → response_url fallback) | Create |
| `src/events/reaction.js` | Recategorize roster on reaction events, `chat.update` | Create |
| `src/events/ball.js` | `/ball` post/edit/delete/info via client + ephemeral | Create |
| `src/events/post.js` | Scheduled roll-call runner (DI, testable) | Create |
| `src/lambda/postMessage.js` | Scheduled Lambda entry; minimal env wiring | Create |
| `src/config.js` | Add bball env vars | Modify |
| `src/lambda/dispatch.js` | Route `/ball` + reaction events | Modify |
| `src/lambda/worker.js` | Thread new handlers from `getDeps` | Modify |
| `src/lambda/clients.js` | Wire ball + reaction handlers into DI | Modify |
| `template.yaml` | New params, worker env, PostMessage + Schedule resources | Modify |
| `.github/workflows/deploy.yml` | New parameter overrides | Modify |
| `.env.example` | New env vars | Modify |
| `README.md` | Document bball feature + manual migration | Modify |

Verbatim ports use `cp` + an import-path fix — this is exact, not a placeholder. Rewritten files have full code below.

---

## Task 1: Port pure modules + their tests

**Files:**
- Create: `src/lib/formatMessage.js`, `src/lib/categorize.js`, `src/services/weather.js`
- Test: `tests/lib/formatMessage.test.js`, `tests/lib/categorize.test.js`, `tests/services/weather.test.js`

- [ ] **Step 1: Copy the source modules from the sibling checkout**

```bash
cp ../ffx-bball-bot/src/shared/formatMessage.js src/lib/formatMessage.js
cp ../ffx-bball-bot/src/reactionHandler/categorize.js src/lib/categorize.js
cp ../ffx-bball-bot/src/postMessage/weather.js src/services/weather.js
```

These are pure (no Slack/AWS imports), so they port verbatim.

- [ ] **Step 2: Update the weather User-Agent to this repo**

In `src/services/weather.js`, change the `USER_AGENT` constant:

```javascript
const USER_AGENT = 'fh-community-bot (https://github.com/jonyen/fh-community-bot)';
```

- [ ] **Step 3: Copy the tests and fix their import paths**

```bash
cp ../ffx-bball-bot/test/formatMessage.test.js tests/lib/formatMessage.test.js
cp ../ffx-bball-bot/test/categorize.test.js   tests/lib/categorize.test.js
cp ../ffx-bball-bot/test/weather.test.js       tests/services/weather.test.js

# Repoint imports at the new locations (sibling test dir → fh nested tests/)
sed -i '' "s#\.\./src/shared/formatMessage.js#../../src/lib/formatMessage.js#g" tests/lib/formatMessage.test.js
sed -i '' "s#\.\./src/reactionHandler/categorize.js#../../src/lib/categorize.js#g" tests/lib/categorize.test.js
sed -i '' "s#\.\./src/postMessage/weather.js#../../src/services/weather.js#g" tests/services/weather.test.js
```

- [ ] **Step 4: Run the ported tests**

Run: `npx vitest run tests/lib/formatMessage.test.js tests/lib/categorize.test.js tests/services/weather.test.js`
Expected: PASS (all three suites green). If a weather test asserts the User-Agent string, update that assertion to the new value.

- [ ] **Step 5: Commit**

```bash
git add src/lib/formatMessage.js src/lib/categorize.js src/services/weather.js tests/lib tests/services/weather.test.js
git commit -m "feat(bball): port pure formatMessage/categorize/weather modules"
```

---

## Task 2: Ephemeral reply helper

**Files:**
- Create: `src/lib/ephemeral.js`
- Test: `tests/lib/ephemeral.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/ephemeral.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendEphemeral } from "../../src/lib/ephemeral.js";

function makeClient({ error = null } = {}) {
  return {
    chat: {
      postEphemeral: vi.fn().mockImplementation(async () => {
        if (error) throw error;
        return { ok: true };
      }),
    },
  };
}

describe("sendEphemeral", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;
  });

  it("prefers postEphemeral when client + channel + user are present", async () => {
    const client = makeClient();
    await sendEphemeral({ client, channel: "C1", user: "U1", responseUrl: "https://h/x", text: "hi" });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({ channel: "C1", user: "U1", text: "hi" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to response_url when postEphemeral throws", async () => {
    const client = makeClient({ error: Object.assign(new Error("e"), { data: { error: "channel_not_found" } }) });
    await sendEphemeral({ client, channel: "C1", user: "U1", responseUrl: "https://h/x", text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ response_type: "ephemeral", text: "hi" });
  });

  it("uses response_url directly when no client is given", async () => {
    await sendEphemeral({ responseUrl: "https://h/x", text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when response_url POST fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(sendEphemeral({ responseUrl: "https://h/x", text: "hi" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/ephemeral.test.js`
Expected: FAIL ("Failed to resolve import ../../src/lib/ephemeral.js").

- [ ] **Step 3: Implement**

```javascript
// src/lib/ephemeral.js
async function postResponseUrl(url, text) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
    if (!res.ok) console.warn(`[ephemeral] response_url POST returned ${res.status}`);
  } catch (err) {
    console.warn(`[ephemeral] response_url POST failed: ${err.message}`);
  }
}

export async function sendEphemeral({ client, channel, user, responseUrl, text }) {
  if (client && channel && user) {
    try {
      await client.chat.postEphemeral({ channel, user, text });
      return;
    } catch (err) {
      const code = err.data?.error || err.message;
      console.warn(`[ephemeral] postEphemeral failed (${code}); falling back to response_url`);
    }
  }
  await postResponseUrl(responseUrl, text);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/ephemeral.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ephemeral.js tests/lib/ephemeral.test.js
git commit -m "feat(bball): add sendEphemeral helper (postEphemeral + response_url fallback)"
```

---

## Task 3: Config — add bball env vars

**Files:**
- Modify: `src/config.js`
- Test: `tests/config.test.js`

- [ ] **Step 1: Write the failing test (append to existing suite)**

```javascript
// tests/config.test.js — add inside the existing describe block
it("exposes optional bball config with defaults", () => {
  const prev = { ...process.env };
  process.env.SLACK_BOT_USER_ID = "UBOT";
  process.env.BBALL_CHANNEL_IDS = "C1, C2";
  delete process.env.GIT_SHA;
  delete process.env.GITHUB_RUN_NUMBER;
  const cfg = loadConfig();
  expect(cfg.slackBotUserId).toBe("UBOT");
  expect(cfg.bballChannelIds).toEqual(["C1", "C2"]);
  expect(cfg.gitSha).toBe("unknown");
  expect(cfg.githubRunNumber).toBe("unknown");
  process.env = prev;
});

it("defaults bball config to empty/null when unset", () => {
  const prev = { ...process.env };
  delete process.env.SLACK_BOT_USER_ID;
  delete process.env.BBALL_CHANNEL_IDS;
  const cfg = loadConfig();
  expect(cfg.slackBotUserId).toBeNull();
  expect(cfg.bballChannelIds).toEqual([]);
  process.env = prev;
});
```

If `tests/config.test.js` does not already import `loadConfig` and set the fh-required env vars in a `beforeEach`, mirror the existing setup in that file so `loadConfig()` does not throw on the unrelated `REQUIRED` vars.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL (`cfg.slackBotUserId` is undefined).

- [ ] **Step 3: Implement — add a helper and four return fields**

In `src/config.js`, add this helper next to `parseChannelIds`:

```javascript
function parseOptionalChannelList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
```

Then add these fields to the object returned by `loadConfig()`:

```javascript
    slackBotUserId: process.env.SLACK_BOT_USER_ID || null,
    bballChannelIds: parseOptionalChannelList(process.env.BBALL_CHANNEL_IDS),
    gitSha: process.env.GIT_SHA || "unknown",
    githubRunNumber: process.env.GITHUB_RUN_NUMBER || "unknown",
```

Do NOT add these to the `REQUIRED` array — bball config is optional, so fh stays deployable without it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat(bball): add optional bball config (bot user id, channels, git sha)"
```

---

## Task 4: Reaction handler

**Files:**
- Create: `src/events/reaction.js`
- Test: `tests/events/reaction.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/events/reaction.test.js
import { describe, it, expect, vi } from "vitest";
import { createReactionHandler } from "../../src/events/reaction.js";

const BOT = "UBOT";
const ORIGINAL = "🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky";

function makeClient({ original = { ts: "100.1", user: BOT, text: ORIGINAL }, reactions = [], updateError = null } = {}) {
  return {
    conversations: { history: vi.fn().mockResolvedValue({ messages: original ? [original] : [] }) },
    reactions: { get: vi.fn().mockResolvedValue({ message: { reactions } }) },
    chat: {
      update: vi.fn().mockImplementation(async () => {
        if (updateError) throw updateError;
        return { ok: true };
      }),
    },
  };
}

const evt = (type = "reaction_added") => ({ type, item: { channel: "C1", ts: "100.1" } });

describe("createReactionHandler", () => {
  it("ignores non-reaction events", async () => {
    const client = makeClient();
    await createReactionHandler({ botUserId: BOT })({ event: { type: "message" }, client });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("ignores reactions on messages not authored by the bot", async () => {
    const client = makeClient({ original: { ts: "100.1", user: "USOMEONE", text: ORIGINAL } });
    await createReactionHandler({ botUserId: BOT })({ event: evt(), client });
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("recategorizes reactions and updates the roster, preserving header + weather", async () => {
    const client = makeClient({ reactions: [{ name: "basketball", users: ["U1", BOT] }] });
    await createReactionHandler({ botUserId: BOT })({ event: evt(), client });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.ts).toBe("100.1");
    expect(arg.text).toBe("🏀 today?\n\nIn (1): <@U1>\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky");
  });

  it("swallows cant_update_message / message_not_found", async () => {
    const client = makeClient({
      reactions: [{ name: "x", users: ["U1"] }],
      updateError: Object.assign(new Error("e"), { data: { error: "message_not_found" } }),
    });
    await expect(createReactionHandler({ botUserId: BOT })({ event: evt(), client })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/events/reaction.test.js`
Expected: FAIL (import not found).

- [ ] **Step 3: Implement**

```javascript
// src/events/reaction.js
import { categorize } from "../lib/categorize.js";
import { formatMessage, parseWeatherLine, parseHeader } from "../lib/formatMessage.js";

const REACTION_EVENTS = new Set(["reaction_added", "reaction_removed"]);

export function createReactionHandler({ botUserId }) {
  return async function handleReaction({ event, client }) {
    if (!event || !REACTION_EVENTS.has(event.type)) return;
    const { channel, ts } = event.item ?? {};
    if (!channel || !ts) return;

    const history = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const original = history.messages?.[0];
    if (!original || original.ts !== ts || original.user !== botUserId) return;

    const result = await client.reactions.get({ channel, timestamp: ts });
    const roster = categorize(result.message?.reactions ?? [], botUserId);

    const originalText = original.text ?? "";
    const newText = formatMessage(roster, parseWeatherLine(originalText), {
      headerText: parseHeader(originalText),
    });

    try {
      await client.chat.update({ channel, ts, text: newText });
    } catch (err) {
      const code = err.data?.error || err.message;
      if (code === "cant_update_message" || code === "message_not_found") return;
      throw err;
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/events/reaction.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/reaction.js tests/events/reaction.test.js
git commit -m "feat(bball): reaction handler on WebClient (roster recategorize + update)"
```

---

## Task 5: `/ball` slash handler

**Files:**
- Create: `src/events/ball.js`
- Test: `tests/events/ball.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/events/ball.test.js
import { describe, it, expect, vi } from "vitest";
import { createBallHandler } from "../../src/events/ball.js";

const BOT = "UBOT";

function makeClient(over = {}) {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: {
      history: vi.fn().mockResolvedValue({ messages: [{ ts: "9.9", user: BOT, text: "🏀 today?" }] }),
    },
    reactions: { get: vi.fn().mockResolvedValue({ message: { reactions: [] } }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: "Alice" } } }) },
    ...over,
  };
}

function envelope(text, over = {}) {
  return { type: "slash_command", command: "/ball", text, user_id: "U1", channel_id: "C1",
           response_url: "https://hooks.slack.com/x", ...over };
}

const noWeather = async () => null;

describe("createBallHandler", () => {
  it("with no text posts usage help ephemerally", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope(""), client });
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain("*Usage*");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("info reports git sha and run number", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT, gitSha: "abc123", runNumber: "42" })(
      { envelope: envelope("info"), client });
    const text = client.chat.postEphemeral.mock.calls[0][0].text;
    expect(text).toContain("abc123");
    expect(text).toContain("#42");
  });

  it("schedule subcommand replies that runtime control was removed", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("schedule pause"), client });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/deploy/i);
  });

  it("plain text posts a new roll-call attributed to the caller", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("tonight 7pm"), client });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.text).toBe("tonight 7pm (Alice)");
  });

  it("delete removes the most recent bot message", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("delete"), client });
    expect(client.chat.delete).toHaveBeenCalledWith({ channel: "C1", ts: "9.9" });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/Deleted/);
  });

  it("edit rewrites the most recent bot message header", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("edit 8pm instead"), client });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(client.chat.update.mock.calls[0][0].text).toBe("8pm instead (Alice)");
  });

  it("edit with no message gives usage", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("edit"), client });
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/Usage: `\/ball edit/);
  });

  it("delete with no prior message replies that none was found", async () => {
    const client = makeClient({ conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) } });
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("delete"), client });
    expect(client.chat.delete).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/No recent/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/events/ball.test.js`
Expected: FAIL (import not found).

- [ ] **Step 3: Implement**

```javascript
// src/events/ball.js
import { categorize } from "../lib/categorize.js";
import { formatMessage } from "../lib/formatMessage.js";
import { sendEphemeral } from "../lib/ephemeral.js";

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const WEATHER_TIMEOUT_MS = 2000;

const USAGE_HELP = [
  "*Usage*",
  "• `/ball <message>` — post a new bball message",
  "• `/ball edit <message>` — edit the most recent bball message",
  "• `/ball delete` — delete the most recent bball message",
  "• `/ball info` — show the deployed commit SHA and GitHub run number",
].join("\n");

async function recentBotMessage({ client, channel, botUserId }) {
  const history = await client.conversations.history({ channel, limit: 20 });
  return (history.messages ?? []).find((m) => m.user === botUserId);
}

async function resolveDisplayName({ client, userId }) {
  try {
    const info = await client.users.info({ user: userId });
    const profile = info?.user?.profile;
    return profile?.display_name?.trim() || profile?.real_name?.trim() || userId;
  } catch (err) {
    console.error("users.info fetch failed", err);
    return userId;
  }
}

async function safeWeather(fetchWeather) {
  try {
    return await fetchWeather({ timeoutMs: WEATHER_TIMEOUT_MS, target: "now" });
  } catch (err) {
    console.error("weather fetch failed", err);
    return null;
  }
}

export function createBallHandler({ fetchWeather, botUserId, gitSha = "unknown", runNumber = "unknown" }) {
  return async function handleBall({ envelope, client }) {
    const text = (envelope.text ?? "").trim();
    const channel = envelope.channel_id;
    const userId = envelope.user_id;
    const reply = (msg) =>
      sendEphemeral({ client, channel, user: userId, responseUrl: envelope.response_url, text: msg });

    if (!text) return reply(USAGE_HELP);

    if (/^info\s*$/i.test(text)) {
      return reply(`*bball bot*\n• Commit: \`${gitSha}\`\n• GitHub run: \`#${runNumber}\``);
    }

    if (/^schedule\b/i.test(text)) {
      return reply(
        "Schedule changes are managed via deploy now (the runtime `/ball schedule` control was removed)."
      );
    }

    if (!channel) return reply("Could not determine the current channel.");

    try {
      if (/^delete\s*$/i.test(text)) {
        const target = await recentBotMessage({ client, channel, botUserId });
        if (!target) return reply("No recent bball message to delete in this channel.");
        await client.chat.delete({ channel, ts: target.ts });
        return reply("🗑️ Deleted the most recent bball message.");
      }

      const editMatch = /^edit(\s+(.*))?$/i.exec(text);
      if (editMatch) {
        const editText = (editMatch[2] ?? "").trim();
        if (!editText) {
          return reply("Usage: `/ball edit <new message>` — e.g. `/ball edit tonight at 8pm instead`");
        }
        const target = await recentBotMessage({ client, channel, botUserId });
        if (!target) return reply("No recent bball message to edit in this channel.");
        const result = await client.reactions.get({ channel, timestamp: target.ts });
        const roster = categorize(result.message?.reactions ?? [], botUserId);
        const name = await resolveDisplayName({ client, userId });
        const weather = await safeWeather(fetchWeather);
        const body = formatMessage(roster, weather, { headerText: `${editText} (${name})` });
        await client.chat.update({ channel, ts: target.ts, text: body });
        return;
      }

      // Default: post a new roll-call.
      const name = await resolveDisplayName({ client, userId });
      const weather = await safeWeather(fetchWeather);
      const body = formatMessage(EMPTY_ROSTER, weather, { headerText: `${text} (${name})` });
      await client.chat.postMessage({ channel, text: body });
    } catch (err) {
      console.error("/ball action failed", err);
      return reply(`Sorry, that failed: ${err.data?.error || err.message}`);
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/events/ball.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/ball.js tests/events/ball.test.js
git commit -m "feat(bball): /ball post/edit/delete/info handler on WebClient"
```

---

## Task 6: Scheduled roll-call runner

**Files:**
- Create: `src/events/post.js`
- Test: `tests/events/post.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/events/post.test.js
import { describe, it, expect, vi } from "vitest";
import { createPostMessageRunner } from "../../src/events/post.js";

function makeClient(postImpl) {
  return {
    chat: { postMessage: vi.fn().mockImplementation(postImpl ?? (async () => ({ ok: true }))) },
    conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) },
  };
}

describe("createPostMessageRunner", () => {
  it("posts the roll-call to every channel with live weather", async () => {
    const client = makeClient();
    const fetchWeather = vi.fn().mockResolvedValue({ icon: "☀️", tempF: 70, description: "Clear" });
    const run = createPostMessageRunner({ client, fetchWeather, channels: ["C1", "C2"], botUserId: "UBOT", retryDelayMs: 0 });
    await run();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text).toContain("🏀 today?");
    expect(text).toContain("70°F");
  });

  it("retries weather up to 3 times then falls back to cached line", async () => {
    const fetchWeather = vi.fn().mockResolvedValue(null);
    const client = makeClient();
    client.conversations.history.mockResolvedValue({
      messages: [{ user: "UBOT", text: "🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 60°F, Clear" }],
    });
    const run = createPostMessageRunner({ client, fetchWeather, channels: ["C1"], botUserId: "UBOT", retryDelayMs: 0 });
    await run();
    expect(fetchWeather).toHaveBeenCalledTimes(3);
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("(cached)");
  });

  it("throws when every channel post fails", async () => {
    const client = makeClient(async () => { throw new Error("slack down"); });
    const fetchWeather = vi.fn().mockResolvedValue(null);
    const run = createPostMessageRunner({ client, fetchWeather, channels: ["C1"], botUserId: "UBOT", retryDelayMs: 0 });
    await expect(run()).rejects.toThrow("slack down");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/events/post.test.js`
Expected: FAIL (import not found).

- [ ] **Step 3: Implement**

```javascript
// src/events/post.js
import { formatMessage, parseWeatherLine } from "../lib/formatMessage.js";

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const WEATHER_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export function createPostMessageRunner({ client, fetchWeather, channels, botUserId, retryDelayMs = DEFAULT_RETRY_DELAY_MS }) {
  async function fetchWeatherWithRetry() {
    for (let attempt = 1; attempt <= WEATHER_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await fetchWeather();
        if (result) return result;
      } catch (err) {
        console.error(`weather fetch attempt ${attempt} failed`, err);
      }
      if (attempt < WEATHER_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return null;
  }

  async function loadCachedWeatherLine() {
    for (const channel of channels) {
      try {
        const history = await client.conversations.history({ channel, limit: 20 });
        const target = (history.messages ?? []).find((m) => m.user === botUserId);
        const line = parseWeatherLine(target?.text ?? "");
        if (line) return `${line} (cached)`;
      } catch (err) {
        console.error("cached-weather lookup failed", channel, err);
      }
    }
    return null;
  }

  return async function run() {
    let weather = await fetchWeatherWithRetry();
    if (!weather && botUserId) {
      weather = await loadCachedWeatherLine();
      if (weather) console.warn("weather fetch failed; using cached line from prior post");
    }

    const text = formatMessage(EMPTY_ROSTER, weather);
    const results = await Promise.allSettled(
      channels.map((channel) => client.chat.postMessage({ channel, text }))
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === channels.length && channels.length > 0) {
      throw failures[0].reason;
    }
    return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  };
}
```

> Note: ffx DM'd a failure user on partial failure. That is deliberately dropped — partial failures surface in Lambda logs/error metrics. Revisit only if operational need arises (YAGNI).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/events/post.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/post.js tests/events/post.test.js
git commit -m "feat(bball): scheduled roll-call runner (weather retry + cached fallback)"
```

---

## Task 7: PostMessage Lambda entry

**Files:**
- Create: `src/lambda/postMessage.js`
- Test: `tests/lambda/postMessage.test.js`

This entry reads its own env directly (like `receiver.js`) and does NOT call `loadConfig()` — the scheduled post needs none of the Google/Groq vars that `loadConfig` requires.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lambda/postMessage.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn().mockResolvedValue(["ok"]);
const createPostMessageRunner = vi.fn(() => runMock);

vi.mock("../../src/events/post.js", () => ({ createPostMessageRunner }));
vi.mock("@slack/web-api", () => ({ WebClient: vi.fn(function () { this.tag = "client"; }) }));

describe("postMessage lambda handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_BOT_USER_ID = "UBOT";
    process.env.BBALL_CHANNEL_IDS = "C1,C2";
  });

  it("builds a runner from env and invokes it", async () => {
    const { handler, _resetForTests } = await import("../../src/lambda/postMessage.js");
    _resetForTests();
    await handler();
    expect(createPostMessageRunner).toHaveBeenCalledTimes(1);
    const args = createPostMessageRunner.mock.calls[0][0];
    expect(args.channels).toEqual(["C1", "C2"]);
    expect(args.botUserId).toBe("UBOT");
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lambda/postMessage.test.js`
Expected: FAIL (import not found).

- [ ] **Step 3: Implement**

```javascript
// src/lambda/postMessage.js
import { WebClient } from "@slack/web-api";
import { fetchWeather } from "../services/weather.js";
import { createPostMessageRunner } from "../events/post.js";

let cachedRun;

function parseChannels(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getRun() {
  if (!cachedRun) {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    cachedRun = createPostMessageRunner({
      client,
      fetchWeather,
      channels: parseChannels(process.env.BBALL_CHANNEL_IDS),
      botUserId: process.env.SLACK_BOT_USER_ID,
    });
  }
  return cachedRun;
}

export async function handler() {
  return getRun()();
}

export function _resetForTests() {
  cachedRun = undefined;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lambda/postMessage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/postMessage.js tests/lambda/postMessage.test.js
git commit -m "feat(bball): scheduled PostMessage Lambda entry point"
```

---

## Task 8: Dispatch routing for `/ball` + reactions

**Files:**
- Modify: `src/lambda/dispatch.js`
- Test: `tests/lambda/dispatch.test.js`

- [ ] **Step 1: Write the failing tests (append to existing suite)**

```javascript
// tests/lambda/dispatch.test.js — add inside the existing describe block
it("routes /ball slash envelope to ballHandler with the client", async () => {
  const ballHandler = vi.fn().mockResolvedValue();
  const client = makeClient();
  const envelope = { type: "slash_command", command: "/ball", text: "tonight 7pm", user_id: "U1", channel_id: "C1" };
  await dispatchSlackEvent({ slackEnvelope: envelope, handler: vi.fn(), ballHandler, client });
  expect(ballHandler).toHaveBeenCalledTimes(1);
  expect(ballHandler.mock.calls[0][0].envelope).toBe(envelope);
  expect(ballHandler.mock.calls[0][0].client).toBe(client);
});

it("does not route /ball when no ballHandler is provided", async () => {
  const handler = vi.fn();
  await dispatchSlackEvent({ slackEnvelope: { type: "slash_command", command: "/ball" }, handler, client: makeClient() });
  expect(handler).not.toHaveBeenCalled();
});

it("routes reaction_added to reactionHandler", async () => {
  const reactionHandler = vi.fn().mockResolvedValue();
  const client = makeClient();
  const event = { type: "reaction_added", item: { channel: "C1", ts: "9.9" }, user: "U1" };
  await dispatchSlackEvent({ slackEnvelope: { event }, handler: vi.fn(), reactionHandler, client });
  expect(reactionHandler).toHaveBeenCalledTimes(1);
  expect(reactionHandler.mock.calls[0][0].event).toBe(event);
  expect(reactionHandler.mock.calls[0][0].client).toBe(client);
});

it("routes reaction_removed to reactionHandler", async () => {
  const reactionHandler = vi.fn().mockResolvedValue();
  const event = { type: "reaction_removed", item: { channel: "C1", ts: "9.9" }, user: "U1" };
  await dispatchSlackEvent({ slackEnvelope: { event }, handler: vi.fn(), reactionHandler, client: makeClient() });
  expect(reactionHandler).toHaveBeenCalledTimes(1);
});

it("does not route reactions to the maintenance handler", async () => {
  const handler = vi.fn();
  const event = { type: "reaction_added", item: { channel: "C1", ts: "9.9" }, user: "U1" };
  await dispatchSlackEvent({ slackEnvelope: { event }, handler, client: makeClient() });
  expect(handler).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: FAIL (ball/reaction handlers never invoked).

- [ ] **Step 3: Implement — extend `dispatchSlackEvent`**

In `src/lambda/dispatch.js`, update the signature to accept the two new handlers:

```javascript
export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, ballHandler, reactionHandler, client }) {
```

Replace the existing `slash_command` block with:

```javascript
  if (slackEnvelope.type === "slash_command") {
    if (slashRefreshHandler && slackEnvelope.command === "/refresh-genders") {
      await slashRefreshHandler({ envelope: slackEnvelope, client });
    } else if (ballHandler && slackEnvelope.command === "/ball") {
      await ballHandler({ envelope: slackEnvelope, client });
    }
    return;
  }
```

Then, immediately after `const event = slackEnvelope.event; if (!event) return;`, add the reaction branch BEFORE the gender/message logic:

```javascript
  if (reactionHandler && (event.type === "reaction_added" || event.type === "reaction_removed")) {
    await reactionHandler({ event, client });
    return;
  }
```

- [ ] **Step 4: Run to verify all dispatch tests pass**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: PASS (new + all existing tests green — existing branches untouched).

- [ ] **Step 5: Commit**

```bash
git add src/lambda/dispatch.js tests/lambda/dispatch.test.js
git commit -m "feat(bball): route /ball and reaction events in dispatch"
```

---

## Task 9: Wire handlers into worker + clients

**Files:**
- Modify: `src/lambda/worker.js`, `src/lambda/clients.js`
- Test: `tests/lambda/worker.test.js`

- [ ] **Step 1: Update the worker test to assert the new deps are threaded**

Inspect `tests/lambda/worker.test.js`. It mocks `getDeps` / `dispatchSlackEvent`. Add an assertion that the object passed to `dispatchSlackEvent` includes `ballHandler` and `reactionHandler`. Concretely, where the test sets up the `getDeps` mock return value, add `ballHandler` and `reactionHandler` mock fns, and assert they are forwarded:

```javascript
// in the existing worker test, extend the getDeps mock return:
//   { client, handler, genderHandler, slashRefreshHandler, ballHandler, reactionHandler }
// then after invoking the worker handler:
const passed = dispatchSlackEvent.mock.calls[0][0];
expect(passed.ballHandler).toBe(ballHandler);
expect(passed.reactionHandler).toBe(reactionHandler);
```

Match the existing mocking style in that file (it already mocks `./clients.js` and `./dispatch.js`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lambda/worker.test.js`
Expected: FAIL (`passed.ballHandler` is undefined).

- [ ] **Step 3: Implement — thread through worker.js**

In `src/lambda/worker.js`, destructure and forward the new handlers:

```javascript
import { dispatchSlackEvent } from "./dispatch.js";
import { getDeps } from "./clients.js";

export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler, slashRefreshHandler, ballHandler, reactionHandler } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      genderHandler,
      slashRefreshHandler,
      ballHandler,
      reactionHandler,
      client,
    });
  }
}
```

- [ ] **Step 4: Implement — build the handlers in clients.js**

In `src/lambda/clients.js`, add imports near the other event imports:

```javascript
import { fetchWeather } from "../services/weather.js";
import { createBallHandler } from "../events/ball.js";
import { createReactionHandler } from "../events/reaction.js";
```

Before the `cached = { ... }` line, construct the handlers:

```javascript
  const ballHandler = createBallHandler({
    fetchWeather,
    botUserId: config.slackBotUserId,
    gitSha: config.gitSha,
    runNumber: config.githubRunNumber,
  });
  const reactionHandler = createReactionHandler({ botUserId: config.slackBotUserId });
```

Update the cached object:

```javascript
  cached = { client: slack, handler, genderHandler, slashRefreshHandler, ballHandler, reactionHandler };
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/lambda/worker.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lambda/worker.js src/lambda/clients.js tests/lambda/worker.test.js
git commit -m "feat(bball): wire ball + reaction handlers into worker and clients"
```

---

## Task 10: Guard test — receiver enqueues reaction events

No receiver code change is needed (reaction events satisfy `shouldEnqueueEvent` via `type !== "message"`, and `/ball` enqueues through the existing generic slash path). Add a regression guard so this stays true.

**Files:**
- Test: `tests/lambda/receiver.test.js`

- [ ] **Step 1: Add a test asserting a reaction_added event is enqueued**

Inspect `tests/lambda/receiver.test.js` for its existing pattern (it mocks `@aws-sdk/client-sqs` `SendMessageCommand` and a valid signature). Add a test that builds a signed JSON body `{ type: "event_callback", event: { type: "reaction_added", item: { channel: "C1", ts: "9.9" } } }` and asserts `SQSClient.send` was called once with that body. Reuse the file's existing signing/mocking helpers — do not invent new ones.

- [ ] **Step 2: Run to verify it passes immediately (no code change)**

Run: `npx vitest run tests/lambda/receiver.test.js`
Expected: PASS. If it FAILS, the receiver gate has drifted from the design — re-read `src/lambda/receiver.js` `shouldEnqueueEvent` before changing anything.

- [ ] **Step 3: Commit**

```bash
git add tests/lambda/receiver.test.js
git commit -m "test(bball): guard that receiver enqueues reaction events"
```

---

## Task 11: Infrastructure — template.yaml

**Files:**
- Modify: `template.yaml`

- [ ] **Step 1: Add new parameters**

In the `Parameters:` block, add:

```yaml
  SlackBotUserId:     { Type: String, Default: "" }
  BballChannels:      { Type: String, Default: "" }
  ScheduleExpression: { Type: String, Default: "cron(0 8 ? * TUE,THU *)" }
  GitSha:             { Type: String, Default: "unknown" }
  GithubRunNumber:    { Type: String, Default: "unknown" }
```

- [ ] **Step 2: Add env vars to WorkerFn**

In `WorkerFn.Properties.Environment.Variables`, append:

```yaml
          SLACK_BOT_USER_ID:    !Ref SlackBotUserId
          BBALL_CHANNEL_IDS:    !Ref BballChannels
          GIT_SHA:              !Ref GitSha
          GITHUB_RUN_NUMBER:    !Ref GithubRunNumber
```

(No new IAM policies on WorkerFn — schedule control was dropped.)

- [ ] **Step 3: Add the scheduled-post resources**

Add to the `Resources:` block:

```yaml
  PostMessageFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/postMessage.handler
      MemorySize: 256
      Timeout: 30
      Environment:
        Variables:
          SLACK_BOT_TOKEN:   !Ref SlackBotToken
          SLACK_BOT_USER_ID: !Ref SlackBotUserId
          BBALL_CHANNEL_IDS: !Ref BballChannels

  PostMessageLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${PostMessageFn}
      RetentionInDays: 14

  PostScheduleRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: scheduler.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: InvokePostMessage
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: lambda:InvokeFunction
                Resource: !GetAtt PostMessageFn.Arn

  PostSchedule:
    Type: AWS::Scheduler::Schedule
    Properties:
      Name: fh-bball-post-schedule
      Description: Tue/Thu 8am ET basketball roll-call (DST-aware)
      ScheduleExpression: !Ref ScheduleExpression
      ScheduleExpressionTimezone: America/New_York
      FlexibleTimeWindow:
        Mode: "OFF"
      State: ENABLED
      Target:
        Arn: !GetAtt PostMessageFn.Arn
        RoleArn: !GetAtt PostScheduleRole.Arn
```

- [ ] **Step 4: Validate the template**

Run: `sam validate --lint`
Expected: `template.yaml is a valid SAM Template`. If `sam` is unavailable locally, run `npx --yes js-yaml template.yaml > /dev/null` to at least confirm valid YAML, and note that CI validates on deploy.

- [ ] **Step 5: Commit**

```bash
git add template.yaml
git commit -m "feat(bball): add scheduled PostMessage Lambda + EventBridge schedule to template"
```

---

## Task 12: Deploy workflow + env example

**Files:**
- Modify: `.github/workflows/deploy.yml`, `.env.example`

- [ ] **Step 1: Add parameter overrides to the deploy step**

In `.github/workflows/deploy.yml`, extend the `sam deploy ... --parameter-overrides` list with:

```yaml
              SlackBotUserId="${{ secrets.SLACK_BOT_USER_ID }}" \
              BballChannels="${{ vars.BBALL_CHANNEL_IDS }}" \
              GitSha="${{ github.sha }}" \
              GithubRunNumber="${{ github.run_number }}"
```

(Append these to the existing backslash-continued list; ensure the line before them ends with ` \` and the final line has no trailing backslash.)

- [ ] **Step 2: Add the new vars to `.env.example`**

```
SLACK_BOT_USER_ID=U0123456789
BBALL_CHANNEL_IDS=C03H7SUSUTZ
```

- [ ] **Step 3: Verify YAML still parses**

Run: `npx --yes js-yaml .github/workflows/deploy.yml > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml .env.example
git commit -m "ci(bball): pass bball params (bot user, channels, git sha) on deploy"
```

---

## Task 13: Docs + full test gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the bball feature and migration**

Add a "Basketball roll-call" section to `README.md` covering:
- What it does: twice-weekly auto-post (Tue/Thu 8am ET via `PostSchedule`), RSVP via reactions (🏀/✅/👍 = In, ❌/👎 = Out, anything else = Maybe), `/ball` post/edit/delete/info.
- New env vars: `SLACK_BOT_USER_ID`, `BBALL_CHANNEL_IDS`.
- Schedule changes are made by editing the `ScheduleExpression` parameter default in `template.yaml` and redeploying (no runtime `/ball schedule`).
- A "Migration from ffx-bball-bot" subsection linking to `docs/superpowers/specs/2026-06-01-fold-ffx-bball-bot-design.md` and listing the manual cutover steps from that spec's Migration section (Slack app event subs + `/ball` command + scopes; copy live `ScheduleExpression`; delete the old `ffx-bball-bot` stack to stop double-posting; archive the ffx repo).

- [ ] **Step 2: Run the full test suite (pre-deploy gate)**

Run: `npm test`
Expected: PASS — every suite green, including the existing fh maintenance/gender tests (untouched paths must not regress).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(bball): document roll-call feature and ffx migration"
```

---

## Manual cutover (operator, after merge + deploy — NOT code)

These are console actions, flagged in the spec's Migration section. Do them in order; step 2 includes a destructive delete.

1. **Slack app (keep fh's app):** add `reaction_added` + `reaction_removed` event subscriptions; add the `/ball` slash command pointing at the fh `ReceiverFn` Function URL; union ffx's OAuth scopes (`reactions:read`, `users:read`, `channels:history` — verify against the ffx app first); reinstall if scopes changed.
2. **Schedule cutover:** read the live `ScheduleExpression` from the old `ffx-bball-bot` schedule, set it as `ScheduleExpression` in this deploy, deploy, confirm the fh post fires, then **delete/disable the old `ffx-bball-bot` CloudFormation stack** so the roll-call does not double-post. ⚠️ Destructive.
3. **Repo:** archive the `ffx-bball-bot` GitHub repo; optionally remove the local `../ffx-bball-bot` checkout.

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — pure modules (T1), ephemeral pattern (T2), config (T3), reaction handler (T4), `/ball` (T5), scheduled runner + entry (T6–T7), dispatch routing (T8), worker/clients wiring (T9), receiver guard (T10), template (T11), deploy + env (T12), docs/migration (T13). `scheduleParser.js`, `scheduler.js`, and `@aws-sdk/client-scheduler` are intentionally absent (schedule control dropped). No new npm dependency.
- **Type/signature consistency:** `createBallHandler({ fetchWeather, botUserId, gitSha, runNumber })` → `({ envelope, client })`; `createReactionHandler({ botUserId })` → `({ event, client })`; `createPostMessageRunner({ client, fetchWeather, channels, botUserId, retryDelayMs })` → `run()`. dispatch passes `client` per-call (matches existing slashRefresh/mention/gender convention). clients.js bakes `fetchWeather`/`botUserId` at construction. Consistent across T4/T5/T6/T8/T9.
- **Reaction `client` source:** handler gets `client` from dispatch per-call (not via DI) — consistent with how `slashRefreshHandler` receives it.
