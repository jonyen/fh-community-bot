# Multi-Channel Slack Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the Slack handler to respond to events in multiple configured channels instead of a single channel.

**Architecture:** Replace the single `SLACK_CHANNEL_ID` env var with a comma-separated `SLACK_CHANNEL_IDS` list. Parse it into an array in config, pass it to the Slack handler, and change the channel filter from equality to `Array.includes`.

**Tech Stack:** Node.js (ES modules), vitest, AWS SAM.

---

### Task 1: Update config to parse comma-separated channel IDs

**Files:**
- Modify: `src/config.js`
- Modify: `tests/config.test.js`

- [ ] **Step 1: Update VALID_ENV in the test to use the new env var**

In `tests/config.test.js`, change `SLACK_CHANNEL_ID: "C123"` to `SLACK_CHANNEL_IDS: "C123"` in the `VALID_ENV` object (line 7).

- [ ] **Step 2: Update the existing "loads all required env vars" test**

In the same file, change this assertion (line 32):

```js
expect(config.slackChannelId).toBe("C123");
```

to:

```js
expect(config.slackChannelIds).toEqual(["C123"]);
```

- [ ] **Step 3: Add a test for comma-separated parsing with whitespace**

Add this test to the `describe("loadConfig", ...)` block in `tests/config.test.js`:

```js
it("parses SLACK_CHANNEL_IDS as a comma-separated list, trimming whitespace", async () => {
  Object.assign(process.env, VALID_ENV, {
    SLACK_CHANNEL_IDS: " C123 , C456,C789 ",
  });
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig();
  expect(config.slackChannelIds).toEqual(["C123", "C456", "C789"]);
});

it("parses a single channel ID into a one-element array", async () => {
  Object.assign(process.env, VALID_ENV, {
    SLACK_CHANNEL_IDS: "C999",
  });
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig();
  expect(config.slackChannelIds).toEqual(["C999"]);
});

it("drops empty entries from SLACK_CHANNEL_IDS", async () => {
  Object.assign(process.env, VALID_ENV, {
    SLACK_CHANNEL_IDS: "C123,,C456,",
  });
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig();
  expect(config.slackChannelIds).toEqual(["C123", "C456"]);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL — `config.slackChannelIds` is undefined (config still returns `slackChannelId`).

- [ ] **Step 5: Update src/config.js**

Replace `src/config.js` with:

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
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET || "",
    slackChannelIds: parseChannelIds(process.env.SLACK_CHANNEL_IDS),
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    groqApiKey: process.env.GROQ_API_KEY,
    dynamodbTable: process.env.DYNAMODB_TABLE || "",
    pinpointAppId: process.env.PINPOINT_APP_ID || "",
    pinpointNumber: process.env.PINPOINT_NUMBER || "",
    weeklyDigestCron: process.env.WEEKLY_DIGEST_CRON || "0 9 * * 1",
    timezone: process.env.TIMEZONE || "UTC",
  };
}
```

Key changes from the previous version:
- `SLACK_CHANNEL_ID` in the REQUIRED array replaced with `SLACK_CHANNEL_IDS`
- New `parseChannelIds` helper splits on commas, trims whitespace, drops empty entries
- Returned object has `slackChannelIds` (array) instead of `slackChannelId` (string)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.js`
Expected: PASS — all 9 config tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "parse SLACK_CHANNEL_IDS as comma-separated list"
```

---

### Task 2: Update Slack handler to accept multiple channel IDs

**Files:**
- Modify: `src/handlers/slack.js`
- Modify: `tests/handlers/slack.test.js`

- [ ] **Step 1: Update the test setup to pass `channelIds` instead of `channelId`**

In `tests/handlers/slack.test.js`, find every call to `createSlackHandler` (there are several in the `beforeEach` block and inside individual tests for close-by-ID and list commands). Change every occurrence of `channelId: "C123"` to `channelIds: ["C123"]`.

There are typically three spots:
1. The `beforeEach` block's default handler setup
2. The list-command test's re-initialized handler
3. The close-by-ID test's re-initialized handler

Example of the change (from the `beforeEach`):

```js
// Before:
handler = createSlackHandler({
  issueProcessor: mockProcessor,
  conversationService: mockConversation,
  slackClient: mockSlackClient,
  sheetsService: mockSheetsService,
  channelId: "C123",
  spreadsheetId: "sheet-id",
  signingSecret: "",
});

// After:
handler = createSlackHandler({
  issueProcessor: mockProcessor,
  conversationService: mockConversation,
  slackClient: mockSlackClient,
  sheetsService: mockSheetsService,
  channelIds: ["C123"],
  spreadsheetId: "sheet-id",
  signingSecret: "",
});
```

Do this for all three (or however many) spots where `createSlackHandler` is called in the test file.

- [ ] **Step 2: Add a test verifying multi-channel support**

Add this test to `tests/handlers/slack.test.js` inside the `describe("SlackHandler", ...)` block:

```js
it("processes events from any of multiple configured channels", async () => {
  handler = createSlackHandler({
    issueProcessor: mockProcessor,
    conversationService: mockConversation,
    slackClient: mockSlackClient,
    sheetsService: mockSheetsService,
    channelIds: ["C123", "C456"],
    spreadsheetId: "sheet-id",
    signingSecret: "",
  });

  // First channel
  await handler(makeSlackEvent({
    type: "app_mention",
    channel: "C123",
    text: "<@UBOT> lobby printer jammed",
    user: "U1",
    ts: "1",
  }));
  expect(mockProcessor.processNewReport).toHaveBeenCalledTimes(1);

  // Second channel
  await handler(makeSlackEvent({
    type: "app_mention",
    channel: "C456",
    text: "<@UBOT> water leak in bathroom",
    user: "U2",
    ts: "2",
  }));
  expect(mockProcessor.processNewReport).toHaveBeenCalledTimes(2);

  // Unconfigured channel — should be ignored
  mockProcessor.processNewReport.mockClear();
  await handler(makeSlackEvent({
    type: "app_mention",
    channel: "C999",
    text: "<@UBOT> something broke",
    user: "U3",
    ts: "3",
  }));
  expect(mockProcessor.processNewReport).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/handlers/slack.test.js`
Expected: Most existing tests FAIL because `channelIds` is now in the options but the handler still reads `channelId`. The new multi-channel test also FAILS.

- [ ] **Step 4: Update src/handlers/slack.js**

In `src/handlers/slack.js`, update the factory signature on line 29. Change:

```js
export function createSlackHandler({ issueProcessor, conversationService, slackClient, sheetsService, channelId, spreadsheetId, signingSecret }) {
```

to:

```js
export function createSlackHandler({ issueProcessor, conversationService, slackClient, sheetsService, channelIds, spreadsheetId, signingSecret }) {
```

Then find the channel filter check (around line 73):

```js
if (event.channel !== channelId || event.bot_id || event.subtype) {
```

and change it to:

```js
if (!channelIds.includes(event.channel) || event.bot_id || event.subtype) {
```

No other changes are needed in this file. The `channelIds` variable is only used in this single filter check.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/handlers/slack.test.js`
Expected: PASS — all Slack handler tests pass, including the new multi-channel test.

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: Same test counts as before this plan started, plus the new tests added in Tasks 1 and 2. The two pre-existing `generateDigest` failures in `groq.test.js` remain (unrelated).

- [ ] **Step 7: Commit**

```bash
git add src/handlers/slack.js tests/handlers/slack.test.js
git commit -m "Slack handler accepts multiple channel IDs"
```

---

### Task 3: Update Lambda entry point and SAM template

**Files:**
- Modify: `src/lambda/slack.js`
- Modify: `template.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Update src/lambda/slack.js**

Find the `createSlackHandler` call in `src/lambda/slack.js` and change `channelId: config.slackChannelId` to `channelIds: config.slackChannelIds`. The full block should look like:

```js
const handler = createSlackHandler({
  issueProcessor,
  conversationService,
  slackClient,
  sheetsService,
  channelIds: config.slackChannelIds,
  spreadsheetId: config.googleSheetId,
  signingSecret: config.slackSigningSecret,
});
```

- [ ] **Step 2: Update template.yaml**

In `template.yaml`, find the `SlackChannelId` parameter and rename it:

```yaml
# Before:
SlackChannelId:
  Type: String

# After:
SlackChannelIds:
  Type: String
  Description: Comma-separated list of Slack channel IDs
```

Then find the corresponding environment variable in the `Globals.Function.Environment.Variables` block:

```yaml
# Before:
SLACK_CHANNEL_ID: !Ref SlackChannelId

# After:
SLACK_CHANNEL_IDS: !Ref SlackChannelIds
```

- [ ] **Step 3: Update .env.example**

In `.env.example`, replace:

```
SLACK_CHANNEL_ID=C...
```

with:

```
SLACK_CHANNEL_IDS=C...,C...
```

- [ ] **Step 4: Run the full test suite to verify nothing regressed**

Run: `npx vitest run`
Expected: All tests pass except the pre-existing `generateDigest` failures in `groq.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/slack.js template.yaml .env.example
git commit -m "wire multi-channel Slack config through Lambda and SAM"
```

---

## Self-Review Notes

**Spec coverage:**
- Config change (SLACK_CHANNEL_ID → SLACK_CHANNEL_IDS, array parsing): Task 1 ✅
- Slack handler accepts array, uses includes: Task 2 ✅
- Lambda wiring: Task 3 ✅
- SAM template: Task 3 ✅
- Tests updated (config + handler): Tasks 1 and 2 ✅
- Multi-channel verification test: Task 2 ✅

**Placeholder scan:** No TBDs, TODOs, or vague instructions.

**Type consistency:** `slackChannelIds` is an array of strings everywhere. `channelIds` param in handler matches. `SLACK_CHANNEL_IDS` env var name consistent across config, SAM, and `.env.example`.

**Scope:** Tight. Three tasks, each small. No schema or infrastructure concerns beyond parameter rename.
