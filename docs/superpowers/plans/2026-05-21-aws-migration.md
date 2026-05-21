# AWS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Raspberry Pi pm2/Socket-Mode deployment with two AWS Lambda functions (HTTP receiver + SQS-driven worker) defined by an AWS SAM template and deployed via GitHub Actions.

**Architecture:** Slack posts events via the Events API to a public Lambda Function URL. The receiver verifies the Slack signing secret, enqueues the raw event JSON to SQS, and acks immediately. A worker Lambda consumes the queue, constructs Slack/Google/Groq clients, and dispatches each event to the unchanged `mention` handler. Source-of-truth state stays in Google Sheets; nothing is persisted in AWS.

**Tech Stack:** Node 20, `@slack/web-api`, `googleapis`, `openai` (Groq-compatible), `@aws-sdk/client-sqs`, AWS SAM, GitHub Actions OIDC, vitest.

**Design reference:** `docs/superpowers/specs/2026-05-21-aws-migration-design.md`

---

## File Plan

```
NEW   src/lambda/receiver.js             Lambda handler: verify Slack sig, enqueue to SQS
NEW   src/lambda/worker.js               Lambda handler: SQS-triggered dispatcher → mention handler
NEW   src/lambda/slack-signature.js      Pure HMAC verification helper (no deps)
NEW   src/lambda/clients.js              Module-scoped Slack/Sheets/Groq/dedup factories (cold-start cache)
NEW   src/lambda/dispatch.js             Pure function: SQS record → { event, say, client } → mentionHandler
NEW   template.yaml                       SAM template (Lambdas + SQS + DLQ + log groups + Function URL)
NEW   samconfig.toml                      Non-secret SAM defaults (region, stack name)
NEW   .github/workflows/deploy.yml        CI/CD: test + sam build + sam deploy via OIDC
NEW   tests/lambda/slack-signature.test.js
NEW   tests/lambda/receiver.test.js
NEW   tests/lambda/dispatch.test.js
NEW   tests/lambda/worker.test.js
NEW   docs/aws-bootstrap.md               Manual bootstrap runbook (IAM OIDC, `sam deploy --guided`, Slack reconfig)

MODIFY  src/config.js                    Drop SLACK_APP_TOKEN; add SLACK_SIGNING_SECRET, EVENT_QUEUE_URL
MODIFY  package.json                      Add @aws-sdk/client-sqs, @slack/web-api; drop pm2 script
MODIFY  .gitignore                        Add samconfig.local.toml, .aws-sam/
MODIFY  tests/config.test.js              Reflect new env-var set
MODIFY  README.md                         Replace Pi/Socket-Mode setup with AWS/Events-API setup

DELETE  src/app.js                        Socket Mode entry; no longer used
DELETE  ecosystem.config.cjs              pm2 config; no longer used
```

`src/events/mention.js`, `src/services/{sheets,groq,dedup}.js` are unchanged.

---

## Task 1: Repo hygiene — gitignore + dead files

**Files:**
- Modify: `.gitignore`
- Delete: `ecosystem.config.cjs`

- [ ] **Step 1: Update `.gitignore`**

Read the current file, then append:

```
samconfig.local.toml
.aws-sam/
```

Final `.gitignore` should be:

```
node_modules/
.env
samconfig.local.toml
.aws-sam/
```

- [ ] **Step 2: Delete `ecosystem.config.cjs`**

Run: `rm ecosystem.config.cjs`

- [ ] **Step 3: Verify**

Run: `git status`
Expected: `.gitignore` modified, `ecosystem.config.cjs` deleted.

- [ ] **Step 4: Commit**

```bash
git add .gitignore ecosystem.config.cjs
git commit -m "chore: drop pm2 ecosystem config, ignore SAM artifacts"
```

---

## Task 2: Update `config.js` for new env vars

**Files:**
- Modify: `src/config.js`
- Modify: `tests/config.test.js`

- [ ] **Step 1: Rewrite the failing test**

Replace the entire contents of `tests/config.test.js` with:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const VALID_ENV = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "sig-test",
    SLACK_CHANNEL_ID: "C123",
    GOOGLE_SHEET_ID: "sheet-id",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
    GROQ_API_KEY: "gsk_test-key",
  };

  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads all required env vars", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.slackSigningSecret).toBe("sig-test");
    expect(config.slackChannelId).toBe("C123");
    expect(config.googleSheetId).toBe("sheet-id");
    expect(config.googleClientId).toBe("test-client-id");
    expect(config.googleClientSecret).toBe("test-client-secret");
    expect(config.googleRefreshToken).toBe("test-refresh-token");
    expect(config.groqApiKey).toBe("gsk_test-key");
  });

  it("reads EVENT_QUEUE_URL when set", async () => {
    Object.assign(process.env, VALID_ENV, { EVENT_QUEUE_URL: "https://sqs.example/q" });
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.eventQueueUrl).toBe("https://sqs.example/q");
  });

  it("throws if a required var is missing", async () => {
    process.env = { ...originalEnv };
    delete process.env.SLACK_BOT_TOKEN;
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow("Missing required environment variable");
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `npm test -- tests/config.test.js`
Expected: failures (current `config.js` still requires `SLACK_APP_TOKEN`, doesn't expose `slackSigningSecret` or `eventQueueUrl`).

- [ ] **Step 3: Replace `src/config.js`**

```js
const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CHANNEL_ID",
  "GOOGLE_SHEET_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GROQ_API_KEY",
];

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    groqApiKey: process.env.GROQ_API_KEY,
    eventQueueUrl: process.env.EVENT_QUEUE_URL,
  };
}
```

Note: `EVENT_QUEUE_URL` is intentionally not in `REQUIRED` — only the receiver Lambda gets it. The worker reads no env vars through `eventQueueUrl`.

- [ ] **Step 4: Re-run test**

Run: `npm test -- tests/config.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat(config): swap SLACK_APP_TOKEN for SLACK_SIGNING_SECRET, add EVENT_QUEUE_URL"
```

---

## Task 3: Slack signature verifier (pure helper)

**Files:**
- Create: `src/lambda/slack-signature.js`
- Test:   `tests/lambda/slack-signature.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lambda/slack-signature.test.js`:

```js
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySlackSignature } from "../../src/lambda/slack-signature.js";

const SECRET = "test-signing-secret";

function sign(body, timestamp) {
  const base = `v0:${timestamp}:${body}`;
  return "v0=" + crypto.createHmac("sha256", SECRET).update(base).digest("hex");
}

describe("verifySlackSignature", () => {
  it("accepts a valid signature within the replay window", () => {
    const body = '{"type":"event_callback"}';
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = sign(body, ts);
    expect(verifySlackSignature({ secret: SECRET, body, timestamp: ts, signature: sig })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = sign("original", ts);
    expect(verifySlackSignature({ secret: SECRET, body: "tampered", timestamp: ts, signature: sig })).toBe(false);
  });

  it("rejects timestamps outside the 5-minute window", () => {
    const body = "{}";
    const old = (Math.floor(Date.now() / 1000) - 600).toString();
    const sig = sign(body, old);
    expect(verifySlackSignature({ secret: SECRET, body, timestamp: old, signature: sig })).toBe(false);
  });

  it("rejects missing inputs", () => {
    expect(verifySlackSignature({ secret: SECRET, body: "x", timestamp: "", signature: "" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lambda/slack-signature.test.js`
Expected: cannot resolve `../../src/lambda/slack-signature.js`.

- [ ] **Step 3: Implement**

Create `src/lambda/slack-signature.js`:

```js
import crypto from "node:crypto";

const REPLAY_WINDOW_SECONDS = 60 * 5;

export function verifySlackSignature({ secret, body, timestamp, signature }) {
  if (!secret || !body || !timestamp || !signature) return false;

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > REPLAY_WINDOW_SECONDS) return false;

  const base = `v0:${timestamp}:${body}`;
  const computed = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Re-run, expect pass**

Run: `npm test -- tests/lambda/slack-signature.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/slack-signature.js tests/lambda/slack-signature.test.js
git commit -m "feat(lambda): add Slack signing-secret verifier"
```

---

## Task 4: Receiver Lambda — handler

**Files:**
- Create: `src/lambda/receiver.js`
- Test:   `tests/lambda/receiver.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lambda/receiver.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const SECRET = "test-signing-secret";

function buildEvent({ body, timestamp, signature }) {
  return {
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
  };
}

function sign(body, timestamp) {
  const base = `v0:${timestamp}:${body}`;
  return "v0=" + crypto.createHmac("sha256", SECRET).update(base).digest("hex");
}

describe("receiver.handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.EVENT_QUEUE_URL = "https://sqs.example/q";
  });

  it("returns 401 on a bad signature", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body: "{}", timestamp: ts, signature: "v0=bad" }));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("responds to url_verification challenge without enqueuing", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc123");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enqueues event_callback bodies to SQS and acks 200", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hi" } });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.input.QueueUrl).toBe("https://sqs.example/q");
    expect(call.input.MessageBody).toBe(body);
  });

  it("handles base64-encoded bodies from Function URL", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const raw = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
    const body = Buffer.from(raw).toString("base64");
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler({
      body,
      isBase64Encoded: true,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(raw, ts),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input.MessageBody).toBe(raw);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lambda/receiver.test.js`
Expected: cannot resolve `../../src/lambda/receiver.js`.

- [ ] **Step 3: Implement**

Create `src/lambda/receiver.js`:

```js
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifySlackSignature } from "./slack-signature.js";

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

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.EVENT_QUEUE_URL,
      MessageBody: body,
    })
  );

  return { statusCode: 200, body: "" };
}
```

- [ ] **Step 4: Add SQS client dependency**

Run: `npm install @aws-sdk/client-sqs`

- [ ] **Step 5: Re-run, expect pass**

Run: `npm test -- tests/lambda/receiver.test.js`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add src/lambda/receiver.js tests/lambda/receiver.test.js package.json package-lock.json
git commit -m "feat(lambda): add Slack receiver Lambda (verify + enqueue)"
```

---

## Task 5: Dispatch — adapt SQS record into `{event, say, client}` shape

This is the pure logic that connects an SQS-delivered Slack event to the unchanged `mention` handler. Keeping it in its own module makes it testable without mocking AWS or Slack SDKs.

**Files:**
- Create: `src/lambda/dispatch.js`
- Test:   `tests/lambda/dispatch.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lambda/dispatch.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { dispatchSlackEvent } from "../../src/lambda/dispatch.js";

function makeClient() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
    reactions: { add: vi.fn().mockResolvedValue({}) },
    users: { info: vi.fn().mockResolvedValue({ user: { real_name: "Test" } }) },
  };
}

describe("dispatchSlackEvent", () => {
  it("invokes the handler with a say() bound to the event's channel", async () => {
    const handler = vi.fn().mockResolvedValue();
    const client = makeClient();
    const slackEvent = { type: "app_mention", channel: "C1", text: "hi", user: "U1", ts: "1" };

    await dispatchSlackEvent({
      slackEnvelope: { event: slackEvent },
      handler,
      client,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const args = handler.mock.calls[0][0];
    expect(args.event).toEqual(slackEvent);
    expect(args.client).toBe(client);
    expect(typeof args.say).toBe("function");

    await args.say({ text: "hello", thread_ts: "1" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "hello",
      thread_ts: "1",
    });
  });

  it("skips messages that are not thread replies", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "hi", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips bot messages and subtyped messages", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", bot_id: "B1" } },
      handler,
      client: makeClient(),
    });
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", subtype: "message_changed" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips thread messages that contain an @mention (handled by app_mention path)", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "<@U_BOT> hi", user: "U1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes thread replies (no @mention, not a bot) through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("always passes app_mention through", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lambda/dispatch.test.js`
Expected: cannot resolve module.

- [ ] **Step 3: Implement**

Create `src/lambda/dispatch.js`:

```js
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

export async function dispatchSlackEvent({ slackEnvelope, handler, client }) {
  const event = slackEnvelope.event;
  if (!event) return;
  if (shouldSkip(event)) return;

  const say = (msg) =>
    client.chat.postMessage({
      channel: event.channel,
      ...msg,
    });

  await handler({ event, say, client });
}
```

- [ ] **Step 4: Re-run, expect pass**

Run: `npm test -- tests/lambda/dispatch.test.js`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/dispatch.js tests/lambda/dispatch.test.js
git commit -m "feat(lambda): add SQS-event → mention-handler dispatcher"
```

---

## Task 6: Cold-start client factory

Lazy-build the Slack/Sheets/Groq/dedup/mention dependencies once per Lambda container.

**Files:**
- Create: `src/lambda/clients.js`

(No dedicated test file — wired up via the worker test in Task 7.)

- [ ] **Step 1: Implement**

Create `src/lambda/clients.js`:

```js
import { WebClient } from "@slack/web-api";
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createMentionHandler } from "../events/mention.js";

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
    channelId: config.slackChannelId,
    spreadsheetId: config.googleSheetId,
  });

  cached = { client: slack, handler };
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
```

- [ ] **Step 2: Install `@slack/web-api`**

Run: `npm install @slack/web-api`

- [ ] **Step 3: Commit**

```bash
git add src/lambda/clients.js package.json package-lock.json
git commit -m "feat(lambda): add cold-start client/handler factory"
```

---

## Task 7: Worker Lambda

**Files:**
- Create: `src/lambda/worker.js`
- Test:   `tests/lambda/worker.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lambda/worker.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchMock = vi.fn().mockResolvedValue();
const handlerMock = vi.fn().mockResolvedValue();
const fakeClient = { id: "slack" };

vi.mock("../../src/lambda/dispatch.js", () => ({
  dispatchSlackEvent: dispatchMock,
}));

vi.mock("../../src/lambda/clients.js", () => ({
  getDeps: () => ({ client: fakeClient, handler: handlerMock }),
}));

describe("worker.handler", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    handlerMock.mockClear();
  });

  it("calls dispatchSlackEvent for each SQS record", async () => {
    const { handler } = await import("../../src/lambda/worker.js");

    const body1 = JSON.stringify({ event: { type: "app_mention", channel: "C1", ts: "1" } });
    const body2 = JSON.stringify({ event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", user: "U1" } });

    await handler({ Records: [{ body: body1 }, { body: body2 }] });

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[0][0].slackEnvelope.event.type).toBe("app_mention");
    expect(dispatchMock.mock.calls[1][0].slackEnvelope.event.type).toBe("message");
    expect(dispatchMock.mock.calls[0][0].handler).toBe(handlerMock);
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

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lambda/worker.test.js`
Expected: cannot resolve module.

- [ ] **Step 3: Implement**

Create `src/lambda/worker.js`:

```js
import { dispatchSlackEvent } from "./dispatch.js";
import { getDeps } from "./clients.js";

export async function handler(sqsEvent) {
  const { client, handler: mentionHandler } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      client,
    });
  }
}
```

- [ ] **Step 4: Re-run, expect pass**

Run: `npm test -- tests/lambda/worker.test.js`
Expected: 2 passing.

- [ ] **Step 5: Full test sweep**

Run: `npm test`
Expected: all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/lambda/worker.js tests/lambda/worker.test.js
git commit -m "feat(lambda): add SQS-driven worker Lambda"
```

---

## Task 8: Remove Socket Mode entry point + clean `package.json`

**Files:**
- Delete: `src/app.js`
- Modify: `package.json`

- [ ] **Step 1: Delete `src/app.js`**

Run: `rm src/app.js`

- [ ] **Step 2: Update `package.json`**

Read the file first, then replace the `scripts` block. Final file should be:

```json
{
  "name": "fh-maintenance-bot",
  "version": "1.0.0",
  "description": "",
  "main": "src/lambda/worker.js",
  "directories": {
    "doc": "docs"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-sqs": "^3.0.0",
    "@slack/bolt": "^4.7.0",
    "@slack/web-api": "^7.0.0",
    "dotenv": "^17.4.1",
    "googleapis": "^171.4.0",
    "openai": "^6.33.0"
  },
  "devDependencies": {
    "vitest": "^4.1.3"
  }
}
```

Adjust the `@aws-sdk/client-sqs` and `@slack/web-api` versions to whatever `npm install` actually pinned in tasks 4 and 6 (run `cat package.json` to confirm).

Note on `@slack/bolt`: keep it installed for now; nothing imports it after this task. It's removed in Task 13 once stability is confirmed.

- [ ] **Step 3: Confirm nothing imports the deleted file**

Run: `grep -r "src/app" src tests || true`
Expected: no output.

- [ ] **Step 4: Run full test sweep**

Run: `npm test`
Expected: all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/app.js package.json
git commit -m "chore: remove Socket Mode entry point; drop pm2 start script"
```

(`git add` on a deleted file stages the deletion.)

---

## Task 9: SAM template

**Files:**
- Create: `template.yaml`

- [ ] **Step 1: Create `template.yaml`**

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Description: fh-maintenance-bot — Slack Events API receiver + SQS-driven worker

Parameters:
  SlackBotToken:        { Type: String, NoEcho: true }
  SlackSigningSecret:   { Type: String, NoEcho: true }
  SlackChannelId:       { Type: String }
  GoogleSheetId:        { Type: String }
  GoogleClientId:       { Type: String, NoEcho: true }
  GoogleClientSecret:   { Type: String, NoEcho: true }
  GoogleRefreshToken:   { Type: String, NoEcho: true }
  GroqApiKey:           { Type: String, NoEcho: true }

Globals:
  Function:
    Runtime: nodejs20.x
    Architectures: [arm64]
    LoggingConfig:
      LogFormat: JSON

Resources:
  EventDLQ:
    Type: AWS::SQS::Queue
    Properties:
      MessageRetentionPeriod: 1209600

  EventQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt EventDLQ.Arn
        maxReceiveCount: 3

  ReceiverFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/receiver.handler
      MemorySize: 128
      Timeout: 10
      Environment:
        Variables:
          SLACK_SIGNING_SECRET: !Ref SlackSigningSecret
          SLACK_BOT_TOKEN:      !Ref SlackBotToken
          EVENT_QUEUE_URL:      !Ref EventQueue
          SLACK_CHANNEL_ID:     !Ref SlackChannelId
          GOOGLE_SHEET_ID:      !Ref GoogleSheetId
          GOOGLE_CLIENT_ID:     !Ref GoogleClientId
          GOOGLE_CLIENT_SECRET: !Ref GoogleClientSecret
          GOOGLE_REFRESH_TOKEN: !Ref GoogleRefreshToken
          GROQ_API_KEY:         !Ref GroqApiKey
      FunctionUrlConfig:
        AuthType: NONE
      Policies:
        - SQSSendMessagePolicy:
            QueueName: !GetAtt EventQueue.QueueName

  ReceiverLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${ReceiverFn}
      RetentionInDays: 14

  WorkerFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/worker.handler
      MemorySize: 256
      Timeout: 30
      Environment:
        Variables:
          SLACK_BOT_TOKEN:        !Ref SlackBotToken
          SLACK_SIGNING_SECRET:   !Ref SlackSigningSecret
          SLACK_CHANNEL_ID:       !Ref SlackChannelId
          GOOGLE_SHEET_ID:        !Ref GoogleSheetId
          GOOGLE_CLIENT_ID:       !Ref GoogleClientId
          GOOGLE_CLIENT_SECRET:   !Ref GoogleClientSecret
          GOOGLE_REFRESH_TOKEN:   !Ref GoogleRefreshToken
          GROQ_API_KEY:           !Ref GroqApiKey
      Events:
        FromQueue:
          Type: SQS
          Properties:
            Queue: !GetAtt EventQueue.Arn
            BatchSize: 1

  WorkerLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${WorkerFn}
      RetentionInDays: 14

Outputs:
  FunctionUrl:
    Description: Paste this into the Slack app Event Subscriptions → Request URL
    Value: !GetAtt ReceiverFnUrl.FunctionUrl
  EventQueueUrl:
    Value: !Ref EventQueue
  EventDLQUrl:
    Value: !Ref EventDLQ
```

Notes:
- `Architectures: [arm64]` is cheaper for Node Lambdas.
- Both functions receive the full env-var set (worker needs all, receiver needs only SQS + signing secret + bot token but `loadConfig()` validates the full set; duplicating is fine).
- The `ReceiverFnUrl` logical name follows SAM's convention: SAM auto-creates `<FnLogicalName>Url` when `FunctionUrlConfig` is set.

- [ ] **Step 2: Validate the template syntactically**

Run: `sam validate --lint`
Expected: `template.yaml is a valid SAM Template`.

(If `sam` is not installed, install it: `brew install aws-sam-cli`.)

- [ ] **Step 3: Commit**

```bash
git add template.yaml
git commit -m "feat(infra): add SAM template for receiver + worker + SQS"
```

---

## Task 10: `samconfig.toml` (committed defaults)

**Files:**
- Create: `samconfig.toml`

- [ ] **Step 1: Create the file**

```toml
version = 0.1

[default.global.parameters]
stack_name = "fh-maintenance-bot"

[default.build.parameters]
cached = true
parallel = true

[default.deploy.parameters]
region = "us-east-1"
capabilities = "CAPABILITY_IAM"
confirm_changeset = false
fail_on_empty_changeset = false
resolve_s3 = true
```

`resolve_s3 = true` lets SAM auto-create + reuse a managed artifact bucket. No `parameter_overrides` line — secrets always come from `samconfig.local.toml` (laptop) or `--parameter-overrides` (CI).

- [ ] **Step 2: Commit**

```bash
git add samconfig.toml
git commit -m "feat(infra): add SAM config defaults (region, stack name)"
```

---

## Task 11: GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: deploy

on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "**.md"
  workflow_dispatch:

permissions:
  id-token: write   # required for OIDC
  contents: read

concurrency:
  group: deploy-main
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1

      - uses: aws-actions/setup-sam@v2
        with:
          use-installer: true

      - name: SAM build
        run: sam build

      - name: SAM deploy
        run: |
          sam deploy \
            --no-confirm-changeset \
            --no-fail-on-empty-changeset \
            --parameter-overrides \
              SlackBotToken="${{ secrets.SLACK_BOT_TOKEN }}" \
              SlackSigningSecret="${{ secrets.SLACK_SIGNING_SECRET }}" \
              SlackChannelId="${{ secrets.SLACK_CHANNEL_ID }}" \
              GoogleSheetId="${{ secrets.GOOGLE_SHEET_ID }}" \
              GoogleClientId="${{ secrets.GOOGLE_CLIENT_ID }}" \
              GoogleClientSecret="${{ secrets.GOOGLE_CLIENT_SECRET }}" \
              GoogleRefreshToken="${{ secrets.GOOGLE_REFRESH_TOKEN }}" \
              GroqApiKey="${{ secrets.GROQ_API_KEY }}"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy via GitHub Actions + OIDC role"
```

---

## Task 12: Bootstrap runbook

**Files:**
- Create: `docs/aws-bootstrap.md`

- [ ] **Step 1: Create the runbook**

```markdown
# AWS Bootstrap

One-time setup before CI deploys can run. Do this from your laptop with admin AWS credentials.

## 1. AWS account + CLI

- `aws configure` (or SSO).
- Default region: `us-east-1`.

## 2. GitHub OIDC provider

If your AWS account doesn't already have a provider for `token.actions.githubusercontent.com`:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

(GitHub publishes the current root CA thumbprint here: https://docs.github.com/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

## 3. Deploy role

Create an IAM role `fh-maintenance-bot-deploy` with:

**Trust policy** (replace `OWNER/REPO`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:ref:refs/heads/main" }
    }
  }]
}
```

**Permissions:** for a first pass, attach `AWSCloudFormationFullAccess`, `AmazonSQSFullAccess`, `AWSLambda_FullAccess`, `IAMFullAccess`, `CloudWatchLogsFullAccess`, `AmazonS3FullAccess`. Tighten later.

Record the role ARN.

## 4. GitHub repository secrets

In GitHub → Settings → Secrets and variables → Actions, create:

| Name | Source |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | role ARN from step 3 |
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret |
| `SLACK_CHANNEL_ID` | Slack channel ID where the bot operates |
| `GOOGLE_SHEET_ID` | spreadsheet ID |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | from `scripts/get-google-token.js` |
| `GROQ_API_KEY` | from https://console.groq.com |

## 5. First manual deploy (to set the Slack Request URL)

```bash
cp samconfig.toml samconfig.local.toml
```

Edit `samconfig.local.toml` and add under `[default.deploy.parameters]`:

```toml
parameter_overrides = """
SlackBotToken="xoxb-..."
SlackSigningSecret="..."
SlackChannelId="C..."
GoogleSheetId="..."
GoogleClientId="..."
GoogleClientSecret="..."
GoogleRefreshToken="..."
GroqApiKey="gsk_..."
"""
```

Then:

```bash
sam build
sam deploy
```

Note the `FunctionUrl` output.

## 6. Reconfigure the Slack app

In https://api.slack.com/apps → your app:

1. Settings → Socket Mode → **disable**.
2. Settings → Basic Information → revoke the App-Level Token (`xapp-...`).
3. Features → Event Subscriptions → enable; paste the `FunctionUrl` from step 5 as the **Request URL**. Slack will send a `url_verification` challenge; expect a green check.
4. Subscribe to bot events: `app_mention`, `message.channels`.
5. Save.
6. Reinstall app to workspace if Slack prompts for scope re-grant.

## 7. Smoke test

In the configured channel:

```
@FH Maintenance test
```

Expect: 👀 reaction within ~1s, then severity prompt. Confirm a row appears in the Sheet.

Watch logs:

```bash
sam logs --stack-name fh-maintenance-bot --name ReceiverFn --tail
sam logs --stack-name fh-maintenance-bot --name WorkerFn   --tail
```

## 8. Decommission the Pi

```
pm2 stop fh-maintenance-bot
pm2 delete fh-maintenance-bot
```

Keep `.env` archived offline for 30 days in case rollback is needed.

## Rollback

1. Slack app → re-enable Socket Mode, regenerate App-Level Token, paste it back into the Pi's `.env`.
2. On the Pi: `pm2 start ecosystem.config.cjs`.
3. AWS stack can stay deployed at ~$0 cost while debugging.
```

- [ ] **Step 2: Commit**

```bash
git add docs/aws-bootstrap.md
git commit -m "docs: add AWS bootstrap runbook"
```

---

## Task 13: README rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the README**

Replace the entire contents of `README.md` with:

```markdown
# fh-maintenance-bot

A Slack bot for managing facilities maintenance issue reporting and tracking. Mention the bot in a Slack channel to log issues, detect duplicates, and get AI-powered fix suggestions.

## Features

- **Issue reporting** via Slack @mentions — automatically logged to Google Sheets
- **Duplicate detection** — two-pass strategy using keyword matching + LLM verification
- **Fix suggestions** — AI-powered quick-fix recommendations for common issues
- **Issue management** — list open issues, close/resolve by ID or description

## Architecture

```
Slack ──HTTPS──▶ ReceiverFn (Lambda Function URL)
                        │
                        ▼
                  EventQueue (SQS) ──▶ WorkerFn (Lambda)
                                              │
                                              ▼
                              Groq · Google Sheets · Slack Web API
```

Two AWS Lambdas. SQS in between for the 3-second Slack ack budget. No VPC, no database.

## Tech Stack

- AWS Lambda (Node 20, arm64), SQS, CloudWatch Logs
- AWS SAM for IaC
- GitHub Actions + OIDC for deploys
- [Slack Web API](https://slack.dev/) (Events API, not Socket Mode)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [Groq](https://groq.com/) (Llama 3.3 70B)

## Setup

See [`docs/aws-bootstrap.md`](docs/aws-bootstrap.md) for the one-time bootstrap runbook.

After bootstrap, deploys happen automatically on push to `main`.

### Local development

```bash
npm install
cp .env.example .env  # fill in secrets
npm test
```

### Required environment variables (for local tests / `sam local`)

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_CHANNEL_ID` | Channel ID for maintenance requests |
| `GOOGLE_SHEET_ID` | Spreadsheet ID |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth2 refresh token |
| `GROQ_API_KEY` | Groq API key (`gsk_...`) |

To generate a Google refresh token:

```bash
node scripts/get-google-token.js <client_id> <client_secret>
```

## Usage

In the configured Slack channel:

| Command | Description |
|---|---|
| `@bot <description>` | Report a new issue |
| `@bot list` or `@bot show` | List all open issues |
| `@bot close #<ID>` | Resolve an issue by ID |
| `@bot close <description>` | Resolve an issue by description |
| `@bot create new: <description>` | Force-create, bypassing duplicate detection |

## Project structure

```
src/
  config.js                  # env loading
  events/mention.js          # @mention business logic (Slack-runtime-agnostic)
  services/sheets.js         # Google Sheets CRUD
  services/groq.js           # LLM client
  services/dedup.js          # duplicate detection
  lambda/
    receiver.js              # entry: verify Slack sig, enqueue to SQS
    worker.js                # entry: SQS → dispatch
    dispatch.js              # SQS record → (event, say, client) → mention handler
    clients.js               # cold-start dep wiring
    slack-signature.js       # HMAC verification
template.yaml                # SAM
samconfig.toml               # SAM defaults
.github/workflows/deploy.yml # CI/CD
```
```

- [ ] **Step 2: Update `.env.example`**

Replace with:

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CHANNEL_ID=C0123456789
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_CLIENT_ID=your-oauth-client-id
GOOGLE_CLIENT_SECRET=your-oauth-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
GROQ_API_KEY=gsk_your-groq-api-key
```

- [ ] **Step 3: Remove `@slack/bolt` (no longer used)**

Run: `grep -r "@slack/bolt" src tests || true`
Expected: no output.

If clean, drop the dependency:

```bash
npm uninstall @slack/bolt
```

- [ ] **Step 4: Final full test sweep**

Run: `npm test`
Expected: all suites green.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example package.json package-lock.json
git commit -m "docs: README rewrite for AWS Lambda deployment; drop @slack/bolt"
```

---

## Task 14: Pre-deploy local validation

Before triggering a real deploy, sanity-check the build artifact locally.

- [ ] **Step 1: SAM build**

Run: `sam build`
Expected: `Build Succeeded`. `.aws-sam/build/` populated for both functions.

- [ ] **Step 2: Local invoke — receiver, url_verification**

This step is optional — the signing logic is already covered by the unit tests in Task 3. Skip if you don't want to wire a real signing secret into a local file.

If you do want to do it:

```bash
SIGNING_SECRET="copy-the-real-signing-secret"
BODY='{"type":"url_verification","challenge":"abc"}'
TS=$(date +%s)
SIG="v0=$(printf "v0:%s:%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')"

cat > events/url-verify.json <<EOF
{
  "headers": {
    "x-slack-request-timestamp": "$TS",
    "x-slack-signature": "$SIG"
  },
  "body": $(printf '%s' "$BODY" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')
}
EOF

sam local invoke ReceiverFn \
  --event events/url-verify.json \
  --env-vars events/local-env.json
```

Expected: `{ "statusCode": 200, "body": "abc" }`. Do not commit `events/url-verify.json` — it contains a live signature derived from your secret. Add it to `.gitignore` in step 4.

- [ ] **Step 3: Local invoke — worker**

Create `events/sqs-mention.json`:

```json
{
  "Records": [
    {
      "body": "{\"event\":{\"type\":\"app_mention\",\"channel\":\"C123\",\"text\":\"<@U_BOT> printer jammed\",\"user\":\"U1\",\"ts\":\"1\"}}"
    }
  ]
}
```

Run:

```bash
sam local invoke WorkerFn \
  --event events/sqs-mention.json \
  --env-vars events/local-env.json
```

Where `events/local-env.json` contains real test creds (gitignored). This actually hits Slack/Groq/Sheets — only run against a sandbox channel/sheet.

If unwilling to wire real creds: skip. Unit tests already cover dispatcher + worker logic.

- [ ] **Step 4: Document local-test artifacts**

Add to `.gitignore`:

```
events/local-env.json
events/url-verify.json
```

Commit only the SQS event fixture, not credentials or signed payloads.

- [ ] **Step 5: Commit fixtures**

```bash
git add events/url-verify.json events/sqs-mention.json .gitignore
git commit -m "test: add local SAM invoke fixtures"
```

(Skip this commit if step 2/3 were skipped.)

---

## Task 15: Cutover

This is a runbook-style task. No code change. Execute in order. See `docs/aws-bootstrap.md` for full detail; this is the abridged cutover sequence.

- [ ] **Step 1: Merge to `main`**

Wait for `deploy` workflow to succeed in GitHub Actions.

- [ ] **Step 2: Read the Function URL**

```bash
aws cloudformation describe-stacks \
  --stack-name fh-maintenance-bot \
  --query 'Stacks[0].Outputs[?OutputKey==`FunctionUrl`].OutputValue' \
  --output text
```

- [ ] **Step 3: Stop the Pi**

On the Raspberry Pi:

```bash
pm2 stop fh-maintenance-bot
```

(Do not delete yet.)

- [ ] **Step 4: Reconfigure Slack app**

In api.slack.com → your app:
- Socket Mode → disable
- Event Subscriptions → enable, paste Function URL, expect green check
- Subscribe to bot events: `app_mention`, `message.channels`
- Reinstall to workspace if prompted

- [ ] **Step 5: Live test**

In the configured channel:

```
@FH Maintenance the kitchen faucet is leaking
```

Expect:
1. 👀 reaction within ~1s
2. Severity prompt within ~2-5s
3. After replying `medium`: confirmation message + new row in Sheet

- [ ] **Step 6: Watch logs for ~30 min**

```bash
sam logs --stack-name fh-maintenance-bot --name WorkerFn --tail
```

Watch DLQ:

```bash
aws sqs get-queue-attributes \
  --queue-url <EventDLQUrl from stack outputs> \
  --attribute-names ApproximateNumberOfMessages
```

- [ ] **Step 7: Decommission the Pi**

```bash
pm2 delete fh-maintenance-bot
```

Archive `.env` offline. Bot migration complete.

---

## Out of Scope (deferred)

Same as the design spec — VPC, KMS CMK, X-Ray, custom domain, CloudWatch alarms, SSM Parameter Store, blue/green deploys, multi-region, rate limiting.
