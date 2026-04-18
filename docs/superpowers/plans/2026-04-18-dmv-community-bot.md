# DMV Community Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate fh-maintenance-bot, gender-aliases, and ffx-bball-bot into a single monorepo (`dmv-community-bot`) with one Slack app, one SAM stack, and one deploy pipeline.

**Architecture:** Three Lambda functions — one shared Slack handler (routes events to maintenance, gender-aliases, or basketball features), one SMS handler (Pinpoint/SNS), one scheduled basketball post (EventBridge). DynamoDB for conversation state and gender cache. Shared Google Sheets OAuth2 credentials. Single GitHub Actions deploy workflow.

**Tech Stack:** Node.js 20+ (ES modules), AWS SAM, Lambda, API Gateway, DynamoDB, EventBridge Scheduler, Amazon Pinpoint, SNS, Google Sheets API, Groq API, NOAA Weather API, vitest.

**Source repos (for porting):**
- Maintenance: `/Users/jyen/Projects/fh-maintenance-bot/src/` (current repo, `feature/github-actions-deploy` branch)
- Basketball: `/Users/jyen/Projects/ffx-bball-bot/src/`
- Gender-aliases: `/Users/jyen/Projects/gender-aliases/app.py`

---

## Phase 1: Repo Scaffolding + Shared Modules

### Task 1: Create new repo and project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create the repo on GitHub and clone it**

```bash
cd /Users/jyen/Projects
gh repo create jonyen/dmv-community-bot --private --clone
cd dmv-community-bot
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "dmv-community-bot",
  "version": "1.0.0",
  "description": "Community bot — maintenance issues, gender aliases, basketball roll-call",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "deploy": "bash scripts/deploy.sh"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.0.0",
    "@aws-sdk/client-pinpoint": "^3.0.0",
    "@aws-sdk/client-scheduler": "^3.0.0",
    "@aws-sdk/lib-dynamodb": "^3.0.0",
    "googleapis": "^171.4.0",
    "openai": "^6.33.0"
  },
  "devDependencies": {
    "vitest": "^4.1.3"
  }
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.aws-sam/
.env
coverage/
*.log
.DS_Store
```

- [ ] **Step 4: Create .env.example**

```
# Shared
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_BOT_USER_ID=U...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
DYNAMODB_TABLE=dmv-community-bot-conversations

# Maintenance
MAINTENANCE_CHANNEL_IDS=C...,C...
MAINTENANCE_SHEET_ID=...
GROQ_API_KEY=gsk_...
PINPOINT_APP_ID=...
PINPOINT_NUMBER=+1...

# Gender Aliases
GENDER_SHEET_ID=...

# Basketball
BBALL_CHANNELS=C...
SCHEDULE_NAME=...
SCHEDULE_GROUP=default
```

- [ ] **Step 5: Create directory structure**

```bash
mkdir -p src/{handlers,features/{maintenance,gender-aliases,basketball},shared,services,lambda}
mkdir -p tests/{handlers,features/{maintenance,gender-aliases,basketball},shared,services}
mkdir -p scripts docs .github/workflows
```

- [ ] **Step 6: Install dependencies**

```bash
npm install
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "initial project scaffolding"
```

---

### Task 2: Create shared config module

**Files:**
- Create: `src/shared/config.js`
- Create: `tests/shared/config.test.js`

- [ ] **Step 1: Write the tests**

Create `tests/shared/config.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const VALID_ENV = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    SLACK_BOT_USER_ID: "UBOT123",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
    DYNAMODB_TABLE: "test-table",
    MAINTENANCE_CHANNEL_IDS: "C123,C456",
    MAINTENANCE_SHEET_ID: "sheet-maint",
    GROQ_API_KEY: "gsk_test",
    GENDER_SHEET_ID: "sheet-gender",
    BBALL_CHANNELS: "C789",
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
    const { loadConfig } = await import("../../src/shared/config.js");
    const config = loadConfig();
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.slackSigningSecret).toBe("test-signing-secret");
    expect(config.slackBotUserId).toBe("UBOT123");
    expect(config.maintenanceChannelIds).toEqual(["C123", "C456"]);
    expect(config.maintenanceSheetId).toBe("sheet-maint");
    expect(config.genderSheetId).toBe("sheet-gender");
    expect(config.bballChannels).toEqual(["C789"]);
  });

  it("parses comma-separated channel IDs with whitespace", async () => {
    Object.assign(process.env, VALID_ENV, {
      MAINTENANCE_CHANNEL_IDS: " C123 , C456 ",
      BBALL_CHANNELS: "C789, C012",
    });
    const { loadConfig } = await import("../../src/shared/config.js");
    const config = loadConfig();
    expect(config.maintenanceChannelIds).toEqual(["C123", "C456"]);
    expect(config.bballChannels).toEqual(["C789", "C012"]);
  });

  it("throws if a required var is missing", async () => {
    process.env = { ...originalEnv };
    const { loadConfig } = await import("../../src/shared/config.js");
    expect(() => loadConfig()).toThrow("Missing required environment variable");
  });

  it("defaults optional vars to empty string", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig } = await import("../../src/shared/config.js");
    const config = loadConfig();
    expect(config.pinpointAppId).toBe("");
    expect(config.pinpointNumber).toBe("");
    expect(config.scheduleName).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

Run: `npx vitest run tests/shared/config.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement config**

Create `src/shared/config.js`:

```js
const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_USER_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "DYNAMODB_TABLE",
  "MAINTENANCE_CHANNEL_IDS",
  "MAINTENANCE_SHEET_ID",
  "GROQ_API_KEY",
  "GENDER_SHEET_ID",
  "BBALL_CHANNELS",
];

function parseList(raw) {
  return (raw || "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    // Shared
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackBotUserId: process.env.SLACK_BOT_USER_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    dynamodbTable: process.env.DYNAMODB_TABLE,

    // Maintenance
    maintenanceChannelIds: parseList(process.env.MAINTENANCE_CHANNEL_IDS),
    maintenanceSheetId: process.env.MAINTENANCE_SHEET_ID,
    groqApiKey: process.env.GROQ_API_KEY,
    pinpointAppId: process.env.PINPOINT_APP_ID || "",
    pinpointNumber: process.env.PINPOINT_NUMBER || "",

    // Gender Aliases
    genderSheetId: process.env.GENDER_SHEET_ID,

    // Basketball
    bballChannels: parseList(process.env.BBALL_CHANNELS),
    scheduleName: process.env.SCHEDULE_NAME || "",
    scheduleGroup: process.env.SCHEDULE_GROUP || "default",
    gitSha: process.env.GIT_SHA || "unknown",
    githubRunNumber: process.env.GITHUB_RUN_NUMBER || "unknown",
  };
}
```

- [ ] **Step 4: Run tests to see them pass**

Run: `npx vitest run tests/shared/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/config.js tests/shared/config.test.js
git commit -m "add shared config module"
```

---

### Task 3: Port shared Slack API helpers and signature verification

**Files:**
- Create: `src/shared/slack.js` — port from `/Users/jyen/Projects/ffx-bball-bot/src/shared/slack.js`
- Create: `src/shared/verify-signature.js` — port from `/Users/jyen/Projects/ffx-bball-bot/src/reactionHandler/verifySignature.js`
- Create: `tests/shared/verify-signature.test.js`

- [ ] **Step 1: Port `src/shared/slack.js`**

Copy `/Users/jyen/Projects/ffx-bball-bot/src/shared/slack.js` to `src/shared/slack.js`. Then add `getConversationMembers` for gender-aliases:

```js
export async function getConversationMembers({ token, channel }) {
  const members = [];
  let cursor;
  do {
    const params = { channel, limit: "200" };
    if (cursor) params.cursor = cursor;
    const data = await callGet("conversations.members", token, params);
    members.push(...(data.members || []));
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);
  return members;
}
```

Add this function to the existing file after the other exported functions. No other changes needed — the file is used as-is.

- [ ] **Step 2: Port `src/shared/verify-signature.js`**

Copy `/Users/jyen/Projects/ffx-bball-bot/src/reactionHandler/verifySignature.js` to `src/shared/verify-signature.js`. No changes needed — the file is self-contained.

- [ ] **Step 3: Port the signature verification tests**

Copy `/Users/jyen/Projects/ffx-bball-bot/test/verifySignature.test.js` to `tests/shared/verify-signature.test.js`. Update the import path:

```js
// Change from:
import { verifySignature } from '../src/reactionHandler/verifySignature.js';
// To:
import { verifySignature } from '../../src/shared/verify-signature.js';
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/shared/verify-signature.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/slack.js src/shared/verify-signature.js tests/shared/verify-signature.test.js
git commit -m "add shared Slack API helpers and signature verification"
```

---

### Task 4: Port DynamoDB conversation service

**Files:**
- Create: `src/services/conversation.js` — port from current repo
- Create: `tests/services/conversation.test.js` — port from current repo

- [ ] **Step 1: Copy conversation service and tests**

Copy from the current repo (feature/github-actions-deploy branch):
- `src/services/conversation.js` → `src/services/conversation.js` (no changes)
- `tests/services/conversation.test.js` → `tests/services/conversation.test.js` (no changes)

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/services/conversation.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/conversation.js tests/services/conversation.test.js
git commit -m "add DynamoDB conversation service"
```

---

### Task 5: Port Google Sheets and Groq services

**Files:**
- Create: `src/services/sheets.js` — port from current repo
- Create: `src/services/groq.js` — port from current repo
- Create: `src/services/pinpoint.js` — port from current repo
- Create: `tests/services/sheets.test.js`
- Create: `tests/services/groq.test.js`
- Create: `tests/services/pinpoint.test.js`

- [ ] **Step 1: Copy all service files and their tests**

From the current repo (feature/github-actions-deploy branch):
- `src/services/sheets.js` → `src/services/sheets.js` (no changes)
- `src/services/groq.js` → `src/services/groq.js` (no changes)
- `src/services/pinpoint.js` → `src/services/pinpoint.js` (no changes)
- `tests/services/sheets.test.js` → `tests/services/sheets.test.js` (no changes)
- `tests/services/groq.test.js` → `tests/services/groq.test.js` (no changes — the orphaned generateDigest tests were already removed)
- `tests/services/pinpoint.test.js` → `tests/services/pinpoint.test.js` (no changes)

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/services/`
Expected: All service tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/ tests/services/
git commit -m "add Google Sheets, Groq, and Pinpoint services"
```

---

## Phase 2: Port Maintenance Feature

### Task 6: Port maintenance core logic

**Files:**
- Create: `src/features/maintenance/issue-processor.js` — port from `src/core/issue-processor.js`
- Create: `src/features/maintenance/dedup.js` — port from `src/services/dedup.js`
- Create: `tests/features/maintenance/issue-processor.test.js`
- Create: `tests/features/maintenance/dedup.test.js`

- [ ] **Step 1: Copy issue-processor**

Copy `src/core/issue-processor.js` to `src/features/maintenance/issue-processor.js`. No changes needed — it depends only on injected services.

- [ ] **Step 2: Copy dedup service**

Copy `src/services/dedup.js` to `src/features/maintenance/dedup.js`. No changes needed.

- [ ] **Step 3: Copy tests and update import paths**

Copy `tests/core/issue-processor.test.js` to `tests/features/maintenance/issue-processor.test.js`. Update import:

```js
// Change from:
import { createIssueProcessor } from "../../src/core/issue-processor.js";
// To:
import { createIssueProcessor } from "../../../src/features/maintenance/issue-processor.js";
```

Copy `tests/services/dedup.test.js` to `tests/features/maintenance/dedup.test.js`. Update import:

```js
// Change from:
import { createDedupService } from "../../src/services/dedup.js";
// To:
import { createDedupService } from "../../../src/features/maintenance/dedup.js";
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/features/maintenance/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/maintenance/ tests/features/maintenance/
git commit -m "port maintenance core logic (issue processor + dedup)"
```

---

### Task 7: Port maintenance Slack mention handler

**Files:**
- Create: `src/features/maintenance/mention.js` — extracted from `src/handlers/slack.js`

The current Slack handler mixes routing logic with maintenance-specific Slack behavior (list command, close command, note appending, duplicate reply formatting). Extract the maintenance-specific parts into `mention.js` so the shared router can delegate to it.

- [ ] **Step 1: Create `src/features/maintenance/mention.js`**

This module exports `createMaintenanceHandler({ issueProcessor, conversationService, sheetsService, maintenanceChannelIds, spreadsheetId })` which returns an object with methods:

- `isMaintenanceChannel(channelId)` — returns true if channel is in maintenanceChannelIds
- `handleMention({ event, token })` — processes an app_mention event
- `handleThreadReply({ event, token })` — processes a thread reply in a maintenance conversation
- `isMaintenanceThread({ event })` — checks if a message is a thread reply in a tracked conversation

Read the current `src/handlers/slack.js` from this repo to understand the full set of Slack-specific behaviors (list, close by ID, close by description with keyword overlap, create new prefix, severity flow, note appending, CC for medium/critical). All of these need to be in `mention.js`, using the shared `slack.js` helpers (`postMessage`) instead of `slackClient.chat.postMessage`.

Key differences from the current slack handler:
- Uses `postMessage({ token, channel, text })` from `src/shared/slack.js` instead of `slackClient.chat.postMessage`
- Uses `getUserInfo({ token, userId })` from shared slack.js instead of `slackClient.users.info`
- Uses `addReaction({ token, channel, timestamp, name })` — add this helper to `src/shared/slack.js` as well
- Accepts `token` as a parameter rather than having a `slackClient` dependency
- Does NOT do signature verification or URL challenge handling — that's the router's job

- [ ] **Step 2: Write tests for the maintenance mention handler**

Create `tests/features/maintenance/mention.test.js` covering:
- Ignores events outside maintenance channels
- Processes app_mention as new issue report
- Handles severity reply in thread
- Lists open issues
- Closes issue by ID
- Appends thread replies as notes
- Returns not_maintenance reply
- CC for medium/critical

Mock `issueProcessor`, `conversationService`, `sheetsService`, and the shared `slack.js` module.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/features/maintenance/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/maintenance/mention.js tests/features/maintenance/mention.test.js src/shared/slack.js
git commit -m "port maintenance Slack mention handler"
```

---

### Task 8: Port SMS handler

**Files:**
- Create: `src/handlers/sms.js` — port from current repo
- Create: `tests/handlers/sms.test.js` — port from current repo

- [ ] **Step 1: Copy SMS handler and tests**

Copy from the current repo:
- `src/handlers/sms.js` → `src/handlers/sms.js` (no changes)
- `tests/handlers/sms.test.js` → `tests/handlers/sms.test.js` (no changes)

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/handlers/sms.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/handlers/sms.js tests/handlers/sms.test.js
git commit -m "port SMS handler"
```

---

## Phase 3: Port Basketball Feature

### Task 9: Port basketball shared modules

**Files:**
- Create: `src/features/basketball/categorize.js` — port from ffx-bball-bot
- Create: `src/features/basketball/format-message.js` — port from ffx-bball-bot
- Create: `src/features/basketball/weather.js` — port from ffx-bball-bot
- Create: `src/features/basketball/schedule-parser.js` — port from ffx-bball-bot
- Create: `tests/features/basketball/categorize.test.js`
- Create: `tests/features/basketball/format-message.test.js`
- Create: `tests/features/basketball/schedule-parser.test.js`

- [ ] **Step 1: Copy basketball modules**

From `/Users/jyen/Projects/ffx-bball-bot/src/`:
- `reactionHandler/categorize.js` → `src/features/basketball/categorize.js` (no changes)
- `shared/formatMessage.js` → `src/features/basketball/format-message.js` (no changes)
- `postMessage/weather.js` → `src/features/basketball/weather.js` (no changes)
- `shared/scheduleParser.js` → `src/features/basketball/schedule-parser.js` (no changes)

- [ ] **Step 2: Copy tests and update import paths**

From `/Users/jyen/Projects/ffx-bball-bot/test/`:
- `categorize.test.js` → `tests/features/basketball/categorize.test.js`
  - Change import: `'../src/reactionHandler/categorize.js'` → `'../../../src/features/basketball/categorize.js'`
- `formatMessage.test.js` → `tests/features/basketball/format-message.test.js`
  - Change import: `'../src/shared/formatMessage.js'` → `'../../../src/features/basketball/format-message.js'`
- `scheduleParser.test.js` → `tests/features/basketball/schedule-parser.test.js`
  - Change import: `'../src/shared/scheduleParser.js'` → `'../../../src/features/basketball/schedule-parser.js'`

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/features/basketball/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/basketball/ tests/features/basketball/
git commit -m "port basketball shared modules (categorize, format, weather, schedule-parser)"
```

---

### Task 10: Port basketball feature handlers

**Files:**
- Create: `src/features/basketball/post-rollcall.js` — port from ffx-bball-bot's `postMessage/handler.js`
- Create: `src/features/basketball/reactions.js` — port from ffx-bball-bot's `reactionHandler/handler.js`
- Create: `src/features/basketball/slash-command.js` — port from ffx-bball-bot's `slashCommand/handler.js`
- Create: `src/shared/scheduler.js` — port from ffx-bball-bot's `shared/scheduler.js`

- [ ] **Step 1: Port scheduler module**

Copy `/Users/jyen/Projects/ffx-bball-bot/src/shared/scheduler.js` to `src/shared/scheduler.js`. No changes needed.

- [ ] **Step 2: Port post-rollcall**

Copy `/Users/jyen/Projects/ffx-bball-bot/src/postMessage/handler.js` to `src/features/basketball/post-rollcall.js`. Update imports:

```js
// Change from:
import { fetchWeather } from './weather.js';
import { formatMessage } from '../shared/formatMessage.js';
import { postMessage, notifyFailure, parseChannels } from '../shared/slack.js';

// To:
import { fetchWeather } from './weather.js';
import { formatMessage } from './format-message.js';
import { postMessage, notifyFailure, parseChannels } from '../../shared/slack.js';
```

- [ ] **Step 3: Port reactions handler**

Copy `/Users/jyen/Projects/ffx-bball-bot/src/reactionHandler/handler.js` to `src/features/basketball/reactions.js`. This file needs to be refactored from a standalone Lambda handler into a feature handler that the shared Slack router calls.

The current file does its own signature verification and JSON parsing. In the new architecture, the shared Slack router handles those. The reactions handler should export a function like:

```js
export async function handleReaction({ event, token, botUserId }) {
  // ... existing logic from the handler, minus signature verification and JSON parsing
}
```

Read the source file, extract the logic after signature verification, and adapt it. It should:
- Accept `{ event, token, botUserId }` instead of `(event)` (API Gateway event)
- Use `event` (the Slack event object, not the API Gateway event)
- Return nothing (posts directly via slack.js helpers)
- Import `categorize` from `./categorize.js`, `formatMessage/parseWeatherLine/parseHeader` from `./format-message.js`, and slack helpers from `../../shared/slack.js`

- [ ] **Step 4: Port slash-command handler**

Copy `/Users/jyen/Projects/ffx-bball-bot/src/slashCommand/handler.js` to `src/features/basketball/slash-command.js`. Similar refactoring — extract from standalone Lambda handler into a feature handler:

```js
export async function handleSlashCommand({ params, token, botUserId, config }) {
  // params = parsed URLSearchParams from the slash command body
  // config = { scheduleName, scheduleGroup, gitSha, githubRunNumber }
}
```

Update imports:
- `verifySignature` → remove (handled by router)
- `categorize` → `./categorize.js`
- `fetchWeather` → `./weather.js`
- `formatMessage` → `./format-message.js`
- Slack helpers → `../../shared/slack.js`
- Scheduler → `../../shared/scheduler.js`
- `parseScheduleInput` → `./schedule-parser.js`

- [ ] **Step 5: Write tests for the adapted handlers**

Create minimal integration tests for `reactions.js` and `slash-command.js` verifying the routing works (mock all external calls). The detailed logic tests are already covered by the unit tests ported in Task 9.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/features/basketball/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/features/basketball/ src/shared/scheduler.js tests/features/basketball/
git commit -m "port basketball feature handlers (post, reactions, slash-command)"
```

---

## Phase 4: Rewrite Gender-Aliases

### Task 11: Implement gender-aliases feature

**Files:**
- Create: `src/features/gender-aliases/aliases.js`
- Create: `src/features/gender-aliases/sheet-cache.js`
- Create: `tests/features/gender-aliases/aliases.test.js`
- Create: `tests/features/gender-aliases/sheet-cache.test.js`

- [ ] **Step 1: Write tests for sheet-cache**

Create `tests/features/gender-aliases/sheet-cache.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderCache } from "../../../src/features/gender-aliases/sheet-cache.js";

describe("GenderCache", () => {
  let mockSheetsClient;
  let mockConversationService;
  let cache;

  beforeEach(() => {
    mockSheetsClient = {
      spreadsheets: {
        values: {
          get: vi.fn().mockResolvedValue({
            data: {
              values: [
                ["U001", "male"],
                ["U002", "female"],
                ["U003", "Male"],
                ["U004", "FEMALE"],
                ["U005"],  // missing gender — skip
              ],
            },
          }),
        },
      },
    };
    mockConversationService = {
      getConversation: vi.fn().mockResolvedValue(null),
      saveConversation: vi.fn().mockResolvedValue({}),
    };
    cache = createGenderCache({
      sheetsClient: mockSheetsClient,
      sheetId: "test-sheet-id",
      conversationService: mockConversationService,
      cacheTtlSeconds: 604800, // 7 days
    });
  });

  it("fetches genders from sheet and normalizes to lowercase", async () => {
    const genders = await cache.getGenders();
    expect(genders).toEqual({
      U001: "male",
      U002: "female",
      U003: "male",
      U004: "female",
    });
  });

  it("caches result in DynamoDB", async () => {
    await cache.getGenders();
    expect(mockConversationService.saveConversation).toHaveBeenCalledWith(
      "CACHE#gender-aliases",
      expect.objectContaining({
        data: expect.any(Object),
        fetchedAt: expect.any(Number),
      })
    );
  });

  it("returns cached data when not stale", async () => {
    mockConversationService.getConversation.mockResolvedValue({
      data: { U001: "male", U002: "female" },
      fetchedAt: Date.now() / 1000,
    });

    const genders = await cache.getGenders();
    expect(genders).toEqual({ U001: "male", U002: "female" });
    expect(mockSheetsClient.spreadsheets.values.get).not.toHaveBeenCalled();
  });

  it("refreshes cache when stale", async () => {
    mockConversationService.getConversation.mockResolvedValue({
      data: { U001: "male" },
      fetchedAt: (Date.now() / 1000) - 700000, // older than 7 days
    });

    const genders = await cache.getGenders();
    expect(mockSheetsClient.spreadsheets.values.get).toHaveBeenCalled();
    expect(genders).toEqual({ U001: "male", U002: "female", U003: "male", U004: "female" });
  });

  it("force refresh bypasses cache", async () => {
    mockConversationService.getConversation.mockResolvedValue({
      data: { U001: "male" },
      fetchedAt: Date.now() / 1000,
    });

    const genders = await cache.getGenders({ forceRefresh: true });
    expect(mockSheetsClient.spreadsheets.values.get).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement sheet-cache**

Create `src/features/gender-aliases/sheet-cache.js`:

```js
const CACHE_KEY = "CACHE#gender-aliases";
const SHEET_RANGE = "A2:B";
const VALID_GENDERS = new Set(["male", "female"]);

export function createGenderCache({ sheetsClient, sheetId, conversationService, cacheTtlSeconds = 604800 }) {
  async function fetchFromSheet() {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: SHEET_RANGE,
    });
    const rows = res.data.values || [];
    const genders = {};
    for (const row of rows) {
      if (row.length < 2) continue;
      const userId = row[0];
      const gender = row[1].toLowerCase();
      if (VALID_GENDERS.has(gender)) {
        genders[userId] = gender;
      }
    }
    return genders;
  }

  async function getGenders({ forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = await conversationService.getConversation(CACHE_KEY);
      if (cached && cached.fetchedAt) {
        const ageSeconds = (Date.now() / 1000) - cached.fetchedAt;
        if (ageSeconds < cacheTtlSeconds) {
          return cached.data;
        }
      }
    }

    const data = await fetchFromSheet();
    await conversationService.saveConversation(CACHE_KEY, {
      data,
      fetchedAt: Date.now() / 1000,
    });
    return data;
  }

  return { getGenders };
}
```

- [ ] **Step 3: Write tests for aliases handler**

Create `tests/features/gender-aliases/aliases.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAliasesHandler } from "../../../src/features/gender-aliases/aliases.js";

describe("AliasesHandler", () => {
  let mockCache;
  let mockSlack;
  let handler;

  beforeEach(() => {
    mockCache = {
      getGenders: vi.fn().mockResolvedValue({
        U001: "male",
        U002: "male",
        U003: "female",
        U004: "female",
      }),
    };
    mockSlack = {
      postMessage: vi.fn().mockResolvedValue({}),
      getConversationMembers: vi.fn().mockResolvedValue(["U001", "U002", "U003", "U004", "U005"]),
    };
    handler = createAliasesHandler({ genderCache: mockCache, slack: mockSlack });
  });

  it("detects !bros trigger and pings male members", async () => {
    await handler.handle({
      text: "hey !bros let's go",
      channel: "C123",
      user: "U999",
      token: "xoxb-test",
    });

    expect(mockSlack.postMessage).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "C123",
      text: expect.stringContaining("<@U001>"),
    });
    expect(mockSlack.postMessage).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "C123",
      text: expect.stringContaining("<@U002>"),
    });
  });

  it("detects @sis trigger and pings female members", async () => {
    await handler.handle({
      text: "@sis dinner tonight?",
      channel: "C123",
      user: "U999",
      token: "xoxb-test",
    });

    expect(mockSlack.postMessage).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "C123",
      text: expect.stringContaining("<@U003>"),
    });
  });

  it("returns false when no trigger word found", () => {
    expect(handler.hasTrigger("just a normal message")).toBe(false);
    expect(handler.hasTrigger("hey brothers in arms")).toBe(false); // no ! or @ prefix
  });

  it("returns true for valid trigger words", () => {
    expect(handler.hasTrigger("!bros")).toBe(true);
    expect(handler.hasTrigger("@sisters")).toBe(true);
    expect(handler.hasTrigger("hey !brothers lets go")).toBe(true);
    expect(handler.hasTrigger("@sis dinner?")).toBe(true);
  });

  it("handles refresh trigger", async () => {
    await handler.handleRefresh({ channel: "C123", token: "xoxb-test" });
    expect(mockCache.getGenders).toHaveBeenCalledWith({ forceRefresh: true });
    expect(mockSlack.postMessage).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "C123",
      text: expect.stringContaining("Refreshed"),
    });
  });

  it("detects refresh trigger word", () => {
    expect(handler.isRefreshTrigger("!refresh-genders")).toBe(true);
    expect(handler.isRefreshTrigger("@refresh-genders")).toBe(true);
    expect(handler.isRefreshTrigger("hello")).toBe(false);
  });

  it("responds with no-members message when none match", async () => {
    mockSlack.getConversationMembers.mockResolvedValue(["U005", "U006"]);

    await handler.handle({
      text: "!bros",
      channel: "C123",
      user: "U999",
      token: "xoxb-test",
    });

    expect(mockSlack.postMessage).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "C123",
      text: expect.stringContaining("No male members"),
    });
  });
});
```

- [ ] **Step 4: Implement aliases handler**

Create `src/features/gender-aliases/aliases.js`:

```js
const TRIGGER_RE = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/i;
const REFRESH_RE = /(?:^|\s)[!@]refresh-genders\b/i;

const GENDER_MAP = {
  bros: "male",
  brothers: "male",
  sis: "female",
  sisters: "female",
};

export function createAliasesHandler({ genderCache, slack }) {
  function hasTrigger(text) {
    return TRIGGER_RE.test(text);
  }

  function isRefreshTrigger(text) {
    return REFRESH_RE.test(text);
  }

  async function handle({ text, channel, user, token }) {
    const match = text.match(TRIGGER_RE);
    if (!match) return;

    const triggerWord = match[1].toLowerCase();
    const targetGender = GENDER_MAP[triggerWord];
    if (!targetGender) return;

    const genders = await genderCache.getGenders();
    const members = await slack.getConversationMembers({ token, channel });
    const targets = members.filter((u) => genders[u] === targetGender);

    if (targets.length === 0) {
      await slack.postMessage({
        token,
        channel,
        text: `No ${targetGender} members configured for this channel.`,
      });
      return;
    }

    const mentions = targets.map((u) => `<@${u}>`).join(", ");
    await slack.postMessage({
      token,
      channel,
      text: `<@${user}> pinged ${targetGender}s: ${mentions}`,
    });
  }

  async function handleRefresh({ channel, token }) {
    const genders = await genderCache.getGenders({ forceRefresh: true });
    const count = Object.keys(genders).length;
    await slack.postMessage({
      token,
      channel,
      text: `Refreshed gender data. ${count} members loaded.`,
    });
  }

  return { hasTrigger, isRefreshTrigger, handle, handleRefresh };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/features/gender-aliases/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/features/gender-aliases/ tests/features/gender-aliases/
git commit -m "implement gender-aliases feature (rewrite from Python)"
```

---

## Phase 5: Unified Slack Router

### Task 12: Build the shared Slack event router

**Files:**
- Create: `src/handlers/slack.js`
- Create: `tests/handlers/slack.test.js`

- [ ] **Step 1: Write router tests**

Create `tests/handlers/slack.test.js` covering:
- URL verification challenge → returns challenge
- Invalid signature → returns 401
- Slash command `/ball` → routes to basketball slash-command handler
- `reaction_added` event → routes to basketball reactions handler
- `app_mention` in maintenance channel → routes to maintenance handler
- Message with trigger word (`!bros`) → routes to gender-aliases handler
- Message in maintenance thread → routes to maintenance thread reply handler
- Message with no matching route → returns 200 ok (ignored)
- Bot messages → ignored

Mock all feature handlers and verify routing only (not feature logic).

- [ ] **Step 2: Implement the router**

Create `src/handlers/slack.js`. The handler:

1. Parses the raw body (JSON for events, URL-encoded for slash commands)
2. Verifies Slack signature (shared `verify-signature.js`)
3. Routes to the appropriate feature handler based on event type:
   - Slash commands: detected by `body.command`
   - URL verification: `body.type === "url_verification"`
   - Events: `body.type === "event_callback"` → route by `event.type`

```js
export function createSlackRouter({
  maintenanceHandler,
  aliasesHandler,
  basketballReactions,
  basketballSlashCommand,
  config,
}) {
  return async function handleSlackEvent(apiGatewayEvent) {
    const rawBody = apiGatewayEvent.body ?? "";
    const signature = apiGatewayEvent.headers?.["x-slack-signature"];
    const timestamp = apiGatewayEvent.headers?.["x-slack-request-timestamp"];

    if (!verifySignature({ body: rawBody, timestamp, signature, secret: config.slackSigningSecret })) {
      return { statusCode: 401, body: "invalid signature" };
    }

    // Slash commands are URL-encoded
    if (rawBody.includes("command=")) {
      const params = new URLSearchParams(rawBody);
      if (params.get("command") === "/ball") {
        return basketballSlashCommand.handle({ params, ... });
      }
      return { statusCode: 200, body: "ok" };
    }

    // Events are JSON
    const body = JSON.parse(rawBody);

    if (body.type === "url_verification") {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: body.challenge }) };
    }

    if (body.type !== "event_callback") return ok();

    const event = body.event;
    const token = config.slackBotToken;

    // Route by event type
    if (event.type === "reaction_added" || event.type === "reaction_removed") {
      await basketballReactions.handle({ event, token, botUserId: config.slackBotUserId });
      return ok();
    }

    if (event.type === "app_mention" && maintenanceHandler.isMaintenanceChannel(event.channel)) {
      await maintenanceHandler.handleMention({ event, token });
      return ok();
    }

    if (event.type === "message" && !event.bot_id && !event.subtype) {
      const text = event.text || "";

      if (aliasesHandler.isRefreshTrigger(text)) {
        await aliasesHandler.handleRefresh({ channel: event.channel, token });
        return ok();
      }

      if (aliasesHandler.hasTrigger(text)) {
        await aliasesHandler.handle({ text, channel: event.channel, user: event.user, token });
        return ok();
      }

      if (maintenanceHandler.isMaintenanceThread && await maintenanceHandler.isMaintenanceThread({ event })) {
        await maintenanceHandler.handleThreadReply({ event, token });
        return ok();
      }
    }

    return ok();
  };
}

function ok() { return { statusCode: 200, body: "ok" }; }
```

This is pseudocode — the actual implementation should follow the routing spec exactly. The subagent should read the spec at `docs/superpowers/specs/2026-04-18-dmv-community-bot-design.md` for the complete routing logic.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/handlers/slack.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/handlers/slack.js tests/handlers/slack.test.js
git commit -m "add unified Slack event router"
```

---

## Phase 6: Lambda Entry Points + SAM

### Task 13: Create Lambda entry points

**Files:**
- Create: `src/lambda/slack.js`
- Create: `src/lambda/sms.js`
- Create: `src/lambda/bball-post.js`

These are wiring-only files. No tests needed.

- [ ] **Step 1: Create `src/lambda/slack.js`**

Wire up: config → Google Sheets client → conversation service → all feature handlers → Slack router. Export the handler.

Dependencies to initialize:
- DynamoDB doc client
- Google Sheets client (OAuth2)
- Groq client
- ConversationService
- SheetsService (for maintenance)
- GroqService
- DedupService
- IssueProcessor
- GenderCache (using SheetsClient + ConversationService)
- MaintenanceHandler
- AliasesHandler
- Basketball reactions + slash-command handlers
- SlackRouter

- [ ] **Step 2: Create `src/lambda/sms.js`**

Wire up: config → DynamoDB → Sheets → Groq → Dedup → Conversation → IssueProcessor → Pinpoint → SmsHandler. Same pattern as the current repo's `src/lambda/sms.js`.

- [ ] **Step 3: Create `src/lambda/bball-post.js`**

Wire up: config → basketball post-rollcall handler. Minimal — just imports config and calls the post function.

```js
import { loadConfig } from "../shared/config.js";
import { handler as postHandler } from "../features/basketball/post-rollcall.js";

const config = loadConfig();
// post-rollcall reads SLACK_BOT_TOKEN and SLACK_CHANNELS from env directly
export const handler = postHandler;
```

- [ ] **Step 4: Commit**

```bash
git add src/lambda/
git commit -m "add Lambda entry points"
```

---

### Task 14: Create SAM template

**Files:**
- Create: `template.yaml`
- Create: `samconfig.toml`

- [ ] **Step 1: Create `template.yaml`**

Build the SAM template with:

**Parameters:** SlackBotToken, SlackSigningSecret, SlackBotUserId, GoogleClientId, GoogleClientSecret, GoogleRefreshToken, GroqApiKey, MaintenanceChannelIds, MaintenanceSheetId, GenderSheetId, BballChannels, PinpointAppId, PinpointNumber, ScheduleExpression (default: `cron(0 8 ? * TUE,THU *)`), GitSha, GithubRunNumber

**Globals.Function.Environment.Variables:** All the above mapped to env var names.

**Resources:**
- ConversationsTable (DynamoDB, PAY_PER_REQUEST, TTL on `ttl` attribute)
- SlackFunction (handler: `src/lambda/slack.handler`, events: HttpApi POST /slack/events and POST /slack/commands, policies: DynamoDB CRUD + Scheduler get/update + IAM PassRole)
- SmsFunction (handler: `src/lambda/sms.handler`, event: SNS SmsTopic, policies: DynamoDB CRUD + Pinpoint SendMessages)
- BballPostFunction (handler: `src/lambda/bball-post.handler`, no events — triggered by schedule)
- PostScheduleRole (IAM role for EventBridge → invoke BballPostFunction)
- PostSchedule (EventBridge Scheduler, ScheduleExpression param, timezone America/New_York, target: BballPostFunction ARN with PostScheduleRole)
- SmsTopic (SNS)

**Outputs:** SlackEventsUrl, SlackCommandsUrl, SmsTopicArn

- [ ] **Step 2: Create `samconfig.toml`**

```toml
version = 0.1

[default.deploy.parameters]
stack_name = "dmv-community-bot"
resolve_s3 = true
capabilities = "CAPABILITY_IAM"
confirm_changeset = true
```

- [ ] **Step 3: Commit**

```bash
git add template.yaml samconfig.toml
git commit -m "add SAM template"
```

---

## Phase 7: Deploy Pipeline

### Task 15: Create deploy script and GitHub Actions workflow

**Files:**
- Create: `scripts/deploy.sh` — port from ffx-bball-bot (preserves live schedule)
- Create: `.github/workflows/deploy.yml`
- Create: `docs/deployment.md`

- [ ] **Step 1: Port deploy script**

Copy `/Users/jyen/Projects/ffx-bball-bot/scripts/deploy.sh` to `scripts/deploy.sh`. Update the stack name and parameter names to match the new SAM template. The key behavior: before deploying, the script reads the current live schedule expression from EventBridge and passes it as the `ScheduleExpression` parameter so runtime changes via `/ball schedule` persist across deploys.

- [ ] **Step 2: Create GitHub Actions workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-dmv-community-bot
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: Setup SAM CLI
        uses: aws-actions/setup-sam@v2
        with:
          use-installer: true

      - name: Deploy
        env:
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
          SLACK_SIGNING_SECRET: ${{ secrets.SLACK_SIGNING_SECRET }}
          SLACK_BOT_USER_ID: ${{ vars.SLACK_BOT_USER_ID }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          MAINTENANCE_CHANNEL_IDS: ${{ vars.MAINTENANCE_CHANNEL_IDS }}
          MAINTENANCE_SHEET_ID: ${{ vars.MAINTENANCE_SHEET_ID }}
          GENDER_SHEET_ID: ${{ vars.GENDER_SHEET_ID }}
          BBALL_CHANNELS: ${{ vars.BBALL_CHANNELS }}
          PINPOINT_APP_ID: ${{ vars.PINPOINT_APP_ID }}
          PINPOINT_NUMBER: ${{ vars.PINPOINT_NUMBER }}
        run: bash scripts/deploy.sh
```

- [ ] **Step 3: Create deployment docs**

Create `docs/deployment.md` with the one-time AWS OIDC setup, GitHub secrets/variables reference, and Slack app configuration steps (scopes, event subscriptions, slash commands). Follow the same format as the current repo's `docs/deployment.md` but updated for the new stack name and parameters.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add scripts/ .github/ docs/
git commit -m "add deploy script, GitHub Actions workflow, and deployment docs"
```

---

## Phase 8: Final Integration

### Task 16: End-to-end verification and cleanup

- [ ] **Step 1: Run the full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass, 0 failures

- [ ] **Step 2: Verify project structure matches the spec**

```bash
find src -type f | sort
find tests -type f | sort
```

Compare against the spec's project structure. Ensure no orphan files.

- [ ] **Step 3: Push to GitHub**

```bash
git push -u origin main
```

- [ ] **Step 4: Configure Slack app (manual)**

1. Create new Slack app or update existing one
2. Set scopes: `app_mentions:read`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `chat:write`, `reactions:read`, `reactions:write`, `users:read`, `commands`
3. Subscribe to events: `app_mention`, `message.channels`, `message.groups`, `reaction_added`, `reaction_removed`
4. Add slash command: `/ball` → POST to the SlackCommandsUrl from SAM output
5. Set Event Subscriptions Request URL to the SlackEventsUrl from SAM output
6. Install app to workspace

- [ ] **Step 5: Configure GitHub Actions secrets and variables (manual)**

Set all secrets and variables per the workflow file.

- [ ] **Step 6: Deploy**

Either push to main or run the workflow manually from GitHub Actions.

- [ ] **Step 7: Test each feature end-to-end**

**Maintenance (Slack):**
- `@bot printer broken` → severity prompt → confirmation
- `@bot list` → open issues
- `@bot close #5` → resolved

**Maintenance (SMS):**
- Text "printer broken" → severity prompt → confirmation
- Reply with follow-up → note added

**Gender aliases:**
- `!bros` → pings male channel members
- `@sis` → pings female channel members
- `!refresh-genders` → cache refreshed

**Basketball:**
- Wait for scheduled post (or trigger manually via `/ball today's game`)
- React with 🏀 → message updates with "In" count
- `/ball schedule` → shows current schedule
- `/ball info` → shows commit SHA

- [ ] **Step 8: Decommission old infrastructure (manual)**

1. Delete old `fh-maintenance-bot` SAM stack from AWS
2. Delete old `ffx-bball-bot` SAM stack from AWS
3. Shut down gender-aliases GCP VM
4. Archive old repos on GitHub

---

## Self-Review

**Spec coverage:**
- Maintenance port: Tasks 4-8 ✅
- Basketball port: Tasks 9-10 ✅
- Gender-aliases rewrite: Task 11 ✅
- Shared Slack router: Task 12 ✅
- Shared modules (config, slack helpers, verify-signature, scheduler): Tasks 2-3 ✅
- Lambda entry points: Task 13 ✅
- SAM template: Task 14 ✅
- Deploy pipeline: Task 15 ✅
- Slack app configuration: Task 16 ✅
- DynamoDB for conversations + gender cache: Tasks 4, 11 ✅
- EventBridge schedule with persist-across-deploys: Tasks 10, 14, 15 ✅

**Placeholder scan:** No TBDs. Task 12 has pseudocode for the router — the subagent should implement the full version based on the spec.

**Type consistency:** `loadConfig()` returns consistent field names across all tasks. Feature handler interfaces (`handle`, `hasTrigger`, `isRefreshTrigger`, etc.) are consistent between Task 11 (definition) and Task 12 (usage).
