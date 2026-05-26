# Inbound SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Twilio-backed SMS path so anyone can text the bot to file a maintenance request, with the same classifier/dedup/Sheets/Slack pipeline used in-channel.

**Architecture:** A new `SmsReceiverFn` Lambda sits behind its own public Function URL. It verifies Twilio's HMAC-SHA1 signature, parses the form-encoded body, runs the message through a shared classifier/dedup/Sheets pipeline (reusing the existing services), posts a mirror to a configurable Slack channel, and returns a TwiML response that becomes the texter's reply. Single sync Lambda, no SQS, ~$1/mo + ~$0.02 per exchange.

**Tech Stack:** Node 22, `@slack/web-api`, `googleapis`, `openai` (Groq), AWS SAM, `node:crypto` (HMAC-SHA1), vitest.

**Design reference:** `docs/superpowers/specs/2026-05-26-sms-inbound-design.md`

---

## File Plan

```
NEW   src/lib/severity.js                Shared extractSeverity() + SEVERITY_OPTIONS
NEW   src/lambda/twilio-signature.js     HMAC-SHA1 verifier for X-Twilio-Signature
NEW   src/sms/pipeline.js                Runs the SMS request: classify, dedup, Sheets append, Slack mirror → { replyText }
NEW   src/lambda/sms-receiver.js         Lambda entry: verify, parse, dispatch to pipeline, return TwiML

NEW   tests/lib/severity.test.js
NEW   tests/lambda/twilio-signature.test.js
NEW   tests/sms/pipeline.test.js
NEW   tests/lambda/sms-receiver.test.js

MODIFY src/events/mention.js             Drop local extractSeverity / SEVERITY_OPTIONS, import from src/lib/severity.js
MODIFY src/lambda/clients.js             Extend getDeps() cache to also return sheetsService, groqService, dedupService
MODIFY template.yaml                     Add SmsReceiverFn + log group + 2 params (TwilioAuthToken, SmsTargetChannelId)
MODIFY .github/workflows/deploy.yml      Pass TwilioAuthToken + SmsTargetChannelId via --parameter-overrides
MODIFY .env.example                      Document TWILIO_AUTH_TOKEN, SMS_TARGET_CHANNEL_ID
MODIFY README.md                         Add SMS feature mention + setup pointer to spec
```

---

## Task 1: Extract shared severity util

Move `extractSeverity` and `SEVERITY_OPTIONS` out of `src/events/mention.js` into `src/lib/severity.js` so the SMS pipeline can reuse them. The mention handler keeps using them via import. No behavior change.

**Files:**
- Create: `src/lib/severity.js`
- Create: `tests/lib/severity.test.js`
- Modify: `src/events/mention.js` (delete the local definitions, import instead)

- [ ] **Step 1: Write the failing test for the shared util**

Create `tests/lib/severity.test.js`:

```js
import { describe, it, expect } from "vitest";
import { extractSeverity, SEVERITY_OPTIONS } from "../../src/lib/severity.js";

describe("extractSeverity", () => {
  it("returns null severity when none present", () => {
    expect(extractSeverity("printer jammed")).toEqual({
      description: "printer jammed",
      severity: null,
    });
  });

  it("extracts trailing severity after a dash", () => {
    expect(extractSeverity("printer jammed - critical")).toEqual({
      description: "printer jammed",
      severity: "Critical",
    });
  });

  it("extracts severity after a colon", () => {
    expect(extractSeverity("leaky faucet: medium")).toEqual({
      description: "leaky faucet",
      severity: "Medium",
    });
  });

  it("extracts 'minor severity' suffix", () => {
    expect(extractSeverity("door squeaks - minor severity")).toEqual({
      description: "door squeaks",
      severity: "Minor",
    });
  });

  it("is case-insensitive", () => {
    expect(extractSeverity("loud HVAC - MEDIUM")).toEqual({
      description: "loud HVAC",
      severity: "Medium",
    });
  });

  it("exposes SEVERITY_OPTIONS in lowercase", () => {
    expect(SEVERITY_OPTIONS).toEqual(["minor", "medium", "critical"]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lib/severity.test.js`
Expected: cannot resolve `../../src/lib/severity.js`.

- [ ] **Step 3: Create the shared util**

Create `src/lib/severity.js` (lift verbatim from `src/events/mention.js` lines 32–41):

```js
export const SEVERITY_OPTIONS = ["minor", "medium", "critical"];

export function extractSeverity(text) {
  // Match patterns like "- critical", "critical priority", "severity: minor", "medium severity", or trailing "critical"
  const match = text.match(
    /[\s,\-\|]+(?:severity[:\s]+)?(minor|medium|critical)(?:\s+(?:priority|severity|issue))?\s*$|[\s,\-\|]+(minor|medium|critical)\s+(?:priority|severity)\s*$/i
  );
  if (!match) return { description: text, severity: null };
  const severity = (match[1] || match[2])
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
  const description = text.slice(0, match.index).trim();
  return { description, severity };
}
```

- [ ] **Step 4: Run the new test, expect pass**

Run: `npm test -- tests/lib/severity.test.js`
Expected: 6 passing.

- [ ] **Step 5: Remove duplicates from `src/events/mention.js` and import the shared util**

In `src/events/mention.js`:

Delete these lines (currently lines 32–41):

```js
const SEVERITY_OPTIONS = ["minor", "medium", "critical"];

function extractSeverity(text) {
  // Match patterns like "- critical", "critical priority", "severity: minor", "medium severity", or trailing "critical"
  const match = text.match(/[\s,\-\|]+(?:severity[:\s]+)?(minor|medium|critical)(?:\s+(?:priority|severity|issue))?\s*$|[\s,\-\|]+(minor|medium|critical)\s+(?:priority|severity)\s*$/i);
  if (!match) return { description: text, severity: null };
  const severity = (match[1] || match[2]).toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const description = text.slice(0, match.index).trim();
  return { description, severity };
}
```

Add to the top of the file (after the existing `function getKeywords` block, before `function keywordOverlap`):

```js
import { extractSeverity, SEVERITY_OPTIONS } from "../lib/severity.js";
```

(Place the import at the top of the file with the other module-scope code. Since `mention.js` has no other imports today, this is the first one — put it on line 1.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green (mention tests still pass against the imported util).

- [ ] **Step 7: Commit**

```bash
git add src/lib/severity.js tests/lib/severity.test.js src/events/mention.js
git commit -m "refactor: extract severity parser into src/lib/severity.js"
```

---

## Task 2: Twilio signature verifier

Pure helper that implements Twilio's webhook signing algorithm: HMAC-SHA1 over the full URL plus all sorted POST params concatenated, base64-encoded, compared in constant time.

**Files:**
- Create: `src/lambda/twilio-signature.js`
- Create: `tests/lambda/twilio-signature.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lambda/twilio-signature.test.js`:

```js
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyTwilioSignature } from "../../src/lambda/twilio-signature.js";

const AUTH_TOKEN = "test-auth-token";

function sign(url, params) {
  const sortedKeys = Object.keys(params).sort();
  const concat = url + sortedKeys.map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", AUTH_TOKEN).update(concat).digest("base64");
}

describe("verifyTwilioSignature", () => {
  const URL = "https://example.lambda-url.us-east-1.on.aws/";
  const PARAMS = {
    From: "+15555550100",
    To: "+15555550199",
    Body: "printer jammed - medium",
    MessageSid: "SM123",
  };

  it("accepts a valid signature regardless of input key order", () => {
    const signature = sign(URL, PARAMS);
    const reordered = {
      Body: PARAMS.Body,
      From: PARAMS.From,
      MessageSid: PARAMS.MessageSid,
      To: PARAMS.To,
    };
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url: URL, params: reordered, signature })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = sign(URL, PARAMS);
    const tampered = { ...PARAMS, Body: "totally different message" };
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url: URL, params: tampered, signature })).toBe(false);
  });

  it("rejects a different URL", () => {
    const signature = sign(URL, PARAMS);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: "https://attacker.example/",
        params: PARAMS,
        signature,
      })
    ).toBe(false);
  });

  it("rejects a different auth token", () => {
    const signature = sign(URL, PARAMS);
    expect(
      verifyTwilioSignature({ authToken: "wrong-token", url: URL, params: PARAMS, signature })
    ).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url: URL, params: PARAMS, signature: "" })).toBe(false);
    expect(verifyTwilioSignature({ authToken: "", url: URL, params: PARAMS, signature: "abc" })).toBe(false);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url: "", params: PARAMS, signature: "abc" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lambda/twilio-signature.test.js`
Expected: cannot resolve module.

- [ ] **Step 3: Implement**

Create `src/lambda/twilio-signature.js`:

```js
import crypto from "node:crypto";

export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !url || !signature || !params) return false;

  const sortedKeys = Object.keys(params).sort();
  const concat = url + sortedKeys.map((k) => k + params[k]).join("");
  const computed = crypto.createHmac("sha1", authToken).update(concat).digest("base64");

  const a = Buffer.from(signature);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/lambda/twilio-signature.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/twilio-signature.js tests/lambda/twilio-signature.test.js
git commit -m "feat(lambda): add Twilio webhook signature verifier"
```

---

## Task 3: Extend `getDeps()` to expose services

The SMS pipeline needs direct access to `sheetsService`, `groqService`, and `dedupService`. Today `getDeps()` only returns `{ client, handler }`. Extend the cached object without breaking the worker.

**Files:**
- Modify: `src/lambda/clients.js`

- [ ] **Step 1: Read the current file**

Open `src/lambda/clients.js`. Confirm it currently caches `{ client: slack, handler }`.

- [ ] **Step 2: Update the cached shape**

Replace the line:

```js
  cached = { client: slack, handler };
```

with:

```js
  cached = {
    client: slack,
    handler,
    sheetsService,
    groqService,
    dedupService,
  };
```

The Slack worker destructures `{ client, handler: mentionHandler }` — those still work. The SMS receiver will destructure `{ client, sheetsService, groqService, dedupService }`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 57 passing (no test changes — Slack worker tests still mock `getDeps` shape with what they need).

- [ ] **Step 4: Commit**

```bash
git add src/lambda/clients.js
git commit -m "feat(lambda): expose services from getDeps() for SMS reuse"
```

---

## Task 4: SMS pipeline — pure logic + side effects

The pipeline owns the SMS-shaped flow end-to-end: severity extraction, classifier, dedup, Sheets append, Slack mirror, reply text composition. Receiver just wraps it with TwiML.

**Files:**
- Create: `src/sms/pipeline.js`
- Create: `tests/sms/pipeline.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/sms/pipeline.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSmsPipeline } from "../../src/sms/pipeline.js";

function makeDeps(overrides = {}) {
  return {
    sheetsService: {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("42"),
    },
    groqService: {
      isMaintenanceRequest: vi.fn().mockResolvedValue(true),
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
    },
    dedupService: {
      findDuplicate: vi.fn().mockResolvedValue(null),
    },
    slackClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({}) },
    },
    smsTargetChannelId: "C_SMS",
    spreadsheetId: "sheet-id",
    ...overrides,
  };
}

describe("runSmsPipeline", () => {
  it("asks for severity when missing", async () => {
    const deps = makeDeps();
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "printer jammed",
      deps,
    });
    expect(replyText).toMatch(/severity at the end/i);
    expect(deps.sheetsService.appendIssue).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it("asks for a description when body is just a severity", async () => {
    const deps = makeDeps();
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "- medium",
      deps,
    });
    expect(replyText).toMatch(/describe the issue/i);
    expect(deps.sheetsService.appendIssue).not.toHaveBeenCalled();
  });

  it("rejects non-maintenance content via the classifier", async () => {
    const deps = makeDeps({
      groqService: {
        isMaintenanceRequest: vi.fn().mockResolvedValue(false),
        suggestFix: vi.fn(),
      },
    });
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "hi there - minor",
      deps,
    });
    expect(replyText).toMatch(/doesn't look like a maintenance issue/i);
    expect(deps.sheetsService.appendIssue).not.toHaveBeenCalled();
  });

  it("rejects when dedup finds a confident match", async () => {
    const deps = makeDeps({
      sheetsService: {
        getOpenIssues: vi.fn().mockResolvedValue([
          { id: "7", description: "printer jammed", status: "Need to Assign", date: new Date().toLocaleDateString("en-US") },
        ]),
        appendIssue: vi.fn(),
      },
      dedupService: {
        findDuplicate: vi.fn().mockResolvedValue({ id: "7", confident: true }),
      },
    });
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "printer jammed - medium",
      deps,
    });
    expect(replyText).toMatch(/already reported.*#7/i);
    expect(replyText).toMatch(/new:/);
    expect(deps.sheetsService.appendIssue).not.toHaveBeenCalled();
  });

  it("happy path: logs issue, posts to Slack, returns issue id", async () => {
    const deps = makeDeps();
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "printer jammed - medium",
      deps,
    });
    expect(deps.sheetsService.appendIssue).toHaveBeenCalledWith({
      reporter: "SMS ****0100",
      description: "printer jammed",
      severity: "Medium",
    });
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
    const slackCall = deps.slackClient.chat.postMessage.mock.calls[0][0];
    expect(slackCall.channel).toBe("C_SMS");
    expect(slackCall.text).toMatch(/SMS \*{4}0100/);
    expect(slackCall.text).toMatch(/#42/);
    expect(slackCall.text).toMatch(/printer jammed/);
    expect(slackCall.text).toMatch(/Medium/);
    expect(replyText).toMatch(/Logged as issue #42/);
    expect(replyText).toMatch(/Medium/);
    expect(replyText).toMatch(/Try restarting it/);
  });

  it("'new:' prefix bypasses classifier and dedup", async () => {
    const deps = makeDeps({
      groqService: {
        isMaintenanceRequest: vi.fn(),
        suggestFix: vi.fn().mockResolvedValue("…"),
      },
      dedupService: { findDuplicate: vi.fn() },
    });
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "new: weird thing - critical",
      deps,
    });
    expect(deps.groqService.isMaintenanceRequest).not.toHaveBeenCalled();
    expect(deps.dedupService.findDuplicate).not.toHaveBeenCalled();
    expect(deps.sheetsService.appendIssue).toHaveBeenCalledWith({
      reporter: "SMS ****0100",
      description: "weird thing",
      severity: "Critical",
    });
    expect(replyText).toMatch(/Logged as issue #42/);
  });

  it("truncates long suggestion to 800 chars in SMS reply, leaves Slack post intact", async () => {
    const longSuggestion = "x".repeat(2000);
    const deps = makeDeps({
      groqService: {
        isMaintenanceRequest: vi.fn().mockResolvedValue(true),
        suggestFix: vi.fn().mockResolvedValue(longSuggestion),
      },
    });
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "fuse box buzzing - critical",
      deps,
    });
    expect(replyText.length).toBeLessThan(1600);
    expect(replyText).toContain("xxx");
    const slackCall = deps.slackClient.chat.postMessage.mock.calls[0][0];
    expect(slackCall.text).toContain(longSuggestion);
  });

  it("when dedup is uncertain, notes possible relation in both reply and Slack post", async () => {
    const deps = makeDeps({
      sheetsService: {
        getOpenIssues: vi.fn().mockResolvedValue([
          { id: "11", description: "printer jammed", status: "Need to Assign", date: new Date().toLocaleDateString("en-US") },
        ]),
        appendIssue: vi.fn().mockResolvedValue("42"),
      },
      dedupService: {
        findDuplicate: vi.fn().mockResolvedValue({ id: "11", confident: false }),
      },
    });
    const { replyText } = await runSmsPipeline({
      from: "+15555550100",
      body: "printer making noise - minor",
      deps,
    });
    expect(deps.sheetsService.appendIssue).toHaveBeenCalled();
    expect(replyText).toMatch(/related to issue #11/i);
    const slackCall = deps.slackClient.chat.postMessage.mock.calls[0][0];
    expect(slackCall.text).toMatch(/related to issue #11/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/sms/pipeline.test.js`
Expected: cannot resolve module.

- [ ] **Step 3: Implement the pipeline**

Create `src/sms/pipeline.js`:

```js
import { extractSeverity } from "../lib/severity.js";

const SMS_BODY_MAX = 1500; // safety margin under Twilio's 1600 char cap
const SUGGESTION_TRUNCATE = 800;

function maskPhone(from) {
  const last4 = (from || "").slice(-4);
  return `SMS ****${last4}`;
}

function truncate(s, n) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export async function runSmsPipeline({ from, body, deps }) {
  const {
    sheetsService,
    groqService,
    dedupService,
    slackClient,
    smsTargetChannelId,
    spreadsheetId,
  } = deps;

  const trimmed = (body || "").trim();

  const forceCreate = /^new:\s*/i.test(trimmed);
  const afterPrefix = forceCreate ? trimmed.replace(/^new:\s*/i, "") : trimmed;

  const { description, severity } = extractSeverity(afterPrefix);

  if (!severity) {
    return {
      replyText:
        'Please include severity at the end: minor, medium, or critical. Example: "Printer jammed - medium"',
    };
  }

  if (!description) {
    return { replyText: "Please describe the issue." };
  }

  if (!forceCreate) {
    const isMaintenance = await groqService.isMaintenanceRequest(description);
    if (!isMaintenance) {
      return {
        replyText:
          'That doesn\'t look like a maintenance issue. Try: "<what\'s broken> - minor/medium/critical"',
      };
    }
  }

  let openIssues = [];
  try {
    openIssues = await sheetsService.getOpenIssues();
  } catch {
    return {
      replyText: "Couldn't log this issue right now — please try again in a few minutes.",
    };
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentIssues = openIssues.filter((issue) => {
    const parsed = new Date(issue.date);
    return !isNaN(parsed) && parsed >= sevenDaysAgo;
  });

  let duplicate = null;
  if (!forceCreate) {
    duplicate = await dedupService.findDuplicate(description, recentIssues);
    if (duplicate && duplicate.confident) {
      const existing = openIssues.find((i) => i.id === duplicate.id);
      const status = existing ? existing.status : "unknown";
      return {
        replyText: `Looks like this is already reported (issue #${duplicate.id}, status: ${status}). Not logging again. Reply "new: ${description} - ${severity.toLowerCase()}" to force create.`,
      };
    }
  }

  const reporter = maskPhone(from);

  let id;
  try {
    id = await sheetsService.appendIssue({ reporter, description, severity });
  } catch {
    return {
      replyText: "Couldn't log this issue right now — please try again in a few minutes.",
    };
  }

  const suggestion = await groqService.suggestFix(description);

  const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  const dupLine =
    duplicate && !duplicate.confident
      ? `\n_This might be related to issue #${duplicate.id}._`
      : "";
  const slackSuggestionLine = suggestion ? `\n_Suggested fix:_ ${suggestion}` : "";
  const slackText = `📱 New SMS request from ${reporter}\n*${description}* — severity *${severity}* — logged as #${id}\n<${docLink}|View in Google Sheets>${dupLine}${slackSuggestionLine}`;

  try {
    await slackClient.chat.postMessage({
      channel: smsTargetChannelId,
      text: slackText,
    });
  } catch {
    // mirror failure is non-fatal; the row is already in Sheets
  }

  const replySuggestion = suggestion
    ? `\nSuggested fix: ${truncate(suggestion, SUGGESTION_TRUNCATE)}`
    : "";
  const replyDup = duplicate && !duplicate.confident ? `\nThis might be related to issue #${duplicate.id}.` : "";
  const replyText = truncate(
    `Logged as issue #${id} (severity: ${severity}).${replyDup}${replySuggestion}`,
    SMS_BODY_MAX
  );

  return { replyText };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/sms/pipeline.test.js`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add src/sms/pipeline.js tests/sms/pipeline.test.js
git commit -m "feat(sms): add inbound SMS pipeline (classify, dedup, log, mirror)"
```

---

## Task 5: SMS receiver Lambda

Thin Lambda handler. Verifies Twilio sig, parses form body, hands off to pipeline, renders TwiML.

**Files:**
- Create: `src/lambda/sms-receiver.js`
- Create: `tests/lambda/sms-receiver.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lambda/sms-receiver.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const fakeServices = {
  sheetsService: {
    getOpenIssues: vi.fn().mockResolvedValue([]),
    appendIssue: vi.fn().mockResolvedValue("99"),
  },
  groqService: {
    isMaintenanceRequest: vi.fn().mockResolvedValue(true),
    suggestFix: vi.fn().mockResolvedValue("Try X."),
  },
  dedupService: {
    findDuplicate: vi.fn().mockResolvedValue(null),
  },
  client: {
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
  },
};

vi.mock("../../src/lambda/clients.js", () => ({
  getDeps: () => fakeServices,
}));

const AUTH_TOKEN = "test-auth-token";

function sign(url, params) {
  const sortedKeys = Object.keys(params).sort();
  const concat = url + sortedKeys.map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", AUTH_TOKEN).update(concat).digest("base64");
}

function buildEvent({ params, signature, host = "example.lambda-url.us-east-1.on.aws", path = "/" }) {
  const body = new URLSearchParams(params).toString();
  return {
    body,
    isBase64Encoded: false,
    rawPath: path,
    requestContext: { domainName: host },
    headers: {
      "x-twilio-signature": signature,
      "content-type": "application/x-www-form-urlencoded",
    },
  };
}

describe("sms-receiver.handler", () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.SMS_TARGET_CHANNEL_ID = "C_SMS";
    process.env.GOOGLE_SHEET_ID = "sheet-id";
    for (const svc of Object.values(fakeServices)) {
      for (const fn of Object.values(svc)) {
        if (typeof fn?.mockClear === "function") fn.mockClear();
      }
      if (svc.chat) svc.chat.postMessage.mockClear();
    }
    fakeServices.sheetsService.getOpenIssues.mockResolvedValue([]);
    fakeServices.sheetsService.appendIssue.mockResolvedValue("99");
    fakeServices.groqService.isMaintenanceRequest.mockResolvedValue(true);
    fakeServices.groqService.suggestFix.mockResolvedValue("Try X.");
    fakeServices.dedupService.findDuplicate.mockResolvedValue(null);
  });

  it("returns 403 on bad signature", async () => {
    const { handler } = await import("../../src/lambda/sms-receiver.js");
    const params = { From: "+15555550100", Body: "printer jammed - medium", MessageSid: "SM1" };
    const res = await handler(
      buildEvent({ params, signature: "definitely-not-valid" })
    );
    expect(res.statusCode).toBe(403);
    expect(fakeServices.sheetsService.appendIssue).not.toHaveBeenCalled();
  });

  it("returns TwiML asking for severity when missing", async () => {
    const { handler } = await import("../../src/lambda/sms-receiver.js");
    const params = { From: "+15555550100", Body: "printer jammed", MessageSid: "SM1" };
    const url = "https://example.lambda-url.us-east-1.on.aws/";
    const res = await handler(buildEvent({ params, signature: sign(url, params) }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/xml");
    expect(res.body).toContain("<Response><Message>");
    expect(res.body).toMatch(/severity at the end/i);
    expect(fakeServices.sheetsService.appendIssue).not.toHaveBeenCalled();
  });

  it("happy path: logs issue, mirrors to Slack, returns TwiML with issue id", async () => {
    const { handler } = await import("../../src/lambda/sms-receiver.js");
    const params = { From: "+15555550100", Body: "printer jammed - medium", MessageSid: "SM1" };
    const url = "https://example.lambda-url.us-east-1.on.aws/";
    const res = await handler(buildEvent({ params, signature: sign(url, params) }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<?xml");
    expect(res.body).toMatch(/Logged as issue #99/);
    expect(fakeServices.sheetsService.appendIssue).toHaveBeenCalledTimes(1);
    expect(fakeServices.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("escapes XML special characters in reply", async () => {
    const { handler } = await import("../../src/lambda/sms-receiver.js");
    fakeServices.groqService.suggestFix.mockResolvedValue("Try <this> & that");
    const params = { From: "+15555550100", Body: "loud HVAC - minor", MessageSid: "SM1" };
    const url = "https://example.lambda-url.us-east-1.on.aws/";
    const res = await handler(buildEvent({ params, signature: sign(url, params) }));
    expect(res.body).not.toContain("<this>");
    expect(res.body).toContain("&lt;this&gt;");
    expect(res.body).toContain("&amp;");
  });

  it("handles base64-encoded bodies", async () => {
    const { handler } = await import("../../src/lambda/sms-receiver.js");
    const params = { From: "+15555550100", Body: "leaky faucet - minor", MessageSid: "SM1" };
    const rawBody = new URLSearchParams(params).toString();
    const url = "https://example.lambda-url.us-east-1.on.aws/";
    const res = await handler({
      body: Buffer.from(rawBody).toString("base64"),
      isBase64Encoded: true,
      rawPath: "/",
      requestContext: { domainName: "example.lambda-url.us-east-1.on.aws" },
      headers: {
        "x-twilio-signature": sign(url, params),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Logged as issue #99/);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/lambda/sms-receiver.test.js`
Expected: cannot resolve module.

- [ ] **Step 3: Implement**

Create `src/lambda/sms-receiver.js`:

```js
import { verifyTwilioSignature } from "./twilio-signature.js";
import { getDeps } from "./clients.js";
import { runSmsPipeline } from "../sms/pipeline.js";

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(replyText) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(replyText)}</Message></Response>`,
  };
}

export async function handler(event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const url = `https://${event.requestContext.domainName}${event.rawPath || "/"}`;
  const signature = getHeader(event.headers, "x-twilio-signature");

  const ok = verifyTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    url,
    params,
    signature,
  });
  if (!ok) {
    return { statusCode: 403, body: "invalid signature" };
  }

  const { client, sheetsService, groqService, dedupService } = getDeps();

  const { replyText } = await runSmsPipeline({
    from: params.From,
    body: params.Body,
    deps: {
      sheetsService,
      groqService,
      dedupService,
      slackClient: client,
      smsTargetChannelId: process.env.SMS_TARGET_CHANNEL_ID,
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
    },
  });

  return twiml(replyText);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/lambda/sms-receiver.test.js`
Expected: 5 passing.

- [ ] **Step 5: Full suite green**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lambda/sms-receiver.js tests/lambda/sms-receiver.test.js
git commit -m "feat(lambda): add SMS receiver Lambda (Twilio webhook entry)"
```

---

## Task 6: SAM template additions

**Files:**
- Modify: `template.yaml`

- [ ] **Step 1: Add parameters**

In `template.yaml`, find the `Parameters:` block. Add these two lines under it (alphabetical-ish ordering not required):

```yaml
  TwilioAuthToken:      { Type: String, NoEcho: true }
  SmsTargetChannelId:   { Type: String }
```

- [ ] **Step 2: Add `SmsReceiverFn` + log group**

In the `Resources:` block, after the existing `WorkerLogGroup` resource and before `Outputs:`, add:

```yaml
  SmsReceiverFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/sms-receiver.handler
      MemorySize: 256
      Timeout: 15
      Environment:
        Variables:
          TWILIO_AUTH_TOKEN:      !Ref TwilioAuthToken
          SMS_TARGET_CHANNEL_ID:  !Ref SmsTargetChannelId
          SLACK_BOT_TOKEN:        !Ref SlackBotToken
          SLACK_CHANNEL_IDS:      !Join [",", !Ref SlackChannelIds]
          GOOGLE_SHEET_ID:        !Ref GoogleSheetId
          GOOGLE_CLIENT_ID:       !Ref GoogleClientId
          GOOGLE_CLIENT_SECRET:   !Ref GoogleClientSecret
          GOOGLE_REFRESH_TOKEN:   !Ref GoogleRefreshToken
          GROQ_API_KEY:           !Ref GroqApiKey
      FunctionUrlConfig:
        AuthType: NONE

  SmsReceiverLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${SmsReceiverFn}
      RetentionInDays: 14
```

Note: `SLACK_CHANNEL_IDS` is included so the Lambda runtime can call `loadConfig()` (via `getDeps()`) without throwing. Even though SMS doesn't filter by channel, `loadConfig` validates the full required set when called.

- [ ] **Step 3: Add the stack output**

In the `Outputs:` block, after the existing `EventDLQUrl` output, add:

```yaml
  SmsFunctionUrl:
    Description: Paste into Twilio Console → phone number → Messaging Webhook (HTTP POST)
    Value: !GetAtt SmsReceiverFnUrl.FunctionUrl
```

- [ ] **Step 4: Validate**

Run: `sam validate --lint`
Expected: `template.yaml is a valid SAM Template`.

- [ ] **Step 5: Build**

Run: `sam build`
Expected: `Build Succeeded`. Three functions packaged: ReceiverFn, WorkerFn, SmsReceiverFn.

- [ ] **Step 6: Commit**

```bash
git add template.yaml
git commit -m "feat(infra): add SmsReceiverFn Lambda + Twilio params"
```

---

## Task 7: CI workflow + env example + README

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add Twilio params to the deploy step**

In `.github/workflows/deploy.yml`, find the `sam deploy` step's `--parameter-overrides` block. Append two lines (keep the existing parameter order):

Before:

```
              GroqApiKey="${{ secrets.GROQ_API_KEY }}"
```

After:

```
              GroqApiKey="${{ secrets.GROQ_API_KEY }}" \
              TwilioAuthToken="${{ secrets.TWILIO_AUTH_TOKEN }}" \
              SmsTargetChannelId="${{ vars.SMS_TARGET_CHANNEL_ID }}"
```

(Make sure the previous line — `GroqApiKey=...` — gets a trailing backslash since it's no longer the last line.)

- [ ] **Step 2: Update `.env.example`**

Append to `.env.example`:

```
TWILIO_AUTH_TOKEN=your-twilio-auth-token
SMS_TARGET_CHANNEL_ID=C0123456789
```

- [ ] **Step 3: README mention**

In `README.md`, under the `## Features` section, add a bullet:

```markdown
- **SMS reporting** via a Twilio number — same classifier/dedup pipeline, with a mirror posted to a configurable Slack channel
```

Under `## Setup`, after the existing `docs/aws-bootstrap.md` reference, add a sentence:

```markdown
SMS support is configured separately — see [`docs/superpowers/specs/2026-05-26-sms-inbound-design.md`](docs/superpowers/specs/2026-05-26-sms-inbound-design.md) for the Twilio setup steps.
```

In the env-vars table, add two new rows after `GROQ_API_KEY`:

```markdown
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token (Account Info) |
| `SMS_TARGET_CHANNEL_ID` | Slack channel ID for SMS mirror posts |
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml .env.example README.md
git commit -m "ci: pass Twilio auth token + SMS target channel to deploy"
```

---

## Task 8: Cutover (manual; record-only)

This is the runbook for the human operator. No code changes.

- [ ] **Step 1: Provision Twilio**

- Create Twilio account if needed.
- Buy a US local number (~$1.15/mo). Trial accounts work for testing with verified phone numbers.
- Copy the **Auth Token** from Account Info (not an API Key SID).

- [ ] **Step 2: Set GitHub secret + variable**

```bash
gh secret set TWILIO_AUTH_TOKEN --repo jonyen/fh-maintenance-bot   # paste at prompt
gh variable set SMS_TARGET_CHANNEL_ID --body "<test-channel-id>" --repo jonyen/fh-maintenance-bot
```

- [ ] **Step 3: Merge PR**

Merge the SMS PR to `main`. CI deploys. Wait for green.

- [ ] **Step 4: Read SmsFunctionUrl**

```bash
aws cloudformation describe-stacks \
  --stack-name fh-maintenance-bot \
  --query 'Stacks[0].Outputs[?OutputKey==`SmsFunctionUrl`].OutputValue' \
  --output text
```

- [ ] **Step 5: Configure Twilio webhook**

Twilio Console → Phone Numbers → Active Numbers → your number → Messaging Configuration:

- **A message comes in** → Webhook → HTTP POST → paste the `SmsFunctionUrl`
- Save

- [ ] **Step 6: Live test**

From a personal phone, text the Twilio number:

```
test - minor
```

Expected (within ~5s):
- Reply SMS confirming issue ID and severity
- New row in the Google Sheet
- Mirror message in the test Slack channel

- [ ] **Step 7: Switch SMS target to prod channel (when ready)**

```bash
gh variable set SMS_TARGET_CHANNEL_ID --body "<prod-channel-id>" --repo jonyen/fh-maintenance-bot
gh workflow run deploy.yml --repo jonyen/fh-maintenance-bot
```

Wait for redeploy. Test again.

---

## Out of Scope (deferred — same as spec)

- Two-way severity conversation
- MMS / attachments
- Outbound notifications on issue status changes
- Per-phone rate limiting
- A2P 10DLC brand registration (Twilio walks through; defer for personal/test traffic)
- STOP/UNSUBSCRIBE handling beyond Twilio's automatic compliance
