# Maintenance Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Slack bot that triages maintenance issues via @mentions, logs them to Google Sheets, detects duplicates, suggests fixes via Groq LLM, and posts weekly digests.

**Architecture:** Slack Bolt app in socket mode, self-hosted on a MacBook Air via PM2. Google Sheets for issue storage. Groq (Llama 3 70B, OpenAI-compatible API) for AI features. node-cron for weekly scheduling.

**Tech Stack:** Node.js, @slack/bolt, googleapis, openai (Groq-compatible), node-cron, pm2, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/config.js` | Load and validate env vars |
| `src/services/sheets.js` | Google Sheets CRUD (read issues, append issue, search) |
| `src/services/groq.js` | Groq LLM client (fix suggestions, dedup, digest) |
| `src/services/dedup.js` | Two-pass duplicate detection (keyword + AI) |
| `src/events/mention.js` | @mention event handler (triage, respond) |
| `src/jobs/weekly-digest.js` | Cron-triggered weekly summary |
| `src/app.js` | Bolt app init, socket mode, wire everything together |
| `tests/config.test.js` | Config validation tests |
| `tests/services/sheets.test.js` | Sheets service tests |
| `tests/services/groq.test.js` | Groq service tests |
| `tests/services/dedup.test.js` | Dedup logic tests |
| `tests/events/mention.test.js` | Mention handler tests |
| `tests/jobs/weekly-digest.test.js` | Weekly digest tests |

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/jyen/Projects/fh-maintenance-bot
git init
```

- [ ] **Step 2: Initialize npm project**

```bash
npm init -y
```

- [ ] **Step 3: Install dependencies**

```bash
npm install @slack/bolt googleapis openai node-cron
npm install -D vitest
```

- [ ] **Step 4: Create .gitignore**

```gitignore
node_modules/
.env
```

- [ ] **Step 5: Create .env.example**

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
SLACK_CHANNEL_ID=C0123456789
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_CREDENTIALS=base64-encoded-service-account-json
GROQ_API_KEY=your-groq-api-key
WEEKLY_DIGEST_CRON=0 9 * * 1
TIMEZONE=America/Los_Angeles
```

- [ ] **Step 6: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
{
  "scripts": {
    "start": "node src/app.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example
git commit -m "chore: initialize project with dependencies"
```

---

### Task 2: Config Module

**Files:**
- Create: `src/config.js`
- Create: `tests/config.test.js`

- [ ] **Step 1: Write failing tests for config**

Create `tests/config.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const VALID_ENV = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_CHANNEL_ID: "C123",
    GOOGLE_SHEET_ID: "sheet-id",
    GOOGLE_CREDENTIALS: Buffer.from(JSON.stringify({ type: "service_account" })).toString("base64"),
    GROQ_API_KEY: "gsk_test",
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
    expect(config.slackAppToken).toBe("xapp-test");
    expect(config.slackChannelId).toBe("C123");
    expect(config.googleSheetId).toBe("sheet-id");
    expect(config.googleCredentials).toEqual({ type: "service_account" });
    expect(config.groqApiKey).toBe("gsk_test");
  });

  it("uses defaults for optional vars", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.weeklyDigestCron).toBe("0 9 * * 1");
    expect(config.timezone).toBe("UTC");
  });

  it("throws if a required var is missing", async () => {
    process.env = { ...originalEnv };
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow("Missing required environment variable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/config.test.js
```

Expected: FAIL — `../src/config.js` does not exist.

- [ ] **Step 3: Implement config module**

Create `src/config.js`:

```js
const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_CHANNEL_ID",
  "GOOGLE_SHEET_ID",
  "GOOGLE_CREDENTIALS",
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
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleCredentials: JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString()
    ),
    groqApiKey: process.env.GROQ_API_KEY,
    weeklyDigestCron: process.env.WEEKLY_DIGEST_CRON || "0 9 * * 1",
    timezone: process.env.TIMEZONE || "UTC",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/config.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat: add config module with env var loading and validation"
```

---

### Task 3: Google Sheets Service

**Files:**
- Create: `src/services/sheets.js`
- Create: `tests/services/sheets.test.js`

- [ ] **Step 1: Write failing tests for sheets service**

Create `tests/services/sheets.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSheetsService } from "../../src/services/sheets.js";

describe("SheetsService", () => {
  let mockSheets;
  let service;

  beforeEach(() => {
    mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn(),
          append: vi.fn(),
          update: vi.fn(),
        },
      },
    };
    service = createSheetsService(mockSheets, "sheet-id");
  });

  describe("getOpenIssues", () => {
    it("returns open issues parsed from sheet rows", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["ID", "Timestamp", "Reporter", "Description", "Status", "AI Suggestion", "Message Link", "Resolved Date"],
            ["1", "2026-04-01T10:00:00Z", "U123", "Lobby printer jammed", "open", "Try restarting", "https://slack.com/msg1", ""],
            ["2", "2026-04-02T10:00:00Z", "U456", "AC broken in room 3", "resolved", "", "https://slack.com/msg2", "2026-04-03"],
          ],
        },
      });

      const issues = await service.getOpenIssues();
      expect(issues).toEqual([
        {
          id: "1",
          timestamp: "2026-04-01T10:00:00Z",
          reporter: "U123",
          description: "Lobby printer jammed",
          status: "open",
          aiSuggestion: "Try restarting",
          messageLink: "https://slack.com/msg1",
          resolvedDate: "",
        },
      ]);
    });

    it("returns empty array when sheet has only headers", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["ID", "Timestamp", "Reporter", "Description", "Status", "AI Suggestion", "Message Link", "Resolved Date"],
          ],
        },
      });

      const issues = await service.getOpenIssues();
      expect(issues).toEqual([]);
    });
  });

  describe("appendIssue", () => {
    it("appends a new row and returns the assigned ID", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [["ID"], ["1"], ["2"]] },
      });
      mockSheets.spreadsheets.values.append.mockResolvedValue({});

      const id = await service.appendIssue({
        reporter: "U789",
        description: "Water leak in bathroom",
        aiSuggestion: "Check the faucet",
        messageLink: "https://slack.com/msg3",
      });

      expect(id).toBe("3");
      expect(mockSheets.spreadsheets.values.append).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "Sheet1!A:H",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["3", expect.any(String), "U789", "Water leak in bathroom", "open", "Check the faucet", "https://slack.com/msg3", ""]],
        },
      });
    });
  });

  describe("getAllIssues", () => {
    it("returns all issues regardless of status", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["ID", "Timestamp", "Reporter", "Description", "Status", "AI Suggestion", "Message Link", "Resolved Date"],
            ["1", "2026-04-01T10:00:00Z", "U123", "Printer jammed", "open", "", "", ""],
            ["2", "2026-04-02T10:00:00Z", "U456", "AC broken", "resolved", "", "", "2026-04-03"],
          ],
        },
      });

      const issues = await service.getAllIssues();
      expect(issues).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/services/sheets.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement sheets service**

Create `src/services/sheets.js`:

```js
function parseRow(row) {
  return {
    id: row[0] || "",
    timestamp: row[1] || "",
    reporter: row[2] || "",
    description: row[3] || "",
    status: row[4] || "",
    aiSuggestion: row[5] || "",
    messageLink: row[6] || "",
    resolvedDate: row[7] || "",
  };
}

export function createSheetsService(sheetsClient, spreadsheetId) {
  async function getAllRows() {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:H",
    });
    const rows = res.data.values || [];
    return rows.slice(1); // skip header
  }

  async function getAllIssues() {
    const rows = await getAllRows();
    return rows.map(parseRow);
  }

  async function getOpenIssues() {
    const all = await getAllIssues();
    return all.filter((issue) => issue.status !== "resolved");
  }

  async function getNextId() {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:A",
    });
    const rows = res.data.values || [];
    const ids = rows.slice(1).map((r) => parseInt(r[0], 10)).filter(Boolean);
    return String(ids.length > 0 ? Math.max(...ids) + 1 : 1);
  }

  async function appendIssue({ reporter, description, aiSuggestion, messageLink }) {
    const id = await getNextId();
    const timestamp = new Date().toISOString();

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[id, timestamp, reporter, description, "open", aiSuggestion || "", messageLink || "", ""]],
      },
    });

    return id;
  }

  return { getAllIssues, getOpenIssues, appendIssue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/services/sheets.test.js
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/sheets.js tests/services/sheets.test.js
git commit -m "feat: add Google Sheets service for issue storage"
```

---

### Task 4: Groq LLM Service

**Files:**
- Create: `src/services/groq.js`
- Create: `tests/services/groq.test.js`

- [ ] **Step 1: Write failing tests for Groq service**

Create `tests/services/groq.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGroqService } from "../../src/services/groq.js";

describe("GroqService", () => {
  let mockClient;
  let service;

  beforeEach(() => {
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    service = createGroqService(mockClient);
  });

  describe("suggestFix", () => {
    it("returns the AI suggestion for an issue", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "Try restarting the printer." } }],
      });

      const result = await service.suggestFix("Lobby printer is jammed");
      expect(result).toBe("Try restarting the printer.");
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: expect.stringContaining("facilities/maintenance assistant"),
          },
          {
            role: "user",
            content: "Lobby printer is jammed",
          },
        ],
        max_tokens: 256,
      });
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.suggestFix("Something broke");
      expect(result).toBeNull();
    });
  });

  describe("checkDuplicate", () => {
    it("returns matching issue ID when duplicate found", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "3" } }],
      });

      const result = await service.checkDuplicate("printer broken", [
        { id: "3", description: "Lobby printer jammed" },
        { id: "5", description: "AC broken in room 3" },
      ]);

      expect(result).toBe("3");
    });

    it("returns null when no duplicate found", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "none" } }],
      });

      const result = await service.checkDuplicate("new issue", [
        { id: "1", description: "Printer jammed" },
      ]);

      expect(result).toBeNull();
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.checkDuplicate("test", []);
      expect(result).toBeNull();
    });
  });

  describe("generateDigest", () => {
    it("returns a summary of open issues", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "Weekly summary: 2 open issues..." } }],
      });

      const result = await service.generateDigest([
        { id: "1", description: "Printer jammed", status: "open" },
        { id: "2", description: "AC broken", status: "open" },
      ]);

      expect(result).toBe("Weekly summary: 2 open issues...");
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.generateDigest([]);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/services/groq.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement Groq service**

Create `src/services/groq.js`:

```js
const SYSTEM_PROMPT_FIX = `You are a facilities/maintenance assistant. A user reported an issue. If this is a trivial issue with a common fix, suggest a short actionable fix the reporter can try themselves. If it requires professional attention, say so briefly. Keep it under 3 sentences.`;

const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;

const SYSTEM_PROMPT_DIGEST = `Summarize these outstanding maintenance issues for a weekly update post in Slack. Group by priority/area if possible. Be concise and actionable. Use Slack formatting (bold with *, bullet lists).`;

export function createGroqService(client) {
  async function suggestFix(issueDescription) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_FIX },
          { role: "user", content: issueDescription },
        ],
        max_tokens: 256,
      });
      return res.choices[0].message.content;
    } catch {
      return null;
    }
  }

  async function checkDuplicate(newDescription, openIssues) {
    try {
      const issueList = openIssues
        .map((i) => `ID ${i.id}: ${i.description}`)
        .join("\n");

      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_DEDUP },
          {
            role: "user",
            content: `New report: "${newDescription}"\n\nExisting open issues:\n${issueList}`,
          },
        ],
        max_tokens: 32,
      });

      const answer = res.choices[0].message.content.trim().toLowerCase();
      if (answer === "none") return null;
      const matchedId = answer.match(/\d+/)?.[0];
      return matchedId && openIssues.some((i) => i.id === matchedId)
        ? matchedId
        : null;
    } catch {
      return null;
    }
  }

  async function generateDigest(openIssues) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_DIGEST },
          { role: "user", content: JSON.stringify(openIssues) },
        ],
        max_tokens: 1024,
      });
      return res.choices[0].message.content;
    } catch {
      return null;
    }
  }

  return { suggestFix, checkDuplicate, generateDigest };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/services/groq.test.js
```

Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/groq.js tests/services/groq.test.js
git commit -m "feat: add Groq LLM service for fix suggestions, dedup, and digest"
```

---

### Task 5: Duplicate Detection Service

**Files:**
- Create: `src/services/dedup.js`
- Create: `tests/services/dedup.test.js`

- [ ] **Step 1: Write failing tests for dedup**

Create `tests/services/dedup.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDedupService } from "../../src/services/dedup.js";

describe("DedupService", () => {
  let mockGroq;
  let service;

  beforeEach(() => {
    mockGroq = {
      checkDuplicate: vi.fn(),
    };
    service = createDedupService(mockGroq);
  });

  describe("findDuplicate", () => {
    const openIssues = [
      { id: "1", description: "Lobby printer is jammed" },
      { id: "2", description: "AC broken in conference room 3" },
    ];

    it("returns match from keyword pass without calling AI", async () => {
      const result = await service.findDuplicate("lobby printer jammed again!", openIssues);
      expect(result).toEqual({ id: "1", confident: true });
      expect(mockGroq.checkDuplicate).not.toHaveBeenCalled();
    });

    it("falls through to AI pass when no keyword match", async () => {
      mockGroq.checkDuplicate.mockResolvedValue("2");

      const result = await service.findDuplicate("the cooling in room 3 is not working", openIssues);
      expect(result).toEqual({ id: "2", confident: false });
      expect(mockGroq.checkDuplicate).toHaveBeenCalled();
    });

    it("returns null when neither pass finds a match", async () => {
      mockGroq.checkDuplicate.mockResolvedValue(null);

      const result = await service.findDuplicate("elevator stuck on floor 5", openIssues);
      expect(result).toBeNull();
    });

    it("returns null when there are no open issues", async () => {
      const result = await service.findDuplicate("something broke", []);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/services/dedup.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement dedup service**

Create `src/services/dedup.js`:

```js
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function getKeywords(text) {
  const stopWords = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "not", "it", "my", "our", "this", "that", "again", "still", "very", "just", "been", "has", "have", "was", "are", "but", "with"]);
  return normalize(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function keywordOverlap(a, b) {
  const setA = new Set(getKeywords(a));
  const wordsB = getKeywords(b);
  if (setA.size === 0 || wordsB.length === 0) return 0;
  const matches = wordsB.filter((w) => setA.has(w)).length;
  return matches / Math.min(setA.size, wordsB.length);
}

const KEYWORD_THRESHOLD = 0.5;

export function createDedupService(groqService) {
  async function findDuplicate(newDescription, openIssues) {
    if (openIssues.length === 0) return null;

    // Pass 1: keyword overlap
    let bestMatch = null;
    let bestScore = 0;
    for (const issue of openIssues) {
      const score = keywordOverlap(newDescription, issue.description);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = issue;
      }
    }

    if (bestScore >= KEYWORD_THRESHOLD && bestMatch) {
      return { id: bestMatch.id, confident: true };
    }

    // Pass 2: AI check (last 20)
    const recent = openIssues.slice(-20);
    const matchedId = await groqService.checkDuplicate(newDescription, recent);
    if (matchedId) {
      return { id: matchedId, confident: false };
    }

    return null;
  }

  return { findDuplicate };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/services/dedup.test.js
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/dedup.js tests/services/dedup.test.js
git commit -m "feat: add two-pass duplicate detection service"
```

---

### Task 6: Mention Event Handler

**Files:**
- Create: `src/events/mention.js`
- Create: `tests/events/mention.test.js`

- [ ] **Step 1: Write failing tests for mention handler**

Create `tests/events/mention.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMentionHandler } from "../../src/events/mention.js";

describe("MentionHandler", () => {
  let mockSheets;
  let mockGroq;
  let mockDedup;
  let handler;
  let mockSay;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("1"),
    };
    mockGroq = {
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
    };
    mockDedup = {
      findDuplicate: vi.fn().mockResolvedValue(null),
    };
    mockSay = vi.fn().mockResolvedValue({});
    handler = createMentionHandler({
      sheetsService: mockSheets,
      groqService: mockGroq,
      dedupService: mockDedup,
      channelId: "C123",
    });
  });

  it("ignores mentions outside the configured channel", async () => {
    await handler({
      event: { channel: "C999", text: "<@U_BOT> printer broke", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSay).not.toHaveBeenCalled();
  });

  it("asks for a description when mention has no text", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT>", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("describe the issue"),
        thread_ts: "1",
      })
    );
  });

  it("logs a new issue and replies with confirmation + suggestion", async () => {
    const mockPermalink = vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: mockPermalink } },
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "U1",
      description: "lobby printer jammed",
      aiSuggestion: "Try restarting it.",
      messageLink: "https://slack.com/msg",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged as issue #1"),
        thread_ts: "1",
      })
    );
  });

  it("notifies about duplicate when one is found confidently", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", reporter: "U2", timestamp: "2026-04-01", status: "open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: true });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("already been logged"),
        thread_ts: "1",
      })
    );
  });

  it("logs new issue with related note when dedup is uncertain", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", reporter: "U2", timestamp: "2026-04-01", status: "open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: false });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> can't print anything", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSheets.appendIssue).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("might be related to issue #5"),
        thread_ts: "1",
      })
    );
  });

  it("handles sheets failure gracefully", async () => {
    mockSheets.getOpenIssues.mockRejectedValue(new Error("Sheets down"));

    await handler({
      event: { channel: "C123", text: "<@U_BOT> something broke", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Couldn't log this issue"),
        thread_ts: "1",
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/events/mention.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement mention handler**

Create `src/events/mention.js`:

```js
function stripMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function createMentionHandler({ sheetsService, groqService, dedupService, channelId }) {
  return async function handleMention({ event, say, client }) {
    if (event.channel !== channelId) return;

    const description = stripMention(event.text);

    if (!description) {
      await say({
        text: "Please describe the issue you'd like to report.",
        thread_ts: event.ts,
      });
      return;
    }

    let openIssues;
    try {
      openIssues = await sheetsService.getOpenIssues();
    } catch {
      await say({
        text: "Couldn't log this issue right now — please try again in a few minutes.",
        thread_ts: event.ts,
      });
      return;
    }

    const duplicate = await dedupService.findDuplicate(description, openIssues);

    if (duplicate && duplicate.confident) {
      const existing = openIssues.find((i) => i.id === duplicate.id);
      await say({
        text: `This issue has already been logged (issue #${duplicate.id}, reported by <@${existing.reporter}> on ${existing.timestamp}). Current status: *${existing.status}*`,
        thread_ts: event.ts,
      });
      return;
    }

    const suggestion = await groqService.suggestFix(description);

    let permalink = "";
    try {
      const res = await client.chat.getPermalink({ channel: event.channel, message_ts: event.ts });
      permalink = res.permalink;
    } catch {
      // non-critical
    }

    let id;
    try {
      id = await sheetsService.appendIssue({
        reporter: event.user,
        description,
        aiSuggestion: suggestion || "",
        messageLink: permalink,
      });
    } catch {
      await say({
        text: "Couldn't log this issue right now — please try again in a few minutes.",
        thread_ts: event.ts,
      });
      return;
    }

    let responseText = `Logged as issue #${id}.`;

    if (duplicate && !duplicate.confident) {
      responseText += ` This might be related to issue #${duplicate.id}.`;
    }

    if (suggestion) {
      responseText += `\n\n*Suggested fix:* ${suggestion}`;
    } else {
      responseText += `\nCouldn't generate a suggestion right now.`;
    }

    await say({
      text: responseText,
      thread_ts: event.ts,
    });
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/events/mention.test.js
```

Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/mention.js tests/events/mention.test.js
git commit -m "feat: add mention event handler with dedup, logging, and AI suggestions"
```

---

### Task 7: Weekly Digest Job

**Files:**
- Create: `src/jobs/weekly-digest.js`
- Create: `tests/jobs/weekly-digest.test.js`

- [ ] **Step 1: Write failing tests for weekly digest**

Create `tests/jobs/weekly-digest.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWeeklyDigest } from "../../src/jobs/weekly-digest.js";

describe("WeeklyDigest", () => {
  let mockSheets;
  let mockGroq;
  let mockSlackClient;
  let digest;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn(),
    };
    mockGroq = {
      generateDigest: vi.fn(),
    };
    mockSlackClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    };
    digest = createWeeklyDigest({
      sheetsService: mockSheets,
      groqService: mockGroq,
      slackClient: mockSlackClient,
      channelId: "C123",
    });
  });

  it("posts AI-generated summary when there are open issues", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Printer jammed", status: "open" },
      { id: "2", description: "AC broken", status: "open" },
    ]);
    mockGroq.generateDigest.mockResolvedValue("*Weekly Summary:* 2 issues remain open...");

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("Weekly Summary"),
    });
  });

  it("posts no-issues message when all resolved", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([]);

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("No outstanding issues this week"),
    });
  });

  it("posts fallback list when Groq fails", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Printer jammed", status: "open" },
    ]);
    mockGroq.generateDigest.mockResolvedValue(null);

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("#1"),
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/jobs/weekly-digest.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement weekly digest**

Create `src/jobs/weekly-digest.js`:

```js
import cron from "node-cron";

export function createWeeklyDigest({ sheetsService, groqService, slackClient, channelId }) {
  async function run() {
    const openIssues = await sheetsService.getOpenIssues();

    if (openIssues.length === 0) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: "No outstanding issues this week. All clear!",
      });
      return;
    }

    const summary = await groqService.generateDigest(openIssues);

    if (summary) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `*Weekly Maintenance Digest*\n\n${summary}`,
      });
    } else {
      const fallback = openIssues
        .map((i) => `• #${i.id}: ${i.description} (${i.status})`)
        .join("\n");
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `*Weekly Maintenance Digest*\n\nCouldn't generate AI summary. Open issues:\n${fallback}`,
      });
    }
  }

  function schedule(cronExpression, timezone) {
    cron.schedule(cronExpression, run, { timezone });
  }

  return { run, schedule };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/jobs/weekly-digest.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/weekly-digest.js tests/jobs/weekly-digest.test.js
git commit -m "feat: add weekly digest job with cron scheduling"
```

---

### Task 8: App Entry Point

**Files:**
- Create: `src/app.js`

- [ ] **Step 1: Implement the main app entry point**

Create `src/app.js`:

```js
import pkg from "@slack/bolt";
const { App } = pkg;
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { createSheetsService } from "./services/sheets.js";
import { createGroqService } from "./services/groq.js";
import { createDedupService } from "./services/dedup.js";
import { createMentionHandler } from "./events/mention.js";
import { createWeeklyDigest } from "./jobs/weekly-digest.js";

const config = loadConfig();

// Slack Bolt app
const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

// Google Sheets client
const auth = new google.auth.GoogleAuth({
  credentials: config.googleCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsClient = google.sheets({ version: "v4", auth });
const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

// Groq client
const groqClient = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: config.groqApiKey,
});
const groqService = createGroqService(groqClient);

// Dedup service
const dedupService = createDedupService(groqService);

// Register event handler
const mentionHandler = createMentionHandler({
  sheetsService,
  groqService,
  dedupService,
  channelId: config.slackChannelId,
});
app.event("app_mention", mentionHandler);

// Schedule weekly digest
const weeklyDigest = createWeeklyDigest({
  sheetsService,
  groqService,
  slackClient: app.client,
  channelId: config.slackChannelId,
});
weeklyDigest.schedule(config.weeklyDigestCron, config.timezone);

// Start
(async () => {
  await app.start();
  console.log("Maintenance bot is running");
})();
```

- [ ] **Step 2: Add `"type": "module"` to package.json**

In `package.json`, add at the top level:
```json
{
  "type": "module"
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app.js package.json
git commit -m "feat: add app entry point wiring all services together"
```

---

### Task 9: Run Full Test Suite and Final Verification

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass (20+ tests across 6 test files).

- [ ] **Step 2: Verify the app starts without env vars (expect config error)**

```bash
node src/app.js 2>&1 || true
```

Expected: Error message containing "Missing required environment variable" — confirms config validation works.

- [ ] **Step 3: Commit any remaining changes**

```bash
git status
```

If any unstaged changes exist, add and commit them.

- [ ] **Step 4: Final commit with all green tests**

```bash
git add -A
git commit -m "chore: verify all tests pass, project ready for deployment"
```
