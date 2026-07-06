# In-Thread Maintenance Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the maintenance chatbot's multi-turn severity Q&A with a single in-thread Block Kit form (description input + issue-type dropdown + severity dropdown + Submit button).

**Architecture:** Slack events flow API Gateway → receiver Lambda (signature verify, filter, enqueue) → SQS → worker Lambda → `dispatchSlackEvent` → handlers. A mention now posts a Block Kit form message in the thread. Clicking Submit sends a `block_actions` interactivity payload (form-encoded `payload=` param) to the same endpoint; the receiver enqueues it as a `{type: "block_actions", payload}` envelope and a new form-submit handler logs the issue. All form field values arrive in `payload.state.values`, so the old in-memory pending-severity cache and thread-transcript recovery machinery are deleted.

**Tech Stack:** Node.js ES modules, AWS Lambda + SQS (SAM), `@slack/web-api`, Google Sheets API, vitest.

**Spec:** `docs/superpowers/specs/2026-07-06-maintenance-form-design.md`

## Global Constraints

- Severity options (values written to sheet verbatim): `Minor`, `Medium`, `Critical`.
- Issue type options (values written to sheet verbatim, in this order): `Lighting`, `Elevator`, `Pest Control`, `Electrical`, `Plumbing`, `HVAC`, `Janitorial`, `Other`.
- Sheet columns become A–J: A=DATE, B=SUBMITTER, C=ISSUE, D=PRIORITY, E=DAYS SINCE FILED, F=IN CHARGE, G=STATUS, H=NOTES, I=PHOTOS, J=TYPE.
- cc mention on Medium/Critical: `cc <@U05SWHWFTEH>` (existing behavior, keep verbatim).
- Dedup is warn-only — never blocks logging.
- Dropped entirely: LLM maintenance classification, LLM suggested fix, inline severity parsing, `create new:` bypass, severity text-reply flow.
- Kept: list/status text command, close/resolve text commands, notes/photos append in threads of logged issues, eyes reaction, channel filter.
- Run tests with: `npx vitest run <file>` (or all: `npx vitest run`).

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/maintenance-form.js` | Create | Pure Block Kit builders + `state.values` extraction (no I/O) |
| `src/events/maintenanceForm.js` | Create | `block_actions` submit handler (dedup → append → chat.update) |
| `src/lambda/receiver.js` | Modify | Parse form-encoded `payload=` interactivity, enqueue envelope |
| `src/lambda/dispatch.js` | Modify | Route `block_actions` envelope to form handler |
| `src/lambda/worker.js` | Modify | Thread `maintenanceFormHandler` through |
| `src/lambda/clients.js` | Modify | Wire form handler, shared `createdIssues` map |
| `src/events/mention.js` | Modify | Post form on mention; delete severity/classify/suggest machinery |
| `src/services/sheets.js` | Modify | TYPE column J |
| `src/services/groq.js` | Modify | Remove `suggestFix`, `isMaintenanceRequest` |
| `src/lib/severity.js` | Delete | No remaining callers |
| `tests/lib/maintenance-form.test.js` | Create | Block builders + extraction |
| `tests/events/maintenanceForm.test.js` | Create | Submit handler behaviors |
| `tests/lib/severity.test.js` | Delete | Module deleted |
| `tests/{lambda,events,services}/*.test.js` | Modify | Match new behavior |

---

### Task 1: Sheets TYPE column (J)

**Files:**
- Modify: `src/services/sheets.js`
- Test: `tests/services/sheets.test.js`

**Interfaces:**
- Produces: `appendIssue({ reporter, description, severity, type, photos })` — `type` is a string like `"Plumbing"`, written to column J; still returns `String(DATA_START_ROW)`. `parseRow` output gains `type` property. `DATA_RANGE` becomes `'Maintenance Request'!A5:J`.

- [ ] **Step 1: Write failing tests**

In `tests/services/sheets.test.js`, update the existing `appendIssue` assertions that expect range `'Maintenance Request'!A5:I5` to expect `'Maintenance Request'!A5:J5`, and add a `type` case. Follow the file's existing mock pattern (look at the current `appendIssue` describe block for the mock `sheetsClient` shape). Add:

```javascript
it("writes the issue type into column J", async () => {
  await service.appendIssue({
    reporter: "Test User",
    description: "leak under sink",
    severity: "Medium",
    type: "Plumbing",
  });

  const updateCall = mockSheetsClient.spreadsheets.values.update.mock.calls[0][0];
  expect(updateCall.range).toBe("'Maintenance Request'!A5:J5");
  const row = updateCall.requestBody.values[0];
  expect(row).toHaveLength(10);
  expect(row[9]).toBe("Plumbing");
});

it("writes an empty TYPE cell when type is omitted", async () => {
  await service.appendIssue({
    reporter: "Test User",
    description: "leak under sink",
    severity: "Medium",
  });

  const row = mockSheetsClient.spreadsheets.values.update.mock.calls[0][0].requestBody.values[0];
  expect(row[9]).toBe("");
});
```

Also update any test asserting the read range `'Maintenance Request'!A5:I` to `'Maintenance Request'!A5:J` (check the `getAllIssues`/`getOpenIssues` describe blocks), and if `parseRow` output is asserted, add `type: ""` where a 9-element row is parsed.

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/services/sheets.test.js`
Expected: FAIL — range mismatch `A5:I5` vs `A5:J5`, row length 9 vs 10.

- [ ] **Step 3: Implement**

In `src/services/sheets.js`:

Line 1 comment becomes:
```javascript
// Columns: A=DATE, B=SUBMITTER, C=ISSUE, D=PRIORITY, E=DAYS SINCE FILED, F=IN CHARGE, G=STATUS, H=NOTES, I=PHOTOS, J=TYPE
```

`DATA_RANGE`:
```javascript
const DATA_RANGE = `'${SHEET_NAME}'!A${DATA_START_ROW}:J`;
```

`parseRow` gains:
```javascript
    photos: row[8] || "",
    type: row[9] || "",
```

`appendIssue` signature and write:
```javascript
  async function appendIssue({ reporter, description, severity, type, photos }) {
```
```javascript
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A${DATA_START_ROW}:J${DATA_START_ROW}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          today, reporter, description, severity || "", `=TODAY()-A${DATA_START_ROW}`, "", "Need to Assign", "",
          photoLinksText(photos), type || "",
        ]],
      },
    });
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/services/sheets.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/sheets.js tests/services/sheets.test.js
git commit -m "feat(sheets): add TYPE column J to maintenance rows"
```

---

### Task 2: Form blocks library (pure functions)

**Files:**
- Create: `src/lib/maintenance-form.js`
- Test: `tests/lib/maintenance-form.test.js`

**Interfaces:**
- Produces:
  - `buildMaintenanceFormBlocks(initialDescription)` → Block Kit array: description `input` block (block_id `issue_description`, plain_text_input action_id `description`, multiline, `initial_value` only when `initialDescription` non-empty), type `input` block (block_id `issue_type`, static_select action_id `type`), severity `input` block (block_id `issue_severity`, static_select action_id `severity`), and an `actions` block (block_id `submit_actions`) with one primary button action_id `submit_maintenance_form`.
  - `extractFormValues(stateValues)` → `{ description, type, severity }` (strings or `null` when unset; description trimmed, empty → `null`).
  - `SUBMIT_ACTION_ID = "submit_maintenance_form"`.
  - `ISSUE_TYPES = ["Lighting", "Elevator", "Pest Control", "Electrical", "Plumbing", "HVAC", "Janitorial", "Other"]`.
  - `SEVERITIES = ["Minor", "Medium", "Critical"]`.

- [ ] **Step 1: Write failing tests**

Create `tests/lib/maintenance-form.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import {
  buildMaintenanceFormBlocks,
  extractFormValues,
  SUBMIT_ACTION_ID,
  ISSUE_TYPES,
  SEVERITIES,
} from "../../src/lib/maintenance-form.js";

describe("buildMaintenanceFormBlocks", () => {
  it("builds description, type, severity inputs and a submit button", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");

    const description = blocks.find((b) => b.block_id === "issue_description");
    expect(description.type).toBe("input");
    expect(description.element.type).toBe("plain_text_input");
    expect(description.element.action_id).toBe("description");
    expect(description.element.multiline).toBe(true);
    expect(description.element.initial_value).toBe("sink leaking");

    const type = blocks.find((b) => b.block_id === "issue_type");
    expect(type.element.type).toBe("static_select");
    expect(type.element.action_id).toBe("type");
    expect(type.element.options.map((o) => o.value)).toEqual(ISSUE_TYPES);

    const severity = blocks.find((b) => b.block_id === "issue_severity");
    expect(severity.element.type).toBe("static_select");
    expect(severity.element.action_id).toBe("severity");
    expect(severity.element.options.map((o) => o.value)).toEqual(SEVERITIES);

    const actions = blocks.find((b) => b.block_id === "submit_actions");
    expect(actions.type).toBe("actions");
    expect(actions.elements[0].action_id).toBe(SUBMIT_ACTION_ID);
  });

  it("omits initial_value when no description prefill", () => {
    const blocks = buildMaintenanceFormBlocks("");
    const description = blocks.find((b) => b.block_id === "issue_description");
    expect(description.element).not.toHaveProperty("initial_value");
  });

  it("offers the expected issue types in order", () => {
    expect(ISSUE_TYPES).toEqual([
      "Lighting", "Elevator", "Pest Control", "Electrical",
      "Plumbing", "HVAC", "Janitorial", "Other",
    ]);
  });
});

describe("extractFormValues", () => {
  it("extracts all three values from state.values", () => {
    const stateValues = {
      issue_description: { description: { type: "plain_text_input", value: "  sink leaking  " } },
      issue_type: { type: { type: "static_select", selected_option: { value: "Plumbing" } } },
      issue_severity: { severity: { type: "static_select", selected_option: { value: "Medium" } } },
    };
    expect(extractFormValues(stateValues)).toEqual({
      description: "sink leaking",
      type: "Plumbing",
      severity: "Medium",
    });
  });

  it("returns nulls for unset fields", () => {
    expect(extractFormValues({})).toEqual({ description: null, type: null, severity: null });
    expect(
      extractFormValues({
        issue_description: { description: { type: "plain_text_input", value: "   " } },
      })
    ).toEqual({ description: null, type: null, severity: null });
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/lib/maintenance-form.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/maintenance-form.js`:

```javascript
export const SUBMIT_ACTION_ID = "submit_maintenance_form";

export const ISSUE_TYPES = [
  "Lighting",
  "Elevator",
  "Pest Control",
  "Electrical",
  "Plumbing",
  "HVAC",
  "Janitorial",
  "Other",
];

export const SEVERITIES = ["Minor", "Medium", "Critical"];

function selectOptions(values) {
  return values.map((v) => ({
    text: { type: "plain_text", text: v },
    value: v,
  }));
}

export function buildMaintenanceFormBlocks(initialDescription) {
  const descriptionElement = {
    type: "plain_text_input",
    action_id: "description",
    multiline: true,
    ...(initialDescription ? { initial_value: initialDescription } : {}),
  };

  return [
    {
      type: "input",
      block_id: "issue_description",
      label: { type: "plain_text", text: "Issue" },
      element: descriptionElement,
    },
    {
      type: "input",
      block_id: "issue_type",
      label: { type: "plain_text", text: "Type" },
      element: {
        type: "static_select",
        action_id: "type",
        placeholder: { type: "plain_text", text: "Select a type" },
        options: selectOptions(ISSUE_TYPES),
      },
    },
    {
      type: "input",
      block_id: "issue_severity",
      label: { type: "plain_text", text: "Severity" },
      element: {
        type: "static_select",
        action_id: "severity",
        placeholder: { type: "plain_text", text: "Select severity" },
        options: selectOptions(SEVERITIES),
      },
    },
    {
      type: "actions",
      block_id: "submit_actions",
      elements: [
        {
          type: "button",
          action_id: SUBMIT_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Submit" },
        },
      ],
    },
  ];
}

export function extractFormValues(stateValues) {
  const description =
    (stateValues?.issue_description?.description?.value || "").trim() || null;
  const type =
    stateValues?.issue_type?.type?.selected_option?.value || null;
  const severity =
    stateValues?.issue_severity?.severity?.selected_option?.value || null;
  return { description, type, severity };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/lib/maintenance-form.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/maintenance-form.js tests/lib/maintenance-form.test.js
git commit -m "feat(maintenance): Block Kit form builders and value extraction"
```

---

### Task 3: Form-submit handler

**Files:**
- Create: `src/events/maintenanceForm.js`
- Test: `tests/events/maintenanceForm.test.js`

**Interfaces:**
- Consumes: `extractFormValues`, `SUBMIT_ACTION_ID` from `src/lib/maintenance-form.js` (Task 2); `sheetsService.appendIssue({reporter, description, severity, type, photos})` and `sheetsService.getOpenIssues()` (Task 1); `dedupService.findDuplicate(description, issues)` → `{id, confident} | null`; `photoService.collectPhotos(files)`.
- Produces: `createMaintenanceFormHandler({ sheetsService, dedupService, photoService, spreadsheetId, createdIssues })` → `async function handleFormSubmission({ payload, client })`. `createdIssues` is a `Map` shared with the mention handler (threadKey → rowId).

**Relevant `block_actions` payload shape** (what Slack sends when the button is clicked):

```javascript
{
  type: "block_actions",
  user: { id: "U1" },
  channel: { id: "C123" },
  actions: [{ action_id: "submit_maintenance_form", ... }],
  message: { ts: "1700000000.100", thread_ts: "1700000000.000", blocks: [...] },
  state: { values: { issue_description: {...}, issue_type: {...}, issue_severity: {...} } },
}
```

`message.ts` is the form message itself; `message.thread_ts` is the thread root (the original mention). For a form posted as a reply, `thread_ts` is always present.

- [ ] **Step 1: Write failing tests**

Create `tests/events/maintenanceForm.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMaintenanceFormHandler } from "../../src/events/maintenanceForm.js";

function makePayload(overrides = {}) {
  return {
    type: "block_actions",
    user: { id: "U1" },
    channel: { id: "C123" },
    actions: [{ action_id: "submit_maintenance_form" }],
    message: {
      ts: "100.2",
      thread_ts: "100.1",
      blocks: [{ block_id: "submit_actions", type: "actions" }],
    },
    state: {
      values: {
        issue_description: { description: { value: "sink leaking" } },
        issue_type: { type: { selected_option: { value: "Plumbing" } } },
        issue_severity: { severity: { selected_option: { value: "Medium" } } },
      },
    },
    ...overrides,
  };
}

describe("MaintenanceFormHandler", () => {
  let mockSheets;
  let mockDedup;
  let mockPhotos;
  let mockClient;
  let createdIssues;
  let handler;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("5"),
    };
    mockDedup = { findDuplicate: vi.fn().mockResolvedValue(null) };
    mockPhotos = { collectPhotos: vi.fn().mockResolvedValue([]) };
    mockClient = {
      users: {
        info: vi.fn().mockResolvedValue({ user: { real_name: "Test User", name: "testuser" } }),
      },
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ ts: "100.1", text: "<@U_BOT> sink leaking", files: [] }] }),
      },
      chat: {
        update: vi.fn().mockResolvedValue({}),
        postMessage: vi.fn().mockResolvedValue({}),
        postEphemeral: vi.fn().mockResolvedValue({}),
      },
    };
    createdIssues = new Map();
    handler = createMaintenanceFormHandler({
      sheetsService: mockSheets,
      dedupService: mockDedup,
      photoService: mockPhotos,
      spreadsheetId: "sheet-id",
      createdIssues,
    });
  });

  it("logs the issue and replaces the form with a confirmation", async () => {
    await handler({ payload: makePayload(), client: mockClient });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "sink leaking",
      severity: "Medium",
      type: "Plumbing",
    });
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "100.2",
        text: expect.stringContaining("Logged your issue"),
      })
    );
    const updateArg = mockClient.chat.update.mock.calls[0][0];
    expect(updateArg.text).toContain("*Medium*");
    expect(updateArg.text).toContain("*Plumbing*");
    expect(updateArg.text).toContain("docs.google.com/spreadsheets/d/sheet-id");
    expect(createdIssues.get("100.1")).toBe("5");
  });

  it("ccs the facilities lead on Medium and Critical", async () => {
    await handler({ payload: makePayload(), client: mockClient });
    expect(mockClient.chat.update.mock.calls[0][0].text).toContain("cc <@U05SWHWFTEH>");

    mockClient.chat.update.mockClear();
    const minor = makePayload();
    minor.state.values.issue_severity.severity.selected_option.value = "Minor";
    await handler({ payload: minor, client: mockClient });
    expect(mockClient.chat.update.mock.calls[0][0].text).not.toContain("cc <@U05SWHWFTEH>");
  });

  it("prompts ephemerally when required fields are missing and keeps the form", async () => {
    const payload = makePayload();
    payload.state.values.issue_description.description.value = "   ";

    await handler({ payload, client: mockClient });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockClient.chat.update).not.toHaveBeenCalled();
    expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", user: "U1", thread_ts: "100.1" })
    );
  });

  it("warns about a possible duplicate but logs anyway", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "7", description: "leak under the sink", date: new Date().toLocaleDateString("en-US"), status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "7", confident: true });

    await handler({ payload: makePayload(), client: mockClient });

    expect(mockSheets.appendIssue).toHaveBeenCalled();
    expect(mockClient.chat.update.mock.calls[0][0].text).toContain("related to issue #7");
  });

  it("only checks recent issues for duplicates (7-day window)", async () => {
    const old = new Date();
    old.setDate(old.getDate() - 30);
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "3", description: "old leak", date: old.toLocaleDateString("en-US"), status: "Open" },
    ]);

    await handler({ payload: makePayload(), client: mockClient });

    expect(mockDedup.findDuplicate).toHaveBeenCalledWith("sink leaking", []);
  });

  it("collects photos from the thread-root mention message", async () => {
    const rootFiles = [{ id: "F1", name: "leak.jpg" }];
    mockClient.conversations.replies.mockResolvedValue({
      messages: [{ ts: "100.1", text: "<@U_BOT> sink leaking", files: rootFiles }],
    });
    mockPhotos.collectPhotos.mockResolvedValue([{ viewUrl: "https://drive/x" }]);

    await handler({ payload: makePayload(), client: mockClient });

    expect(mockPhotos.collectPhotos).toHaveBeenCalledWith(rootFiles);
    expect(mockSheets.appendIssue).toHaveBeenCalledWith(
      expect.objectContaining({ photos: [{ viewUrl: "https://drive/x" }] })
    );
  });

  it("posts an error and keeps the form when the sheet write fails", async () => {
    mockSheets.appendIssue.mockRejectedValue(new Error("boom"));

    await handler({ payload: makePayload(), client: mockClient });

    expect(mockClient.chat.update).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "100.1",
        text: expect.stringContaining("Couldn't log this issue"),
      })
    );
  });

  it("ignores a late duplicate submit (form already replaced)", async () => {
    const payload = makePayload();
    payload.message.blocks = [{ type: "section", text: { type: "mrkdwn", text: "Logged your issue" } }];

    await handler({ payload, client: mockClient });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockClient.chat.update).not.toHaveBeenCalled();
  });

  it("falls back to the user id when users.info fails", async () => {
    mockClient.users.info.mockRejectedValue(new Error("nope"));

    await handler({ payload: makePayload(), client: mockClient });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith(
      expect.objectContaining({ reporter: "U1" })
    );
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/events/maintenanceForm.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/events/maintenanceForm.js`:

```javascript
import { extractFormValues } from "../lib/maintenance-form.js";

export function createMaintenanceFormHandler({ sheetsService, dedupService, photoService, spreadsheetId, createdIssues }) {
  async function collectRootPhotos(client, channel, threadTs) {
    if (!photoService || !threadTs) return [];
    try {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
      const root = res.messages?.[0];
      if (!root?.files?.length) return [];
      return await photoService.collectPhotos(root.files);
    } catch (err) {
      console.error("collectRootPhotos failed:", err.message);
      return [];
    }
  }

  return async function handleFormSubmission({ payload, client }) {
    const channel = payload.channel?.id;
    const formTs = payload.message?.ts;
    const threadTs = payload.message?.thread_ts || formTs;
    const userId = payload.user?.id;

    // A submit for a message whose form blocks are gone is a late duplicate
    // click — the first submit already replaced the form with a confirmation.
    const stillHasForm = (payload.message?.blocks || []).some(
      (b) => b.block_id === "submit_actions"
    );
    if (!stillHasForm) return;

    const { description, type, severity } = extractFormValues(payload.state?.values);
    if (!description || !type || !severity) {
      try {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          thread_ts: threadTs,
          text: "Please fill in the issue description, type, and severity, then hit Submit again.",
        });
      } catch (err) {
        console.error("postEphemeral failed:", err.message);
      }
      return;
    }

    let reporterName = userId;
    try {
      const userInfo = await client.users.info({ user: userId });
      reporterName = userInfo.user.real_name || userInfo.user.name || userId;
    } catch (err) {
      console.error("Failed to fetch user info:", err.message);
    }

    // Duplicate detection is warn-only: it never blocks logging.
    let duplicate = null;
    try {
      const openIssues = await sheetsService.getOpenIssues();
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const recentIssues = openIssues.filter((issue) => {
        const parsed = new Date(issue.date);
        return !isNaN(parsed) && parsed >= sevenDaysAgo;
      });
      duplicate = await dedupService.findDuplicate(description, recentIssues);
    } catch (err) {
      console.error("dedup check failed:", err.message);
    }

    const photos = await collectRootPhotos(client, channel, payload.message?.thread_ts);

    let id;
    try {
      id = await sheetsService.appendIssue({
        reporter: reporterName,
        description,
        severity,
        type,
        ...(photos.length ? { photos } : {}),
      });
    } catch (err) {
      console.error("appendIssue failed:", err.message);
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "Couldn't log this issue right now — please try again in a few minutes.",
        });
      } catch (postErr) {
        console.error("postMessage failed:", postErr.message);
      }
      return;
    }

    createdIssues.set(threadTs, id);

    const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    let text = `Logged your issue (severity: *${severity}*, type: *${type}*). <${docLink}|View in Google Sheets>`;
    if (duplicate) {
      text += `\nThis might be related to issue #${duplicate.id}.`;
    }
    text += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
    if (severity === "Medium" || severity === "Critical") {
      text += `\n\ncc <@U05SWHWFTEH>`;
    }

    try {
      await client.chat.update({
        channel,
        ts: formTs,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    } catch (err) {
      console.error("chat.update failed:", err.message);
      await client.chat.postMessage({ channel, thread_ts: threadTs, text });
    }
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/events/maintenanceForm.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/maintenanceForm.js tests/events/maintenanceForm.test.js
git commit -m "feat(maintenance): form-submit handler logs issue from block_actions"
```

---

### Task 4: Receiver parses interactivity payloads

**Files:**
- Modify: `src/lambda/receiver.js`
- Test: `tests/lambda/receiver.test.js`

**Interfaces:**
- Produces: SQS envelope `{ type: "block_actions", payload: <parsed interactivity payload> }`. Slash-command envelopes unchanged.

Interactivity requests are form-encoded like slash commands, but carry a single `payload` parameter containing JSON. Distinguish by the presence of `payload`.

- [ ] **Step 1: Write failing tests**

In `tests/lambda/receiver.test.js`, follow the existing test setup (see the "enqueues a slash command envelope" test for how form-encoded bodies and signatures are built). Add:

```javascript
it("enqueues a block_actions envelope from an interactivity payload", async () => {
  const interactivity = {
    type: "block_actions",
    user: { id: "U1" },
    actions: [{ action_id: "submit_maintenance_form" }],
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(interactivity))}`;
  const res = await invoke(body, { contentType: "application/x-www-form-urlencoded" });

  expect(res.statusCode).toBe(200);
  const sent = JSON.parse(lastSqsMessage());
  expect(sent.type).toBe("block_actions");
  expect(sent.payload.actions[0].action_id).toBe("submit_maintenance_form");
});

it("acks and drops non-block_actions interactivity payloads", async () => {
  const body = `payload=${encodeURIComponent(JSON.stringify({ type: "view_submission" }))}`;
  const res = await invoke(body, { contentType: "application/x-www-form-urlencoded" });

  expect(res.statusCode).toBe(200);
  expectNothingEnqueued();
});

it("400s a malformed interactivity payload", async () => {
  const body = `payload=${encodeURIComponent("{not json")}`;
  const res = await invoke(body, { contentType: "application/x-www-form-urlencoded" });

  expect(res.statusCode).toBe(400);
});
```

Adapt `invoke`, `lastSqsMessage`, `expectNothingEnqueued` to whatever helpers the file actually uses — read the existing tests first and mirror their signing/mock plumbing exactly.

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/lambda/receiver.test.js`
Expected: the new tests FAIL — current code treats the body as a slash command and 400s on missing `command`/`response_url` (so the block_actions test gets 400, not 200).

- [ ] **Step 3: Implement**

In `src/lambda/receiver.js`, inside the `isFormEncoded(contentType)` branch, handle interactivity before slash parsing:

```javascript
  if (isFormEncoded(contentType)) {
    const params = new URLSearchParams(body);
    const interactivityPayload = params.get("payload");
    if (interactivityPayload) {
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(interactivityPayload);
      } catch {
        return { statusCode: 400, body: "invalid interactivity payload" };
      }
      if (parsedPayload.type !== "block_actions") {
        return { statusCode: 200, body: "" };
      }
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: process.env.EVENT_QUEUE_URL,
          MessageBody: JSON.stringify({ type: "block_actions", payload: parsedPayload }),
        })
      );
      return { statusCode: 200, body: "" };
    }

    const slash = parseSlashCommand(body);
    // ... existing slash handling unchanged
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/lambda/receiver.test.js`
Expected: PASS (all — existing slash tests must still pass).

- [ ] **Step 5: Commit**

```bash
git add src/lambda/receiver.js tests/lambda/receiver.test.js
git commit -m "feat(receiver): enqueue block_actions interactivity payloads"
```

---

### Task 5: Dispatch + worker routing

**Files:**
- Modify: `src/lambda/dispatch.js`
- Modify: `src/lambda/worker.js`
- Test: `tests/lambda/dispatch.test.js`, `tests/lambda/worker.test.js`

**Interfaces:**
- Consumes: `{ type: "block_actions", payload }` envelope (Task 4); `handleFormSubmission({ payload, client })` (Task 3).
- Produces: `dispatchSlackEvent({ slackEnvelope, ..., maintenanceFormHandler, client })` — new optional `maintenanceFormHandler` param. `getDeps()` (Task 6) will supply it as `maintenanceFormHandler`.

- [ ] **Step 1: Write failing tests**

In `tests/lambda/dispatch.test.js` (mirror existing test style — handlers are `vi.fn()`, `client` is a stub):

```javascript
it("routes a block_actions envelope to the maintenance form handler", async () => {
  const maintenanceFormHandler = vi.fn();
  const client = {};
  const envelope = { type: "block_actions", payload: { actions: [{ action_id: "submit_maintenance_form" }] } };

  await dispatchSlackEvent({ slackEnvelope: envelope, handler: vi.fn(), maintenanceFormHandler, client });

  expect(maintenanceFormHandler).toHaveBeenCalledWith({ payload: envelope.payload, client });
});

it("is a no-op for block_actions when no maintenanceFormHandler provided", async () => {
  const handler = vi.fn();
  await dispatchSlackEvent({
    slackEnvelope: { type: "block_actions", payload: {} },
    handler,
    client: {},
  });
  expect(handler).not.toHaveBeenCalled();
});
```

In `tests/lambda/worker.test.js`, extend the existing `getDeps` mock to include `maintenanceFormHandler` and assert it is passed through to `dispatchSlackEvent` (mirror how `reservationHandler` is asserted there today).

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/lambda/dispatch.test.js tests/lambda/worker.test.js`
Expected: new tests FAIL (`maintenanceFormHandler` never called / not passed).

- [ ] **Step 3: Implement**

`src/lambda/dispatch.js` — add param and route at the top, right after the slash-command block:

```javascript
export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, reservationHandler, maintenanceFormHandler, onestopChannelId, client }) {
  if (slackEnvelope.type === "slash_command") {
    // ... unchanged
    return;
  }

  if (slackEnvelope.type === "block_actions") {
    if (maintenanceFormHandler) {
      await maintenanceFormHandler({ payload: slackEnvelope.payload, client });
    }
    return;
  }
```

`src/lambda/worker.js`:

```javascript
export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler, slashRefreshHandler, reservationHandler, maintenanceFormHandler, onestopChannelId } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      genderHandler,
      slashRefreshHandler,
      reservationHandler,
      maintenanceFormHandler,
      onestopChannelId,
      client,
    });
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/lambda/dispatch.test.js tests/lambda/worker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/dispatch.js src/lambda/worker.js tests/lambda/dispatch.test.js tests/lambda/worker.test.js
git commit -m "feat(dispatch): route block_actions envelopes to maintenance form handler"
```

---

### Task 6: Mention handler posts the form; delete chat back-and-forth

**Files:**
- Modify: `src/events/mention.js`
- Modify: `src/lambda/clients.js`
- Test: `tests/events/mention.test.js`

**Interfaces:**
- Consumes: `buildMaintenanceFormBlocks` (Task 2).
- Produces: `createMentionHandler({ sheetsService, channelIds, spreadsheetId, photoService, createdIssues })` — **`groqService` and `dedupService` params removed**; new `createdIssues` (a `Map`, shared with the form handler; optional, defaults to a fresh `Map`). Handler call signature unchanged: `handler({ event, say, client })`.

New behavior contract:
1. Ignore events outside `channelIds`.
2. Non-mention thread replies: only handled when `createdIssues` has the thread (notes/photos append); otherwise silently ignored. (The old thread-transcript recovery is gone — an unknown thread reply can no longer create an issue or re-prompt.)
3. Mentions: eyes reaction, then — in order — notes append (thread of a logged issue, non-command text), `list/status` command, `close/resolve` commands, otherwise post the form in the thread with the mention text (minus the `<@...>` tag) pre-filled as the description.
4. Deleted: severity Q&A, `pendingIssues`, `recoverPendingFromThread`, `fetchThreadReplies`, `threadHasBotMention`, `getBotUserId`, `engagedThreads`, `SEVERITY_PROMPT`/`LOGGED_CONFIRMATION` constants, LLM classification, suggested fix, inline severity, `create new:` bypass, duplicate blocking, the "Please describe the issue" empty-mention reply (the empty form covers it).

- [ ] **Step 1: Rewrite the test file**

Rewrite `tests/events/mention.test.js`. Keep the file's existing mock scaffolding style but: drop `mockGroq`/`mockDedup` entirely, add `createdIssues` map, and replace the severity/classification/duplicate/inline-severity/recovery tests with form-posting tests. Keep (adapting only construction) the tests for: channel filter, list command (7-day window + fallback to 5 most recent), close by ID, close by description (single match, multiple matches, no match), notes append (text and photos, warm map), command detection inside issue threads. Delete tests for: "asks for a description", severity reply flow, inline severity, "not a maintenance request", duplicate blocking, `create new:`, cold-container recovery.

New/changed tests:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMentionHandler } from "../../src/events/mention.js";
import { SUBMIT_ACTION_ID } from "../../src/lib/maintenance-form.js";

describe("MentionHandler", () => {
  let mockSheets;
  let handler;
  let mockSay;
  let mockClient;
  let createdIssues;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("5"),
      updateIssueStatus: vi.fn().mockResolvedValue({}),
      appendNote: vi.fn().mockResolvedValue({}),
      appendPhotos: vi.fn().mockResolvedValue({}),
    };
    mockSay = vi.fn().mockResolvedValue({});
    mockClient = {
      reactions: { add: vi.fn().mockResolvedValue({}) },
    };
    createdIssues = new Map();
    handler = createMentionHandler({
      sheetsService: mockSheets,
      channelIds: new Set(["C123"]),
      spreadsheetId: "sheet-id",
      createdIssues,
    });
  });

  it("posts the form in the thread with the mention text pre-filled", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    const call = mockSay.mock.calls[0][0];
    expect(call.thread_ts).toBe("1");
    expect(call.blocks).toBeDefined();
    const description = call.blocks.find((b) => b.block_id === "issue_description");
    expect(description.element.initial_value).toBe("lobby printer jammed");
    const submit = call.blocks.find((b) => b.block_id === "submit_actions");
    expect(submit.elements[0].action_id).toBe(SUBMIT_ACTION_ID);
  });

  it("posts an empty form when the mention has no text", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT>", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    const call = mockSay.mock.calls[0][0];
    const description = call.blocks.find((b) => b.block_id === "issue_description");
    expect(description.element).not.toHaveProperty("initial_value");
  });

  it("ignores non-mention thread replies in unknown threads", async () => {
    await handler({
      event: { channel: "C123", text: "some chatter", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).not.toHaveBeenCalled();
    expect(mockClient.reactions.add).not.toHaveBeenCalled();
  });

  it("appends thread replies as notes for a logged issue", async () => {
    createdIssues.set("1", "5");

    await handler({
      event: { channel: "C123", text: "it's getting worse", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendNote).toHaveBeenCalledWith("5", "it's getting worse");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("added that to the notes") })
    );
  });
});
```

Plus the kept list/close tests (copy their bodies from the current file; only the `createMentionHandler` construction and, where needed, `mockClient` change). For the notes-with-photos test, construct the handler with a `photoService` mock as the current file does.

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/events/mention.test.js`
Expected: FAIL (form tests — current code asks for severity instead).

- [ ] **Step 3: Rewrite `src/events/mention.js`**

Full new content (list/close/notes logic is carried over verbatim from the current file):

```javascript
import { buildMaintenanceFormBlocks } from "../lib/maintenance-form.js";

function stripMention(text) {
  return text.replace(/<@[A-Z0-9_]+>/g, "").trim();
}

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

function findMatchingIssues(description, openIssues) {
  const scored = openIssues
    .map((issue) => ({ issue, score: keywordOverlap(description, issue.description) }))
    .filter(({ score }) => score > 0.3)
    .sort((a, b) => b.score - a.score);
  return scored;
}

export function createMentionHandler({ sheetsService, channelIds, spreadsheetId, photoService, createdIssues = new Map() }) {
  async function collectPhotos(files) {
    if (!photoService || !files || files.length === 0) return [];
    try {
      return await photoService.collectPhotos(files);
    } catch (err) {
      console.error("collectPhotos failed:", err.message);
      return [];
    }
  }

  return async function handleMention({ event, say, client }) {
    console.log(`[mention] user=${event.user} channel=${event.channel} text="${event.text}"`);

    if (!channelIds.has(event.channel)) return;

    const description = stripMention(event.text || "");
    const threadKey = event.thread_ts || event.ts;
    const hasMention = /<@[A-Z0-9_]+>/.test(event.text || "");
    const issueRowId = event.thread_ts ? createdIssues.get(threadKey) : undefined;

    // Non-mention thread replies only matter in threads of issues we logged
    // (notes/photos). Anything else is other people's conversation — ignore.
    if (!hasMention && !issueRowId) return;

    // Acknowledge receipt immediately
    try {
      await client.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: "eyes",
      });
    } catch (err) {
      console.error("Failed to add reaction:", err.message);
    }

    // If this is a thread reply for a created issue and not a command, append the
    // text as a note and/or attach any photos.
    if (issueRowId) {
      const isCommand =
        description &&
        (/\b(list|show|what are|open requests|open issues|status)\b/i.test(description) ||
          /^(?:close|resolve|mark as resolved)\s+/i.test(description));

      if (!isCommand) {
        const photos = await collectPhotos(event.files);
        if (description || photos.length) {
          try {
            if (description) await sheetsService.appendNote(issueRowId, description);
            if (photos.length) await sheetsService.appendPhotos(issueRowId, photos);
            const text = description
              ? "Got it, added that to the notes."
              : "Got it, added that photo to the issue.";
            await say({ text, thread_ts: threadKey });
          } catch (err) {
            console.error("Sheets error:", err.message);
            await say({ text: "Couldn't update the notes right now.", thread_ts: threadKey });
          }
          return;
        }
        return;
      }
    }

    // Check if user is asking for a list of requests
    if (/\b(list|show|what are|open requests|open issues|status)\b/i.test(description)) {
      try {
        const openIssues = await sheetsService.getOpenIssues();
        if (openIssues.length === 0) {
          await say({ text: "No open requests right now.", thread_ts: event.ts });
        } else {
          // Show past 7 days of requests, or the 5 most recent if none in that window
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
          await say({
            text: `*${label} (${issuesToShow.length}):*\n${lines.join("\n")}`,
            thread_ts: event.thread_ts || event.ts,
          });
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't fetch requests right now.", thread_ts: event.ts });
      }
      return;
    }

    // Check for close/resolve command
    const closeMatch = description.match(/^(?:close|resolve|mark as resolved)\s+#?(\d+)$/i);
    const closeByDesc = description.match(/^(?:close|resolve|mark as resolved)\s+(.+)$/i);

    if (closeMatch) {
      // Direct close by ID
      const rowId = closeMatch[1];
      try {
        const allIssues = await sheetsService.getOpenIssues();
        const issue = allIssues.find((i) => i.id === rowId);
        if (!issue) {
          await say({ text: `No open issue found with ID #${rowId}.`, thread_ts: event.ts });
          return;
        }
        await sheetsService.updateIssueStatus(rowId, "Resolved");
        await say({
          text: `Issue #${rowId} (*${issue.description}*) has been marked as resolved.`,
          thread_ts: event.thread_ts || event.ts,
        });
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't update the issue right now — please try again.", thread_ts: event.ts });
      }
      return;
    }

    if (closeByDesc && !/^\d+$/.test(closeByDesc[1].trim())) {
      const searchDesc = closeByDesc[1].trim();
      try {
        const openIssues = await sheetsService.getOpenIssues();
        const matches = findMatchingIssues(searchDesc, openIssues);

        if (matches.length === 0) {
          await say({ text: `No open issue matching "${searchDesc}" was found.`, thread_ts: event.ts });
        } else if (matches.length === 1) {
          const { issue } = matches[0];
          await sheetsService.updateIssueStatus(issue.id, "Resolved");
          await say({
            text: `Issue #${issue.id} (*${issue.description}*) has been marked as resolved.`,
            thread_ts: event.thread_ts || event.ts,
          });
        } else {
          const lines = matches.slice(0, 5).map(
            ({ issue }) => `• #${issue.id} — *${issue.description}* (${issue.status})`
          );
          await say({
            text: `Multiple issues match that description. Which one should I close?\n${lines.join("\n")}\n\nReply with \`@FH Maintenance close #<ID>\` to specify.`,
            thread_ts: event.thread_ts || event.ts,
          });
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't update the issue right now — please try again.", thread_ts: event.ts });
      }
      return;
    }

    // Anything else: post the report form in the thread, description pre-filled
    // from the mention text. Submission is handled by the block_actions path
    // (src/events/maintenanceForm.js) — the form message itself carries all state.
    await say({
      text: "Report a maintenance issue",
      blocks: buildMaintenanceFormBlocks(description),
      thread_ts: threadKey,
    });
  };
}
```

- [ ] **Step 4: Wire `src/lambda/clients.js`**

```javascript
import { createMaintenanceFormHandler } from "../events/maintenanceForm.js";
```

Replace the `createMentionHandler` call and add the form handler (dedup service already exists above it):

```javascript
  const createdIssues = new Map();

  const handler = createMentionHandler({
    sheetsService,
    channelIds: config.slackChannelIds,
    spreadsheetId: config.googleSheetId,
    photoService,
    createdIssues,
  });

  const maintenanceFormHandler = createMaintenanceFormHandler({
    sheetsService,
    dedupService,
    photoService,
    spreadsheetId: config.googleSheetId,
    createdIssues,
  });
```

And export it:

```javascript
  cached = { client: slack, handler, maintenanceFormHandler, genderHandler, slashRefreshHandler, reservationHandler, onestopChannelId: config.onestopChannelId };
```

(`groqService` is still created — dedup and reservations use it.)

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run tests/events/mention.test.js tests/lambda`
Expected: PASS. If a clients test exists and asserts `getDeps()` shape, update it to include `maintenanceFormHandler`.

- [ ] **Step 6: Commit**

```bash
git add src/events/mention.js src/lambda/clients.js tests/events/mention.test.js
git commit -m "feat(maintenance): mentions post in-thread report form, drop severity Q&A"
```

---

### Task 7: Remove dead code (groq maintenance functions, severity lib)

**Files:**
- Modify: `src/services/groq.js`
- Delete: `src/lib/severity.js`, `tests/lib/severity.test.js`
- Test: `tests/services/groq.test.js`

**Interfaces:**
- Produces: `createGroqService` returns `{ checkDuplicate, parseReservationRequest, chooseCandidates, answerInfoQuestion }` — `suggestFix` and `isMaintenanceRequest` removed.

- [ ] **Step 1: Verify no remaining callers**

Run: `grep -rn "suggestFix\|isMaintenanceRequest\|extractSeverity\|parseSeverityReply\|lib/severity" src/`
Expected: only definitions inside `src/services/groq.js` and `src/lib/severity.js` — no callers. If any caller remains, STOP: a previous task is incomplete.

- [ ] **Step 2: Update tests**

In `tests/services/groq.test.js`, delete the `suggestFix` and `isMaintenanceRequest` describe blocks. Delete `tests/lib/severity.test.js`.

- [ ] **Step 3: Implement removals**

In `src/services/groq.js`:
- Delete `SYSTEM_PROMPT_FIX` and `SYSTEM_PROMPT_CLASSIFY` constants.
- Delete the `suggestFix`, `isObviouslyNotMaintenance`, and `isMaintenanceRequest` functions.
- Return becomes:
```javascript
  return { checkDuplicate, parseReservationRequest, chooseCandidates, answerInfoQuestion };
```

Delete `src/lib/severity.js`:
```bash
git rm src/lib/severity.js tests/lib/severity.test.js
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: ALL PASS — this is the whole-repo check that nothing still imports the removed code.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove suggestFix/isMaintenanceRequest and severity parsing (form replaces them)"
```

---

### Task 8: Full verification + deploy notes

**Files:**
- Modify: `README.md` (only if it documents the severity Q&A flow — check first)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 2: Check README for stale flow description**

Run: `grep -n -i "severity\|how severe\|suggested fix" README.md`
If the README describes the old back-and-forth (asking for severity, suggested fixes), update those sentences to describe the form: mention the bot → in-thread form with description, type dropdown (Lighting, Elevator, Pest Control, Electrical, Plumbing, HVAC, Janitorial, Other), severity dropdown (Minor, Medium, Critical) → Submit. If the README doesn't mention it, skip.

- [ ] **Step 3: Commit (if README changed)**

```bash
git add README.md
git commit -m "docs: describe in-thread maintenance form flow"
```

- [ ] **Step 4: Report manual follow-ups (do NOT attempt these yourself)**

Two manual, non-code steps must be reported to the operator at the end:
1. **Slack app config:** enable Interactivity (Features → Interactivity & Shortcuts) and set the Request URL to the same events endpoint URL the Events API uses. Without this, the Submit button silently does nothing.
2. **Google Sheet:** add the header `TYPE` to column J of the "Maintenance Request" tab (header rows 1–4).
3. Deploy with the project's usual `sam build && sam deploy` flow (no template.yaml changes were needed).

---

## Self-Review Notes

- Spec coverage: form post (Task 6), submit handling incl. dedup-warn/photos/cc/double-submit/ephemeral (Task 3), receiver interactivity (Task 4), routing (Task 5), TYPE column (Task 1), deletions (Tasks 6–7), tests per area (each task), manual Slack/sheet steps (Task 8). Spec's "empty description → ephemeral, form stays" covered in Task 3; "sheet failure → error, form stays" covered in Task 3.
- Type consistency: `createdIssues` map threadKey → rowId shared via `clients.js`; `appendIssue` `type` param used in Tasks 1, 3; `SUBMIT_ACTION_ID` used in Tasks 2, 3, 6.
- Known accepted limitation (matches spec's simplification): `createdIssues` is in-memory per container; a notes reply hitting a cold container is ignored rather than misrouted (old code could misfile it as a new report — this is an improvement).
