# SMS Service + AWS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the maintenance bot from Raspberry Pi (PM2 + Socket Mode) to fully serverless AWS (Lambda + API Gateway + Pinpoint), and add SMS as a second input channel.

**Architecture:** Two Lambda functions (`slack-handler`, `sms-handler`) behind API Gateway and SNS respectively. Shared core logic for issue processing. DynamoDB replaces in-memory state. Slack switches from Socket Mode to HTTP Events mode. Amazon Pinpoint provides dedicated SMS number.

**Tech Stack:** Node.js (ES modules), AWS SAM, Lambda, API Gateway, DynamoDB, Amazon Pinpoint, SNS, Slack Bolt (HTTP mode), Google Sheets API, Groq API (OpenAI-compatible)

---

### Task 1: Update config for new environment variables

**Files:**
- Modify: `src/config.js`
- Modify: `tests/config.test.js`

- [ ] **Step 1: Write the failing test for new config shape**

Add a new test block to `tests/config.test.js` that validates the new env vars:

```js
it("loads new AWS env vars when present", async () => {
  Object.assign(process.env, VALID_ENV, {
    SLACK_SIGNING_SECRET: "test-signing-secret",
    DYNAMODB_TABLE: "test-table",
    PINPOINT_APP_ID: "test-pinpoint-id",
    PINPOINT_NUMBER: "+15551234567",
  });
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig();
  expect(config.slackSigningSecret).toBe("test-signing-secret");
  expect(config.dynamodbTable).toBe("test-table");
  expect(config.pinpointAppId).toBe("test-pinpoint-id");
  expect(config.pinpointNumber).toBe("+15551234567");
});

it("does not require SLACK_APP_TOKEN", async () => {
  const envWithoutAppToken = { ...VALID_ENV };
  delete envWithoutAppToken.SLACK_APP_TOKEN;
  Object.assign(process.env, envWithoutAppToken, {
    SLACK_SIGNING_SECRET: "test-signing-secret",
    DYNAMODB_TABLE: "test-table",
  });
  const { loadConfig } = await import("../src/config.js");
  expect(() => loadConfig()).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL — `slackSigningSecret` etc. not in returned config

- [ ] **Step 3: Update config.js**

Replace `src/config.js` with:

```js
const REQUIRED = [
  "SLACK_BOT_TOKEN",
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
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET || "",
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    groqApiKey: process.env.GROQ_API_KEY,
    dynamodbTable: process.env.DYNAMODB_TABLE || "",
    pinpointAppId: process.env.PINPOINT_APP_ID || "",
    pinpointNumber: process.env.PINPOINT_NUMBER || "",
  };
}
```

Note: `SLACK_APP_TOKEN` removed from REQUIRED. New vars are optional (empty string default) so the app can still run locally for testing without AWS resources.

- [ ] **Step 4: Update existing test's VALID_ENV**

The existing config tests reference `SLACK_APP_TOKEN` in `VALID_ENV`. Remove it and add `SLACK_SIGNING_SECRET` and `DYNAMODB_TABLE`:

```js
const VALID_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: "test-signing-secret",
  SLACK_CHANNEL_ID: "C123",
  GOOGLE_SHEET_ID: "sheet-id",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REFRESH_TOKEN: "test-refresh-token",
  GROQ_API_KEY: "gsk_test-key",
  DYNAMODB_TABLE: "test-table",
};
```

Update the existing "loads all required env vars" test to check `slackSigningSecret` instead of `slackAppToken`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "update config for AWS migration: add signing secret, DynamoDB, Pinpoint vars; remove SLACK_APP_TOKEN"
```

---

### Task 2: Create DynamoDB conversation service

**Files:**
- Create: `src/services/conversation.js`
- Create: `tests/services/conversation.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/conversation.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConversationService } from "../../src/services/conversation.js";

describe("ConversationService", () => {
  let mockDocClient;
  let service;

  beforeEach(() => {
    mockDocClient = {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    service = createConversationService(mockDocClient, "test-table");
  });

  describe("getConversation", () => {
    it("returns conversation state when it exists", async () => {
      mockDocClient.get.mockResolvedValue({
        Item: {
          pk: "SMS#+15551234567",
          state: "awaiting_severity",
          issueDescription: "printer broken",
        },
      });

      const result = await service.getConversation("SMS#+15551234567");
      expect(result).toEqual({
        pk: "SMS#+15551234567",
        state: "awaiting_severity",
        issueDescription: "printer broken",
      });
      expect(mockDocClient.get).toHaveBeenCalledWith({
        TableName: "test-table",
        Key: { pk: "SMS#+15551234567" },
      });
    });

    it("returns null when no conversation exists", async () => {
      mockDocClient.get.mockResolvedValue({});

      const result = await service.getConversation("SMS#+15559999999");
      expect(result).toBeNull();
    });
  });

  describe("saveConversation", () => {
    it("saves conversation with TTL set to 24 hours from now", async () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      await service.saveConversation("SMS#+15551234567", {
        state: "awaiting_severity",
        issueDescription: "printer broken",
      });

      expect(mockDocClient.put).toHaveBeenCalledWith({
        TableName: "test-table",
        Item: {
          pk: "SMS#+15551234567",
          state: "awaiting_severity",
          issueDescription: "printer broken",
          ttl: Math.floor(now / 1000) + 86400,
          updatedAt: expect.any(String),
        },
      });

      vi.restoreAllMocks();
    });
  });

  describe("deleteConversation", () => {
    it("deletes conversation by key", async () => {
      await service.deleteConversation("SMS#+15551234567");
      expect(mockDocClient.delete).toHaveBeenCalledWith({
        TableName: "test-table",
        Key: { pk: "SMS#+15551234567" },
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/conversation.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement conversation service**

Create `src/services/conversation.js`:

```js
export function createConversationService(docClient, tableName) {
  async function getConversation(pk) {
    const result = await docClient.get({
      TableName: tableName,
      Key: { pk },
    });
    return result.Item || null;
  }

  async function saveConversation(pk, data) {
    const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours
    await docClient.put({
      TableName: tableName,
      Item: {
        pk,
        ...data,
        ttl,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async function deleteConversation(pk) {
    await docClient.delete({
      TableName: tableName,
      Key: { pk },
    });
  }

  return { getConversation, saveConversation, deleteConversation };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/conversation.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation.js tests/services/conversation.test.js
git commit -m "add DynamoDB conversation service for stateless Lambda handlers"
```

---

### Task 3: Extract channel-agnostic issue processing into core module

The current `src/events/mention.js` mixes Slack-specific logic (reactions, `say()`, user info lookups, `client` calls) with core issue logic (classification, dedup, severity parsing, sheet writes). Extract the reusable parts so both Slack and SMS handlers can share them.

**Files:**
- Create: `src/core/issue-processor.js`
- Create: `tests/core/issue-processor.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/core/issue-processor.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createIssueProcessor } from "../../src/core/issue-processor.js";

function recentDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-US");
}

describe("IssueProcessor", () => {
  let mockSheets;
  let mockGroq;
  let mockDedup;
  let mockConversation;
  let processor;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("5"),
      appendNote: vi.fn().mockResolvedValue({}),
      updateIssueStatus: vi.fn().mockResolvedValue({}),
    };
    mockGroq = {
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
      isMaintenanceRequest: vi.fn().mockResolvedValue(true),
    };
    mockDedup = {
      findDuplicate: vi.fn().mockResolvedValue(null),
    };
    mockConversation = {
      getConversation: vi.fn().mockResolvedValue(null),
      saveConversation: vi.fn().mockResolvedValue({}),
      deleteConversation: vi.fn().mockResolvedValue({}),
    };
    processor = createIssueProcessor({
      sheetsService: mockSheets,
      groqService: mockGroq,
      dedupService: mockDedup,
      conversationService: mockConversation,
      spreadsheetId: "sheet-id",
    });
  });

  describe("processNewReport", () => {
    it("classifies, checks dedup, gets suggestion, and returns awaiting_severity", async () => {
      const result = await processor.processNewReport({
        description: "lobby printer jammed",
        reporterName: "Alice",
        conversationKey: "SLACK#1234",
      });

      expect(result.action).toBe("awaiting_severity");
      expect(result.suggestion).toBe("Try restarting it.");
      expect(mockGroq.isMaintenanceRequest).toHaveBeenCalledWith("lobby printer jammed");
      expect(mockConversation.saveConversation).toHaveBeenCalledWith(
        "SLACK#1234",
        expect.objectContaining({
          state: "awaiting_severity",
          issueDescription: "lobby printer jammed",
          reporterName: "Alice",
        })
      );
    });

    it("returns not_maintenance when classification fails", async () => {
      mockGroq.isMaintenanceRequest.mockResolvedValue(false);

      const result = await processor.processNewReport({
        description: "what's for lunch",
        reporterName: "Alice",
        conversationKey: "SMS#+15551234567",
      });

      expect(result.action).toBe("not_maintenance");
    });

    it("returns duplicate_found when confident match found", async () => {
      mockSheets.getOpenIssues.mockResolvedValue([
        { id: "5", description: "Printer jammed", submitter: "Bob", date: recentDate(1), status: "Open" },
      ]);
      mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: true });

      const result = await processor.processNewReport({
        description: "printer is broken",
        reporterName: "Alice",
        conversationKey: "SLACK#1234",
      });

      expect(result.action).toBe("duplicate_found");
      expect(result.existingIssue.id).toBe("5");
    });

    it("creates issue immediately when severity provided", async () => {
      const result = await processor.processNewReport({
        description: "lobby printer jammed",
        reporterName: "Alice",
        conversationKey: "SLACK#1234",
        severity: "Critical",
      });

      expect(result.action).toBe("issue_created");
      expect(result.issueRowId).toBe("5");
      expect(mockSheets.appendIssue).toHaveBeenCalledWith({
        reporter: "Alice",
        description: "lobby printer jammed",
        severity: "Critical",
      });
    });

    it("skips classification when forceCreate is true", async () => {
      const result = await processor.processNewReport({
        description: "weird smell",
        reporterName: "Alice",
        conversationKey: "SLACK#1234",
        forceCreate: true,
      });

      expect(mockGroq.isMaintenanceRequest).not.toHaveBeenCalled();
      expect(result.action).toBe("awaiting_severity");
    });

    it("returns sheets_error when Google Sheets fails", async () => {
      mockSheets.getOpenIssues.mockRejectedValue(new Error("Sheets down"));

      const result = await processor.processNewReport({
        description: "something broke",
        reporterName: "Alice",
        conversationKey: "SLACK#1234",
      });

      expect(result.action).toBe("sheets_error");
    });
  });

  describe("processSeverityReply", () => {
    it("creates issue and returns issue_created", async () => {
      mockConversation.getConversation.mockResolvedValue({
        pk: "SMS#+15551234567",
        state: "awaiting_severity",
        issueDescription: "printer broken",
        reporterName: "Alice",
        suggestion: "Try restarting it.",
        duplicate: null,
      });

      const result = await processor.processSeverityReply({
        conversationKey: "SMS#+15551234567",
        severity: "medium",
      });

      expect(result.action).toBe("issue_created");
      expect(result.issueRowId).toBe("5");
      expect(result.severity).toBe("Medium");
      expect(mockSheets.appendIssue).toHaveBeenCalledWith({
        reporter: "Alice",
        description: "printer broken",
        severity: "Medium",
      });
      expect(mockConversation.saveConversation).toHaveBeenCalledWith(
        "SMS#+15551234567",
        expect.objectContaining({ state: "issue_created", issueRowId: "5" })
      );
    });

    it("returns invalid_severity for bad input", async () => {
      mockConversation.getConversation.mockResolvedValue({
        pk: "SMS#+15551234567",
        state: "awaiting_severity",
      });

      const result = await processor.processSeverityReply({
        conversationKey: "SMS#+15551234567",
        severity: "super urgent",
      });

      expect(result.action).toBe("invalid_severity");
    });

    it("returns no_conversation when no pending state exists", async () => {
      const result = await processor.processSeverityReply({
        conversationKey: "SMS#+19999999999",
        severity: "minor",
      });

      expect(result.action).toBe("no_conversation");
    });
  });

  describe("processFollowUp", () => {
    it("appends note when issue exists in conversation", async () => {
      mockConversation.getConversation.mockResolvedValue({
        pk: "SMS#+15551234567",
        state: "issue_created",
        issueRowId: "5",
      });

      const result = await processor.processFollowUp({
        conversationKey: "SMS#+15551234567",
        text: "it's the one near the front desk",
      });

      expect(result.action).toBe("note_added");
      expect(mockSheets.appendNote).toHaveBeenCalledWith("5", "it's the one near the front desk");
    });

    it("returns no_conversation when no state exists", async () => {
      const result = await processor.processFollowUp({
        conversationKey: "SMS#+19999999999",
        text: "more details",
      });

      expect(result.action).toBe("no_conversation");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/issue-processor.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement issue-processor.js**

Create `src/core/issue-processor.js`:

```js
const SEVERITY_OPTIONS = ["minor", "medium", "critical"];

function extractSeverity(text) {
  const match = text.match(
    /[\s,\-\|]+(?:severity[:\s]+)?(minor|medium|critical)(?:\s+(?:priority|severity|issue))?\s*$|[\s,\-\|]+(minor|medium|critical)\s+(?:priority|severity)\s*$/i
  );
  if (!match) return { description: text, severity: null };
  const severity = (match[1] || match[2]).toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const description = text.slice(0, match.index).trim();
  return { description, severity };
}

export function createIssueProcessor({
  sheetsService,
  groqService,
  dedupService,
  conversationService,
  spreadsheetId,
}) {
  async function processNewReport({ description, reporterName, conversationKey, severity, forceCreate }) {
    // Classify
    if (!forceCreate) {
      const isMaintenance = await groqService.isMaintenanceRequest(description);
      if (!isMaintenance) {
        return { action: "not_maintenance" };
      }
    }

    // Parse inline severity
    const extracted = extractSeverity(description);
    const issueDescription = extracted.severity ? extracted.description : description;
    const resolvedSeverity = severity || extracted.severity;

    // Fetch open issues for dedup
    let openIssues;
    try {
      openIssues = await sheetsService.getOpenIssues();
    } catch {
      return { action: "sheets_error" };
    }

    // Dedup check (skip if forceCreate)
    let duplicate = null;
    if (!forceCreate) {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const recentIssues = openIssues.filter((issue) => {
        const parsed = new Date(issue.date);
        return !isNaN(parsed) && parsed >= sevenDaysAgo;
      });

      duplicate = await dedupService.findDuplicate(issueDescription, recentIssues);

      if (duplicate && duplicate.confident) {
        const existing = openIssues.find((i) => i.id === duplicate.id);
        return {
          action: "duplicate_found",
          existingIssue: existing,
          issueDescription,
        };
      }
    }

    // Get AI suggestion
    const suggestion = await groqService.suggestFix(issueDescription);

    // If severity is known, create immediately
    if (resolvedSeverity) {
      let issueRowId;
      try {
        issueRowId = await sheetsService.appendIssue({
          reporter: reporterName,
          description: issueDescription,
          severity: resolvedSeverity,
        });
      } catch {
        return { action: "sheets_error" };
      }

      await conversationService.saveConversation(conversationKey, {
        state: "issue_created",
        issueRowId,
        issueDescription,
        reporterName,
      });

      return {
        action: "issue_created",
        issueRowId,
        severity: resolvedSeverity,
        suggestion,
        duplicate,
        issueDescription,
      };
    }

    // Otherwise, save pending state and ask for severity
    await conversationService.saveConversation(conversationKey, {
      state: "awaiting_severity",
      issueDescription,
      reporterName,
      suggestion,
      duplicate: duplicate ? { id: duplicate.id, confident: duplicate.confident } : null,
    });

    return {
      action: "awaiting_severity",
      suggestion,
      duplicate,
      issueDescription,
    };
  }

  async function processSeverityReply({ conversationKey, severity }) {
    const conversation = await conversationService.getConversation(conversationKey);
    if (!conversation || conversation.state !== "awaiting_severity") {
      return { action: "no_conversation" };
    }

    const normalizedSeverity = severity.toLowerCase();
    if (!SEVERITY_OPTIONS.includes(normalizedSeverity)) {
      return { action: "invalid_severity" };
    }

    const capitalizedSeverity = normalizedSeverity.replace(/^./, (c) => c.toUpperCase());

    let issueRowId;
    try {
      issueRowId = await sheetsService.appendIssue({
        reporter: conversation.reporterName,
        description: conversation.issueDescription,
        severity: capitalizedSeverity,
      });
    } catch {
      return { action: "sheets_error" };
    }

    await conversationService.saveConversation(conversationKey, {
      state: "issue_created",
      issueRowId,
      issueDescription: conversation.issueDescription,
      reporterName: conversation.reporterName,
    });

    return {
      action: "issue_created",
      issueRowId,
      severity: capitalizedSeverity,
      suggestion: conversation.suggestion,
      duplicate: conversation.duplicate,
      issueDescription: conversation.issueDescription,
    };
  }

  async function processFollowUp({ conversationKey, text }) {
    const conversation = await conversationService.getConversation(conversationKey);
    if (!conversation || !conversation.issueRowId) {
      return { action: "no_conversation" };
    }

    try {
      await sheetsService.appendNote(conversation.issueRowId, text);
    } catch {
      return { action: "sheets_error" };
    }

    // Refresh TTL
    await conversationService.saveConversation(conversationKey, {
      ...conversation,
      pk: undefined, // don't nest pk inside data
    });

    return { action: "note_added" };
  }

  return { processNewReport, processSeverityReply, processFollowUp, extractSeverity };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/issue-processor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/issue-processor.js tests/core/issue-processor.test.js
git commit -m "extract channel-agnostic issue processing into core module"
```

---

### Task 4: Create SMS handler

**Files:**
- Create: `src/handlers/sms.js`
- Create: `tests/handlers/sms.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/handlers/sms.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSmsHandler } from "../../src/handlers/sms.js";

describe("SmsHandler", () => {
  let mockProcessor;
  let mockConversation;
  let mockPinpoint;
  let handler;

  beforeEach(() => {
    mockProcessor = {
      processNewReport: vi.fn().mockResolvedValue({ action: "awaiting_severity" }),
      processSeverityReply: vi.fn(),
      processFollowUp: vi.fn(),
    };
    mockConversation = {
      getConversation: vi.fn().mockResolvedValue(null),
      deleteConversation: vi.fn().mockResolvedValue({}),
    };
    mockPinpoint = {
      sendSms: vi.fn().mockResolvedValue({}),
    };
    handler = createSmsHandler({
      issueProcessor: mockProcessor,
      conversationService: mockConversation,
      pinpointService: mockPinpoint,
    });
  });

  function snsEvent(body, originationNumber = "+15551234567") {
    return {
      Records: [
        {
          Sns: {
            Message: JSON.stringify({
              messageBody: body,
              originationNumber,
            }),
          },
        },
      ],
    };
  }

  it("starts a new issue report when no active conversation", async () => {
    await handler(snsEvent("the lobby printer is broken"));

    expect(mockProcessor.processNewReport).toHaveBeenCalledWith({
      description: "the lobby printer is broken",
      reporterName: "+15551234567",
      conversationKey: "SMS#+15551234567",
    });
    expect(mockPinpoint.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("How severe")
    );
  });

  it("processes severity reply when awaiting severity", async () => {
    mockConversation.getConversation.mockResolvedValue({
      state: "awaiting_severity",
      issueDescription: "printer broken",
    });
    mockProcessor.processSeverityReply.mockResolvedValue({
      action: "issue_created",
      issueRowId: "5",
      severity: "Medium",
      suggestion: "Try restarting it.",
      duplicate: null,
      issueDescription: "printer broken",
    });

    await handler(snsEvent("medium"));

    expect(mockProcessor.processSeverityReply).toHaveBeenCalledWith({
      conversationKey: "SMS#+15551234567",
      severity: "medium",
    });
    expect(mockPinpoint.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("Logged your issue")
    );
  });

  it("appends follow-up note when issue already created", async () => {
    mockConversation.getConversation.mockResolvedValue({
      state: "issue_created",
      issueRowId: "5",
    });
    mockProcessor.processFollowUp.mockResolvedValue({ action: "note_added" });

    await handler(snsEvent("it's the one near the front desk"));

    expect(mockProcessor.processFollowUp).toHaveBeenCalledWith({
      conversationKey: "SMS#+15551234567",
      text: "it's the one near the front desk",
    });
    expect(mockPinpoint.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("added")
    );
  });

  it("starts a new report when user texts NEW with active conversation", async () => {
    mockConversation.getConversation.mockResolvedValue({
      state: "issue_created",
      issueRowId: "5",
    });

    await handler(snsEvent("NEW broken window in unit 4B"));

    expect(mockConversation.deleteConversation).toHaveBeenCalledWith("SMS#+15551234567");
    expect(mockProcessor.processNewReport).toHaveBeenCalledWith({
      description: "broken window in unit 4B",
      reporterName: "+15551234567",
      conversationKey: "SMS#+15551234567",
    });
  });

  it("sends not-maintenance reply when classification fails", async () => {
    mockProcessor.processNewReport.mockResolvedValue({ action: "not_maintenance" });

    await handler(snsEvent("what's for lunch"));

    expect(mockPinpoint.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("maintenance")
    );
  });

  it("sends error reply when sheets fails", async () => {
    mockProcessor.processNewReport.mockResolvedValue({ action: "sheets_error" });

    await handler(snsEvent("printer broken"));

    expect(mockPinpoint.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("try again")
    );
  });

  it("sends invalid severity reply", async () => {
    mockConversation.getConversation.mockResolvedValue({
      state: "awaiting_severity",
    });
    mockProcessor.processSeverityReply.mockResolvedValue({ action: "invalid_severity" });

    await handler(snsEvent("super urgent"));

    expect(mockPinpoint.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("minor")
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/handlers/sms.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SMS handler**

Create `src/handlers/sms.js`:

```js
export function createSmsHandler({ issueProcessor, conversationService, pinpointService }) {
  return async function handleSms(event) {
    const record = event.Records[0];
    const message = JSON.parse(record.Sns.Message);
    const phoneNumber = message.originationNumber;
    const body = (message.messageBody || "").trim();
    const conversationKey = `SMS#${phoneNumber}`;

    if (!body) {
      await pinpointService.sendSms(
        phoneNumber,
        "Please describe the maintenance issue you'd like to report."
      );
      return;
    }

    // Check for "NEW" prefix to start fresh conversation
    const newMatch = body.match(/^NEW\s+(.+)$/i);
    if (newMatch) {
      await conversationService.deleteConversation(conversationKey);
      const result = await issueProcessor.processNewReport({
        description: newMatch[1],
        reporterName: phoneNumber,
        conversationKey,
      });
      await sendReply(pinpointService, phoneNumber, result);
      return;
    }

    // Check existing conversation state
    const conversation = await conversationService.getConversation(conversationKey);

    if (conversation && conversation.state === "awaiting_severity") {
      const result = await issueProcessor.processSeverityReply({
        conversationKey,
        severity: body,
      });
      await sendReply(pinpointService, phoneNumber, result);
      return;
    }

    if (conversation && conversation.state === "issue_created") {
      const result = await issueProcessor.processFollowUp({
        conversationKey,
        text: body,
      });
      await sendReply(pinpointService, phoneNumber, result);
      return;
    }

    // No active conversation — treat as new report
    const result = await issueProcessor.processNewReport({
      description: body,
      reporterName: phoneNumber,
      conversationKey,
    });
    await sendReply(pinpointService, phoneNumber, result);
  };
}

async function sendReply(pinpointService, phoneNumber, result) {
  const messages = {
    awaiting_severity: "How severe is this issue? Reply with: minor, medium, or critical",
    not_maintenance:
      "That doesn't look like a maintenance request. Please describe a specific issue (e.g., a broken fixture, a leak, something needing repair).",
    duplicate_found: `This looks like an existing issue (#${result.existingIssue?.id}, reported by ${result.existingIssue?.submitter}). Status: ${result.existingIssue?.status}`,
    issue_created: buildCreatedMessage(result),
    invalid_severity: "Please reply with one of: minor, medium, or critical",
    note_added: "Got it, added that to the issue notes.",
    sheets_error: "Sorry, couldn't process that right now. Please try again in a few minutes.",
    no_conversation: "Please describe the maintenance issue you'd like to report.",
  };

  const text = messages[result.action] || "Something went wrong. Please try again.";
  await pinpointService.sendSms(phoneNumber, text);
}

function buildCreatedMessage(result) {
  if (result.action !== "issue_created") return "";
  let msg = `Logged your issue (severity: ${result.severity}).`;
  if (result.duplicate && !result.duplicate.confident) {
    msg += ` This might be related to issue #${result.duplicate.id}.`;
  }
  if (result.suggestion) {
    msg += `\n\nSuggested fix: ${result.suggestion}`;
  }
  msg += "\n\nReply to add more details. Text NEW to report a different issue.";
  return msg;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/handlers/sms.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/sms.js tests/handlers/sms.test.js
git commit -m "add SMS handler for Pinpoint/SNS inbound messages"
```

---

### Task 5: Create Pinpoint SMS sending service

**Files:**
- Create: `src/services/pinpoint.js`
- Create: `tests/services/pinpoint.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/pinpoint.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinpointService } from "../../src/services/pinpoint.js";

describe("PinpointService", () => {
  let mockPinpointClient;
  let service;

  beforeEach(() => {
    mockPinpointClient = {
      sendMessages: vi.fn().mockResolvedValue({
        MessageResponse: {
          Result: {
            "+15551234567": { StatusCode: 200, DeliveryStatus: "SUCCESSFUL" },
          },
        },
      }),
    };
    service = createPinpointService(mockPinpointClient, "app-id", "+15559876543");
  });

  it("sends an SMS message via Pinpoint", async () => {
    await service.sendSms("+15551234567", "Your issue has been logged.");

    expect(mockPinpointClient.sendMessages).toHaveBeenCalledWith({
      ApplicationId: "app-id",
      MessageRequest: {
        Addresses: {
          "+15551234567": { ChannelType: "SMS" },
        },
        MessageConfiguration: {
          SMSMessage: {
            Body: "Your issue has been logged.",
            MessageType: "TRANSACTIONAL",
            OriginationNumber: "+15559876543",
          },
        },
      },
    });
  });

  it("logs error but does not throw on send failure", async () => {
    mockPinpointClient.sendMessages.mockRejectedValue(new Error("Pinpoint down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await service.sendSms("+15551234567", "test");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send SMS"),
      expect.any(String)
    );
    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/pinpoint.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Pinpoint service**

Create `src/services/pinpoint.js`:

```js
export function createPinpointService(pinpointClient, applicationId, originationNumber) {
  async function sendSms(destinationNumber, body) {
    try {
      await pinpointClient.sendMessages({
        ApplicationId: applicationId,
        MessageRequest: {
          Addresses: {
            [destinationNumber]: { ChannelType: "SMS" },
          },
          MessageConfiguration: {
            SMSMessage: {
              Body: body,
              MessageType: "TRANSACTIONAL",
              OriginationNumber: originationNumber,
            },
          },
        },
      });
    } catch (err) {
      console.error("Failed to send SMS:", err.message);
    }
  }

  return { sendSms };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/pinpoint.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/pinpoint.js tests/services/pinpoint.test.js
git commit -m "add Pinpoint SMS sending service"
```

---

### Task 6: Create Slack HTTP handler (replace Socket Mode)

**Files:**
- Create: `src/handlers/slack.js`
- Create: `tests/handlers/slack.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/handlers/slack.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlackHandler } from "../../src/handlers/slack.js";

describe("SlackHandler", () => {
  let mockProcessor;
  let mockConversation;
  let mockSlackClient;
  let handler;

  beforeEach(() => {
    mockProcessor = {
      processNewReport: vi.fn().mockResolvedValue({ action: "awaiting_severity" }),
      processSeverityReply: vi.fn(),
      processFollowUp: vi.fn(),
    };
    mockConversation = {
      getConversation: vi.fn().mockResolvedValue(null),
    };
    mockSlackClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { real_name: "Test User" } }),
      },
    };
    handler = createSlackHandler({
      issueProcessor: mockProcessor,
      conversationService: mockConversation,
      slackClient: mockSlackClient,
      channelId: "C123",
      spreadsheetId: "sheet-id",
      signingSecret: "test-secret",
    });
  });

  it("responds to Slack URL verification challenge", async () => {
    const event = {
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" }),
      headers: {},
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ challenge: "abc123" });
  });

  it("ignores events outside the configured channel", async () => {
    const event = makeSlackEvent({
      type: "app_mention",
      channel: "C999",
      text: "<@UBOT> printer broke",
      user: "U1",
      ts: "1",
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(mockProcessor.processNewReport).not.toHaveBeenCalled();
  });

  it("processes app_mention as new issue report", async () => {
    const event = makeSlackEvent({
      type: "app_mention",
      channel: "C123",
      text: "<@UBOT> lobby printer jammed",
      user: "U1",
      ts: "1",
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(mockProcessor.processNewReport).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "lobby printer jammed",
        conversationKey: "SLACK#1",
      })
    );
  });

  it("processes severity reply in thread", async () => {
    mockConversation.getConversation.mockResolvedValue({
      state: "awaiting_severity",
    });
    mockProcessor.processSeverityReply.mockResolvedValue({
      action: "issue_created",
      issueRowId: "5",
      severity: "Medium",
      suggestion: "Try restarting it.",
      duplicate: null,
      issueDescription: "printer broken",
    });

    const event = makeSlackEvent({
      type: "message",
      channel: "C123",
      text: "medium",
      user: "U1",
      ts: "2",
      thread_ts: "1",
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(mockProcessor.processSeverityReply).toHaveBeenCalledWith({
      conversationKey: "SLACK#1",
      severity: "medium",
    });
  });

  // Helper to build API Gateway event wrapping a Slack event payload
  function makeSlackEvent(slackEvent) {
    return {
      body: JSON.stringify({
        type: "event_callback",
        event: slackEvent,
      }),
      headers: {
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    };
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/handlers/slack.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Slack handler**

Create `src/handlers/slack.js`:

```js
import crypto from "crypto";

export function createSlackHandler({
  issueProcessor,
  conversationService,
  slackClient,
  channelId,
  spreadsheetId,
  signingSecret,
}) {
  return async function handleSlackEvent(apiGatewayEvent) {
    const body = JSON.parse(apiGatewayEvent.body);

    // URL verification challenge
    if (body.type === "url_verification") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: body.challenge }),
      };
    }

    // Verify Slack signature (skip in test when no signingSecret)
    if (signingSecret) {
      const timestamp = apiGatewayEvent.headers["x-slack-request-timestamp"];
      const slackSignature = apiGatewayEvent.headers["x-slack-signature"];
      const sigBasestring = `v0:${timestamp}:${apiGatewayEvent.body}`;
      const mySignature = "v0=" + crypto.createHmac("sha256", signingSecret).update(sigBasestring).digest("hex");
      if (mySignature !== slackSignature) {
        return { statusCode: 401, body: "Invalid signature" };
      }
    }

    // Acknowledge immediately — Slack expects 200 within 3 seconds
    // Process asynchronously (Lambda will continue executing)
    if (body.type !== "event_callback") {
      return { statusCode: 200, body: "ok" };
    }

    const event = body.event;
    if (event.channel !== channelId) {
      return { statusCode: 200, body: "ok" };
    }

    // Skip bot messages
    if (event.bot_id || event.subtype) {
      return { statusCode: 200, body: "ok" };
    }

    const text = (event.text || "").replace(/<@[A-Z0-9_]+>/g, "").trim();
    const threadKey = event.thread_ts || event.ts;
    const conversationKey = `SLACK#${threadKey}`;

    // Add eyes reaction
    try {
      await slackClient.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: "eyes",
      });
    } catch (err) {
      console.error("Failed to add reaction:", err.message);
    }

    // Helper to post in thread
    async function say(msg) {
      await slackClient.chat.postMessage({
        channel: event.channel,
        text: typeof msg === "string" ? msg : msg.text,
        thread_ts: threadKey,
      });
    }

    if (!text) {
      await say("Please describe the issue you'd like to report.");
      return { statusCode: 200, body: "ok" };
    }

    // Check for list command
    if (/\b(list|show|what are|open requests|open issues|status)\b/i.test(text)) {
      await handleListCommand(say, issueProcessor, spreadsheetId);
      return { statusCode: 200, body: "ok" };
    }

    // Check for close command
    const closeMatch = text.match(/^(?:close|resolve|mark as resolved)\s+#?(\d+)$/i);
    if (closeMatch) {
      await handleCloseById(say, issueProcessor, closeMatch[1]);
      return { statusCode: 200, body: "ok" };
    }

    // Check conversation state
    const conversation = await conversationService.getConversation(conversationKey);

    if (conversation && conversation.state === "awaiting_severity") {
      const result = await issueProcessor.processSeverityReply({
        conversationKey,
        severity: text,
      });
      await sendSlackReply(say, result, spreadsheetId);
      return { statusCode: 200, body: "ok" };
    }

    if (conversation && conversation.state === "issue_created" && event.thread_ts) {
      const isCommand =
        /\b(list|show|what are|open requests|open issues|status)\b/i.test(text) ||
        /^(?:close|resolve|mark as resolved)\s+/i.test(text) ||
        /^create new:\s*/i.test(text);
      if (!isCommand) {
        const result = await issueProcessor.processFollowUp({
          conversationKey,
          text,
        });
        await sendSlackReply(say, result, spreadsheetId);
        return { statusCode: 200, body: "ok" };
      }
    }

    // Check for "create new:" prefix
    const forceCreate = text.match(/^create new:\s*(.+)$/i);
    const description = forceCreate ? forceCreate[1] : text;

    // Get reporter name
    let reporterName = event.user;
    try {
      const userInfo = await slackClient.users.info({ user: event.user });
      reporterName = userInfo.user.real_name || userInfo.user.name || event.user;
    } catch (err) {
      console.error("Failed to fetch user info:", err.message);
    }

    const result = await issueProcessor.processNewReport({
      description,
      reporterName,
      conversationKey,
      forceCreate: !!forceCreate,
    });
    await sendSlackReply(say, result, spreadsheetId);
    return { statusCode: 200, body: "ok" };
  };
}

async function sendSlackReply(say, result, spreadsheetId) {
  const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  switch (result.action) {
    case "awaiting_severity":
      await say("How severe is this issue? Please reply with one of: *minor*, *medium*, or *critical*.");
      break;

    case "not_maintenance":
      await say(
        "I'm not sure that's a maintenance request. Could you describe a specific facilities or maintenance issue you'd like to report?"
      );
      break;

    case "duplicate_found": {
      const e = result.existingIssue;
      await say(
        `This looks like an existing issue (row ${e.id}, submitted by ${e.submitter} on ${e.date}). Current status: *${e.status}*\n\n<${docLink}|View in Google Sheets>\n\nIf this is a new issue, reply with \`@FH Maintenance create new: ${result.issueDescription}\``
      );
      break;
    }

    case "issue_created": {
      let msg = `Logged your issue (severity: *${result.severity}*). <${docLink}|View in Google Sheets>`;
      if (result.duplicate && !result.duplicate.confident) {
        msg += ` This might be related to issue #${result.duplicate.id}.`;
      }
      if (result.suggestion) {
        msg += `\n\n*Suggested fix:* ${result.suggestion}`;
      } else {
        msg += `\nCouldn't generate a suggestion right now.`;
      }
      msg += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
      if (result.severity === "Medium" || result.severity === "Critical") {
        msg += `\n\ncc <@U0000000000>`;
      }
      await say(msg);
      break;
    }

    case "invalid_severity":
      await say("Please reply with one of: *Minor*, *Medium*, or *Critical*.");
      break;

    case "note_added":
      await say("Got it, added that to the notes.");
      break;

    case "sheets_error":
      await say("Couldn't log this issue right now — please try again in a few minutes.");
      break;

    default:
      await say("Something went wrong. Please try again.");
  }
}

async function handleListCommand(say, issueProcessor, spreadsheetId) {
  // This delegates to sheets directly — imported via issueProcessor's sheetsService
  // For now, keep list/close in the Slack handler since they're Slack-only
  // We'll need to pass sheetsService through. See note below.
}

async function handleCloseById(say, issueProcessor, rowId) {
  // Same as above — Slack-only commands
}
```

**Note:** The `handleListCommand` and `handleCloseById` are stubs. They need `sheetsService` passed in. Update the `createSlackHandler` signature to accept `sheetsService` directly and implement these in Step 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/handlers/slack.test.js`
Expected: PASS (for the covered test cases)

- [ ] **Step 5: Implement list and close commands in Slack handler**

Update `createSlackHandler` to accept `sheetsService` in its options:

```js
export function createSlackHandler({
  issueProcessor,
  conversationService,
  slackClient,
  sheetsService,
  channelId,
  spreadsheetId,
  signingSecret,
}) {
```

Then implement the two stub functions:

```js
async function handleListCommand(say, sheetsService) {
  try {
    const openIssues = await sheetsService.getOpenIssues();
    if (openIssues.length === 0) {
      await say("No open requests right now.");
      return;
    }
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentIssues = openIssues.filter((i) => {
      const parsed = new Date(i.date);
      return !isNaN(parsed) && parsed >= sevenDaysAgo;
    });
    const issuesToShow = recentIssues.length > 0 ? recentIssues : openIssues.slice(0, 5);
    const label = recentIssues.length > 0 ? "Requests from the Past 7 Days" : "5 Most Recent Requests";
    const lines = issuesToShow.map(
      (i) => `• *${i.description}* — submitted by ${i.submitter} on ${i.date} (Status: ${i.status})`
    );
    await say(`*${label} (${issuesToShow.length}):*\n${lines.join("\n")}`);
  } catch (err) {
    console.error("Sheets error:", err.message);
    await say("Couldn't fetch requests right now.");
  }
}

async function handleCloseById(say, sheetsService, rowId) {
  try {
    const allIssues = await sheetsService.getOpenIssues();
    const issue = allIssues.find((i) => i.id === rowId);
    if (!issue) {
      await say(`No open issue found with ID #${rowId}.`);
      return;
    }
    await sheetsService.updateIssueStatus(rowId, "Resolved");
    await say(`Issue #${rowId} (*${issue.description}*) has been marked as resolved.`);
  } catch (err) {
    console.error("Sheets error:", err.message);
    await say("Couldn't update the issue right now — please try again.");
  }
}
```

Update the call sites in the main handler to pass `sheetsService`:

```js
await handleListCommand(say, sheetsService);
// and
await handleCloseById(say, sheetsService, closeMatch[1]);
```

- [ ] **Step 6: Add tests for list and close commands**

Add to `tests/handlers/slack.test.js`:

```js
it("lists open issues", async () => {
  const mockSheets = {
    getOpenIssues: vi.fn().mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: new Date().toLocaleDateString("en-US"), status: "Open" },
    ]),
  };
  handler = createSlackHandler({
    issueProcessor: mockProcessor,
    conversationService: mockConversation,
    slackClient: mockSlackClient,
    sheetsService: mockSheets,
    channelId: "C123",
    spreadsheetId: "sheet-id",
    signingSecret: "",
  });

  const event = makeSlackEvent({
    type: "app_mention",
    channel: "C123",
    text: "<@UBOT> list",
    user: "U1",
    ts: "1",
  });

  await handler(event);

  expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining("Printer jammed"),
    })
  );
});

it("closes issue by ID", async () => {
  const mockSheets = {
    getOpenIssues: vi.fn().mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]),
    updateIssueStatus: vi.fn().mockResolvedValue({}),
  };
  handler = createSlackHandler({
    issueProcessor: mockProcessor,
    conversationService: mockConversation,
    slackClient: mockSlackClient,
    sheetsService: mockSheets,
    channelId: "C123",
    spreadsheetId: "sheet-id",
    signingSecret: "",
  });

  const event = makeSlackEvent({
    type: "app_mention",
    channel: "C123",
    text: "<@UBOT> close #5",
    user: "U1",
    ts: "1",
  });

  await handler(event);

  expect(mockSheets.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
  expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining("marked as resolved"),
    })
  );
});
```

- [ ] **Step 7: Run all tests to verify they pass**

Run: `npx vitest run tests/handlers/slack.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/handlers/slack.js tests/handlers/slack.test.js
git commit -m "add Slack HTTP event handler replacing Socket Mode"
```

---

### Task 7: Create Lambda entry points

**Files:**
- Create: `src/lambda/slack.js`
- Create: `src/lambda/sms.js`

These are thin entry points that wire up dependencies and export the Lambda handler function. No tests needed — they're pure wiring.

- [ ] **Step 1: Install AWS SDK dependencies**

```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-pinpoint @slack/web-api
```

Note: We're adding `@slack/web-api` directly (instead of `@slack/bolt`) since we no longer need the Bolt framework — we handle HTTP events ourselves.

- [ ] **Step 2: Create Slack Lambda entry point**

Create `src/lambda/slack.js`:

```js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import { google } from "googleapis";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createConversationService } from "../services/conversation.js";
import { createIssueProcessor } from "../core/issue-processor.js";
import { createSlackHandler } from "../handlers/slack.js";

const config = loadConfig();

// DynamoDB
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const docClient = {
  get: (params) => ddbClient.send(new GetCommand(params)),
  put: (params) => ddbClient.send(new PutCommand(params)),
  delete: (params) => ddbClient.send(new DeleteCommand(params)),
};
const conversationService = createConversationService(docClient, config.dynamodbTable);

// Google Sheets
const oauth2Client = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

// Groq
const groqClient = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: config.groqApiKey,
});
const groqService = createGroqService(groqClient);

// Dedup
const dedupService = createDedupService(groqService);

// Issue Processor
const issueProcessor = createIssueProcessor({
  sheetsService,
  groqService,
  dedupService,
  conversationService,
  spreadsheetId: config.googleSheetId,
});

// Slack client
const slackClient = new WebClient(config.slackBotToken);

// Handler
const handler = createSlackHandler({
  issueProcessor,
  conversationService,
  slackClient,
  sheetsService,
  channelId: config.slackChannelId,
  spreadsheetId: config.googleSheetId,
  signingSecret: config.slackSigningSecret,
});

export { handler };
```

- [ ] **Step 3: Create SMS Lambda entry point**

Create `src/lambda/sms.js`:

```js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PinpointClient, SendMessagesCommand } from "@aws-sdk/client-pinpoint";
import OpenAI from "openai";
import { google } from "googleapis";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createConversationService } from "../services/conversation.js";
import { createPinpointService } from "../services/pinpoint.js";
import { createIssueProcessor } from "../core/issue-processor.js";
import { createSmsHandler } from "../handlers/sms.js";

const config = loadConfig();

// DynamoDB
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const docClient = {
  get: (params) => ddbClient.send(new GetCommand(params)),
  put: (params) => ddbClient.send(new PutCommand(params)),
  delete: (params) => ddbClient.send(new DeleteCommand(params)),
};
const conversationService = createConversationService(docClient, config.dynamodbTable);

// Google Sheets
const oauth2Client = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

// Groq
const groqClient = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: config.groqApiKey,
});
const groqService = createGroqService(groqClient);

// Dedup
const dedupService = createDedupService(groqService);

// Pinpoint
const pinpointClient = new PinpointClient({});
const pinpointCommandClient = {
  sendMessages: (params) => pinpointClient.send(new SendMessagesCommand(params)),
};
const pinpointService = createPinpointService(pinpointCommandClient, config.pinpointAppId, config.pinpointNumber);

// Issue Processor
const issueProcessor = createIssueProcessor({
  sheetsService,
  groqService,
  dedupService,
  conversationService,
  spreadsheetId: config.googleSheetId,
});

// Handler
const handler = createSmsHandler({
  issueProcessor,
  conversationService,
  pinpointService,
});

export { handler };
```

- [ ] **Step 4: Commit**

```bash
git add src/lambda/slack.js src/lambda/sms.js
git commit -m "add Lambda entry points wiring up Slack and SMS handlers"
```

---

### Task 8: Create SAM template

**Files:**
- Create: `template.yaml`
- Create: `samconfig.toml`

- [ ] **Step 1: Create SAM template**

Create `template.yaml`:

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Description: FH Maintenance Bot - Slack + SMS

Globals:
  Function:
    Runtime: nodejs20.x
    Timeout: 30
    MemorySize: 256
    Environment:
      Variables:
        SLACK_BOT_TOKEN: !Ref SlackBotToken
        SLACK_SIGNING_SECRET: !Ref SlackSigningSecret
        SLACK_CHANNEL_ID: !Ref SlackChannelId
        GOOGLE_SHEET_ID: !Ref GoogleSheetId
        GOOGLE_CLIENT_ID: !Ref GoogleClientId
        GOOGLE_CLIENT_SECRET: !Ref GoogleClientSecret
        GOOGLE_REFRESH_TOKEN: !Ref GoogleRefreshToken
        GROQ_API_KEY: !Ref GroqApiKey
        DYNAMODB_TABLE: !Ref ConversationsTable
        PINPOINT_APP_ID: !Ref PinpointAppId
        PINPOINT_NUMBER: !Ref PinpointNumber

Parameters:
  SlackBotToken:
    Type: String
    NoEcho: true
  SlackSigningSecret:
    Type: String
    NoEcho: true
  SlackChannelId:
    Type: String
  GoogleSheetId:
    Type: String
  GoogleClientId:
    Type: String
    NoEcho: true
  GoogleClientSecret:
    Type: String
    NoEcho: true
  GoogleRefreshToken:
    Type: String
    NoEcho: true
  GroqApiKey:
    Type: String
    NoEcho: true
  PinpointAppId:
    Type: String
  PinpointNumber:
    Type: String

Resources:
  ConversationsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: maintenance-bot-conversations
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
      TimeToLiveSpecification:
        AttributeName: ttl
        Enabled: true

  SlackFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/slack.handler
      Events:
        SlackEvents:
          Type: Api
          Properties:
            Path: /slack/events
            Method: post
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref ConversationsTable

  SmsFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/sms.handler
      Events:
        SmsInbound:
          Type: SNS
          Properties:
            Topic: !Ref SmsTopic
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref ConversationsTable
        - Statement:
            - Effect: Allow
              Action:
                - mobiletargeting:SendMessages
              Resource: !Sub "arn:aws:mobiletargeting:${AWS::Region}:${AWS::AccountId}:apps/${PinpointAppId}/*"

  SmsTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: maintenance-bot-sms-inbound

Outputs:
  SlackApiUrl:
    Description: Slack Events API endpoint
    Value: !Sub "https://${ServerlessRestApi}.execute-api.${AWS::Region}.amazonaws.com/Prod/slack/events"
  SmsTopicArn:
    Description: SNS topic ARN for Pinpoint SMS routing
    Value: !Ref SmsTopic
```

- [ ] **Step 2: Create samconfig.toml**

Create `samconfig.toml`:

```toml
version = 0.1

[default.deploy.parameters]
stack_name = "fh-maintenance-bot"
resolve_s3 = true
capabilities = "CAPABILITY_IAM"
confirm_changeset = true
```

- [ ] **Step 3: Validate the SAM template**

Run: `sam validate`
Expected: template.yaml is a valid SAM Template

- [ ] **Step 4: Commit**

```bash
git add template.yaml samconfig.toml
git commit -m "add SAM template for Lambda, API Gateway, DynamoDB, and SNS"
```

---

### Task 9: Update package.json and clean up old files

**Files:**
- Modify: `package.json`
- Delete: `src/app.js`
- Delete: `src/events/mention.js`
- Delete: `ecosystem.config.cjs`

- [ ] **Step 1: Update package.json**

Update dependencies and scripts:

```json
{
  "name": "fh-maintenance-bot",
  "version": "2.0.0",
  "description": "Maintenance bot with Slack + SMS channels on AWS Lambda",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "deploy": "sam build && sam deploy",
    "validate": "sam validate"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.0.0",
    "@aws-sdk/client-pinpoint": "^3.0.0",
    "@aws-sdk/lib-dynamodb": "^3.0.0",
    "@slack/web-api": "^7.0.0",
    "googleapis": "^171.4.0",
    "openai": "^6.33.0"
  },
  "devDependencies": {
    "vitest": "^4.1.3"
  }
}
```

Note: `@slack/bolt` and `dotenv` removed. `dotenv` is not needed in Lambda (env vars are set via SAM template). `@slack/bolt` replaced by `@slack/web-api`.

- [ ] **Step 2: Delete old files**

```bash
rm src/app.js src/events/mention.js ecosystem.config.cjs
```

- [ ] **Step 3: Delete old test file for mention.js**

```bash
rm tests/events/mention.test.js
```

The mention handler logic has been replaced by `src/core/issue-processor.js` + `src/handlers/slack.js`, both of which have their own tests.

- [ ] **Step 4: Install new dependencies**

```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-pinpoint @slack/web-api
npm uninstall @slack/bolt dotenv
```

- [ ] **Step 5: Run all tests to verify nothing is broken**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "clean up: remove Socket Mode app, PM2 config, update deps for Lambda"
```

---

### Task 10: Update .gitignore and add deployment docs

**Files:**
- Modify: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Update .gitignore**

Ensure `.gitignore` includes SAM build artifacts:

```
node_modules/
.aws-sam/
.env
samconfig.toml
```

Note: `samconfig.toml` is gitignored because it may contain deployment-specific settings. The committed version from Task 8 is a template.

- [ ] **Step 2: Create .env.example**

Create `.env.example`:

```
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...

# Google Sheets
GOOGLE_SHEET_ID=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Groq
GROQ_API_KEY=gsk_...

# AWS (set automatically by SAM in Lambda; only needed for local testing)
DYNAMODB_TABLE=maintenance-bot-conversations
PINPOINT_APP_ID=...
PINPOINT_NUMBER=+1...
```

- [ ] **Step 3: Run full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add .gitignore .env.example
git commit -m "add .env.example and update .gitignore for SAM deployment"
```

---

### Task 11: Deploy and configure

This task covers manual steps that can't be TDD'd.

- [ ] **Step 1: Deploy the SAM stack**

```bash
sam build
sam deploy --guided
```

Provide parameter values when prompted (Slack tokens, Google credentials, Groq key, etc.).

- [ ] **Step 2: Configure Slack app for HTTP Events**

1. Go to https://api.slack.com/apps → your bot app
2. Under "Event Subscriptions", enable events
3. Set the Request URL to the `SlackApiUrl` from the SAM deploy output
4. Slack will send a challenge request — the Lambda handles this automatically
5. Subscribe to bot events: `app_mention`, `message.channels`
6. Under "OAuth & Permissions", ensure scopes include: `app_mentions:read`, `chat:write`, `channels:history`, `reactions:write`, `users:read`

- [ ] **Step 3: Provision Pinpoint phone number**

1. In AWS Console → Amazon Pinpoint → your project
2. Request a dedicated phone number (long code or toll-free)
3. Enable two-way SMS on the number
4. Set the SNS topic to the `SmsTopicArn` from the SAM deploy output

- [ ] **Step 4: Test SMS end-to-end**

Send a text to the Pinpoint number:
- "The lobby printer is jammed" → should get severity prompt
- Reply "medium" → should get confirmation + AI suggestion
- Reply "it's near the front desk" → should get "added to notes"
- "NEW broken window" → should start new conversation

- [ ] **Step 5: Test Slack end-to-end**

In the `#maintenance` channel:
- `@FH Maintenance the AC is broken in room 4` → severity prompt
- Reply `critical` → confirmation + CC
- `@FH Maintenance list` → open issues
- `@FH Maintenance close #5` → resolved confirmation

- [ ] **Step 6: Decommission Raspberry Pi**

Once both channels are verified working:
1. Stop PM2 process on the Pi
2. Remove the bot from PM2 startup
3. Archive/backup the `.env` file from the Pi
