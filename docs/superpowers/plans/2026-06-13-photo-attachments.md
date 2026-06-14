# Photo Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach photos to maintenance issues in Slack and surface them in the Google Sheet as an inline thumbnail plus an appendable list of links.

**Architecture:** Photos arrive in Slack's `event.files[]`. A new photo pipeline downloads each image from Slack (token-authenticated) and uploads it to a dedicated Google Drive folder shared "anyone-with-link." The sheet gains two columns: column I holds an `=IMAGE()` thumbnail of the first photo, column J holds newline-separated photo links (auto-linkified, appendable from thread replies).

**Tech Stack:** Node 22 (global `fetch`), `googleapis` (Sheets v4 + Drive v3), Vitest, AWS SAM.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/services/drive.js` | Upload a photo buffer to Drive, share it, return URLs | Create |
| `src/lib/photos.js` | Pipeline: filter Slack files → download → upload via drive service | Create |
| `src/services/sheets.js` | Add columns I/J; `appendIssue` photos; new `appendPhotos` | Modify |
| `src/events/mention.js` | Capture photos on create + thread-reply paths | Modify |
| `src/lambda/dispatch.js` | Route `file_share` thread messages to the handler | Modify |
| `src/lambda/clients.js` | Wire Drive client + photo service into the handler | Modify |
| `src/config.js` | Add `GOOGLE_DRIVE_FOLDER_ID` | Modify |
| `scripts/get-google-token.js` | Add `drive.file` scope | Modify |
| `template.yaml` | Add `GoogleDriveFolderId` param + env var | Modify |
| `.env.example`, `README.md` | Document `GOOGLE_DRIVE_FOLDER_ID`, scopes, setup | Modify |

**Photo descriptor shape** (returned by the pipeline, consumed by sheets):
```js
{ imageUrl: "https://lh3.googleusercontent.com/d/<fileId>", viewUrl: "https://drive.google.com/file/d/<fileId>/view", name: "leak.jpg" }
```

---

## Task 1: Drive upload service

**Files:**
- Create: `src/services/drive.js`
- Test: `tests/services/drive.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/services/drive.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDriveService } from "../../src/services/drive.js";

describe("DriveService", () => {
  let mockDrive;
  let service;

  beforeEach(() => {
    mockDrive = {
      files: {
        create: vi.fn().mockResolvedValue({
          data: { id: "FILE123", webViewLink: "https://drive.google.com/file/d/FILE123/view" },
        }),
      },
      permissions: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    service = createDriveService(mockDrive, "FOLDER1");
  });

  it("uploads into the configured folder and returns image + view URLs", async () => {
    const result = await service.uploadPhoto({
      buffer: Buffer.from("img-bytes"),
      name: "leak.jpg",
      mimeType: "image/jpeg",
    });

    expect(mockDrive.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { name: "leak.jpg", parents: ["FOLDER1"] },
        media: expect.objectContaining({ mimeType: "image/jpeg" }),
        fields: "id, webViewLink",
      })
    );
    expect(result).toEqual({
      fileId: "FILE123",
      imageUrl: "https://lh3.googleusercontent.com/d/FILE123",
      viewUrl: "https://drive.google.com/file/d/FILE123/view",
    });
  });

  it("shares the uploaded file anyone-with-link reader", async () => {
    await service.uploadPhoto({ buffer: Buffer.from("x"), name: "a.png", mimeType: "image/png" });

    expect(mockDrive.permissions.create).toHaveBeenCalledWith({
      fileId: "FILE123",
      requestBody: { role: "reader", type: "anyone" },
    });
  });

  it("omits parents when no folder is configured", async () => {
    const noFolder = createDriveService(mockDrive, null);
    await noFolder.uploadPhoto({ buffer: Buffer.from("x"), name: "a.png", mimeType: "image/png" });

    expect(mockDrive.files.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { name: "a.png" } })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/drive.test.js`
Expected: FAIL — cannot resolve `../../src/services/drive.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/services/drive.js
import { Readable } from "node:stream";

export function createDriveService(driveClient, folderId) {
  async function uploadPhoto({ buffer, name, mimeType }) {
    const res = await driveClient.files.create({
      requestBody: {
        name,
        ...(folderId ? { parents: [folderId] } : {}),
      },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id, webViewLink",
    });

    const fileId = res.data.id;

    await driveClient.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    return {
      fileId,
      imageUrl: `https://lh3.googleusercontent.com/d/${fileId}`,
      viewUrl: res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
    };
  }

  return { uploadPhoto };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/drive.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/drive.js tests/services/drive.test.js
git commit -m "feat(drive): add Drive upload service for issue photos"
```

---

## Task 2: Photo pipeline (Slack → Drive)

**Files:**
- Create: `src/lib/photos.js`
- Test: `tests/lib/photos.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/lib/photos.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPhotoService } from "../../src/lib/photos.js";

function fakeResponse(ok, bytes = "bytes") {
  return {
    ok,
    status: ok ? 200 : 403,
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(bytes).buffer),
  };
}

describe("PhotoService", () => {
  let mockDrive;
  let mockFetch;
  let service;

  beforeEach(() => {
    mockDrive = {
      uploadPhoto: vi.fn().mockImplementation(({ name }) =>
        Promise.resolve({
          fileId: `id-${name}`,
          imageUrl: `https://lh3.googleusercontent.com/d/id-${name}`,
          viewUrl: `https://drive.google.com/file/d/id-${name}/view`,
        })
      ),
    };
    mockFetch = vi.fn().mockResolvedValue(fakeResponse(true));
    service = createPhotoService({
      driveService: mockDrive,
      slackBotToken: "xoxb-123",
      fetchImpl: mockFetch,
    });
  });

  it("downloads each image with the bot token and uploads to Drive", async () => {
    const photos = await service.collectPhotos([
      { id: "F1", name: "leak.jpg", mimetype: "image/jpeg", url_private_download: "https://files.slack.com/leak" },
    ]);

    expect(mockFetch).toHaveBeenCalledWith("https://files.slack.com/leak", {
      headers: { Authorization: "Bearer xoxb-123" },
    });
    expect(mockDrive.uploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ name: "leak.jpg", mimeType: "image/jpeg" })
    );
    expect(photos).toEqual([
      {
        imageUrl: "https://lh3.googleusercontent.com/d/id-leak.jpg",
        viewUrl: "https://drive.google.com/file/d/id-leak.jpg/view",
        name: "leak.jpg",
      },
    ]);
  });

  it("ignores non-image files", async () => {
    const photos = await service.collectPhotos([
      { id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private_download: "https://files.slack.com/pdf" },
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(photos).toEqual([]);
  });

  it("skips a failed download but keeps the others (graceful degradation)", async () => {
    mockFetch
      .mockResolvedValueOnce(fakeResponse(false))
      .mockResolvedValueOnce(fakeResponse(true));

    const photos = await service.collectPhotos([
      { id: "F1", name: "bad.jpg", mimetype: "image/jpeg", url_private_download: "u1" },
      { id: "F2", name: "good.jpg", mimetype: "image/jpeg", url_private_download: "u2" },
    ]);

    expect(photos).toHaveLength(1);
    expect(photos[0].name).toBe("good.jpg");
  });

  it("returns [] for empty or missing files", async () => {
    expect(await service.collectPhotos([])).toEqual([]);
    expect(await service.collectPhotos(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/photos.test.js`
Expected: FAIL — cannot resolve `../../src/lib/photos.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/photos.js
export function createPhotoService({ driveService, slackBotToken, fetchImpl = fetch }) {
  function isImage(file) {
    return (file.mimetype || "").startsWith("image/");
  }

  async function collectPhotos(files) {
    const images = (files || []).filter(isImage);
    const photos = [];

    for (const file of images) {
      try {
        const url = file.url_private_download || file.url_private;
        const resp = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${slackBotToken}` },
        });
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);

        const buffer = Buffer.from(await resp.arrayBuffer());
        const uploaded = await driveService.uploadPhoto({
          buffer,
          name: file.name || `${file.id}.img`,
          mimeType: file.mimetype,
        });

        photos.push({
          imageUrl: uploaded.imageUrl,
          viewUrl: uploaded.viewUrl,
          name: file.name || uploaded.fileId,
        });
      } catch (err) {
        console.error("photo upload failed:", err.message);
      }
    }

    return photos;
  }

  return { collectPhotos };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/photos.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/photos.js tests/lib/photos.test.js
git commit -m "feat(photos): add Slack-to-Drive photo pipeline"
```

---

## Task 3: Sheets — photo columns I/J

**Files:**
- Modify: `src/services/sheets.js`
- Test: `tests/services/sheets.test.js`

- [ ] **Step 1: Update the existing `appendIssue` test and add photo tests**

Replace the `appendIssue` describe block (currently asserting `A5:H5` with 8 values) and add an `appendPhotos` block. Apply these edits to `tests/services/sheets.test.js`:

Change the `appendIssue` assertion's range and values to include columns I and J (empty when no photos):

```js
  describe("appendIssue", () => {
    it("inserts a row at row 5 and returns the row number", async () => {
      const id = await service.appendIssue({
        reporter: "U789",
        description: "Water leak in bathroom",
      });

      expect(id).toBe("5");
      expect(mockSheets.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: { sheetId: 0, dimension: "ROWS", startIndex: 4, endIndex: 5 },
              },
            },
          ],
        },
      });
      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!A5:J5",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[expect.any(String), "U789", "Water leak in bathroom", "", "=TODAY()-A5", "", "Need to Assign", "", "", ""]],
        },
      });
    });

    it("writes a thumbnail formula and links when photos are present", async () => {
      await service.appendIssue({
        reporter: "U789",
        description: "Water leak",
        severity: "Medium",
        photos: [
          { imageUrl: "https://lh3.googleusercontent.com/d/A", viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
          { imageUrl: "https://lh3.googleusercontent.com/d/B", viewUrl: "https://drive.google.com/file/d/B/view", name: "b.jpg" },
        ],
      });

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          range: "'Maintenance Request'!A5:J5",
          requestBody: {
            values: [[
              expect.any(String), "U789", "Water leak", "Medium", "=TODAY()-A5", "", "Need to Assign", "",
              '=IMAGE("https://lh3.googleusercontent.com/d/A")',
              "https://drive.google.com/file/d/A/view\nhttps://drive.google.com/file/d/B/view",
            ]],
          },
        })
      );
    });
  });

  describe("appendPhotos", () => {
    it("sets the thumbnail when empty and appends links", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [["", ""]] } });

      await service.appendPhotos("5", [
        { imageUrl: "https://lh3.googleusercontent.com/d/A", viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
      ]);

      expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!I5:J5",
        valueRenderOption: "FORMULA",
      });
      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!I5:J5",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [['=IMAGE("https://lh3.googleusercontent.com/d/A")', "https://drive.google.com/file/d/A/view"]],
        },
      });
    });

    it("keeps the existing thumbnail and appends to existing links", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['=IMAGE("https://lh3.googleusercontent.com/d/OLD")', "https://drive.google.com/file/d/OLD/view"]] },
      });

      await service.appendPhotos("5", [
        { imageUrl: "https://lh3.googleusercontent.com/d/NEW", viewUrl: "https://drive.google.com/file/d/NEW/view", name: "new.jpg" },
      ]);

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            values: [[
              '=IMAGE("https://lh3.googleusercontent.com/d/OLD")',
              "https://drive.google.com/file/d/OLD/view\nhttps://drive.google.com/file/d/NEW/view",
            ]],
          },
        })
      );
    });

    it("does nothing when there are no photos", async () => {
      await service.appendPhotos("5", []);
      expect(mockSheets.spreadsheets.values.update).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/sheets.test.js`
Expected: FAIL — `appendIssue` writes `A5:H5` not `A5:J5`; `service.appendPhotos` is not a function.

- [ ] **Step 3: Update `src/services/sheets.js`**

Update the header comment and `DATA_RANGE`:

```js
// Columns: A=DATE, B=SUBMITTER, C=ISSUE, D=PRIORITY, E=DAYS SINCE FILED, F=IN CHARGE, G=STATUS, H=NOTES, I=PHOTO, J=PHOTO LINKS
// Data starts at row 5 (rows 1-4 are headers/metadata)
const SHEET_NAME = "Maintenance Request";
const DATA_START_ROW = 5;
const DATA_RANGE = `'${SHEET_NAME}'!A${DATA_START_ROW}:J`;
```

Add `photoThumb`/`photoLinks` to `parseRow`:

```js
function parseRow(row, rowIndex) {
  return {
    id: String(rowIndex + DATA_START_ROW),
    date: row[0] || "",
    submitter: row[1] || "",
    description: row[2] || "",
    priority: row[3] || "",
    daysSinceFiled: row[4] || "",
    inCharge: row[5] || "",
    status: row[6] || "",
    notes: row[7] || "",
    photoThumb: row[8] || "",
    photoLinks: row[9] || "",
  };
}
```

Add two helpers just above `createSheetsService`:

```js
function photoThumbFormula(photos) {
  if (!photos || photos.length === 0) return "";
  return `=IMAGE("${photos[0].imageUrl}")`;
}

function photoLinksText(photos) {
  if (!photos || photos.length === 0) return "";
  return photos.map((p) => p.viewUrl).join("\n");
}
```

Update `appendIssue` to accept `photos` and write to `A5:J5`:

```js
  async function appendIssue({ reporter, description, severity, photos }) {
    const today = new Date().toLocaleDateString("en-US");
    const sheetId = await getSheetId();

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: DATA_START_ROW - 1,
                endIndex: DATA_START_ROW,
              },
            },
          },
        ],
      },
    });

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A${DATA_START_ROW}:J${DATA_START_ROW}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          today, reporter, description, severity || "", `=TODAY()-A${DATA_START_ROW}`, "", "Need to Assign", "",
          photoThumbFormula(photos), photoLinksText(photos),
        ]],
      },
    });

    return String(DATA_START_ROW);
  }
```

Add `appendPhotos` just after `appendNote`:

```js
  async function appendPhotos(rowId, photos) {
    if (!photos || photos.length === 0) return;
    const range = `'${SHEET_NAME}'!I${rowId}:J${rowId}`;
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "FORMULA",
    });
    const existing = (res.data.values && res.data.values[0]) || [];
    const existingThumb = existing[0] || "";
    const existingLinks = existing[1] || "";

    const thumb = existingThumb || photoThumbFormula(photos);
    const newLinks = photoLinksText(photos);
    const links = existingLinks ? `${existingLinks}\n${newLinks}` : newLinks;

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[thumb, links]] },
    });
  }
```

Add `appendPhotos` to the returned object:

```js
  return { getAllIssues, getOpenIssues, appendIssue, updateIssueStatus, appendNote, appendPhotos };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/sheets.test.js`
Expected: PASS (all sheets tests, including the new photo tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/sheets.js tests/services/sheets.test.js
git commit -m "feat(sheets): add photo thumbnail + links columns"
```

---

## Task 4: Mention handler — capture photos

**Files:**
- Modify: `src/events/mention.js`
- Test: `tests/events/mention.test.js`

- [ ] **Step 1: Add photo tests to `tests/events/mention.test.js`**

Add `appendPhotos` to the `mockSheets` object in `beforeEach`:

```js
      appendPhotos: vi.fn().mockResolvedValue({}),
```

Add a new describe block at the end of the top-level `describe("MentionHandler", ...)` body (before its closing `});`):

```js
  describe("photos", () => {
    let mockPhotoService;
    let photoHandler;

    beforeEach(() => {
      mockPhotoService = {
        collectPhotos: vi.fn().mockResolvedValue([
          { imageUrl: "https://lh3.googleusercontent.com/d/A", viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
        ]),
      };
      photoHandler = createMentionHandler({
        sheetsService: mockSheets,
        groqService: mockGroq,
        dedupService: mockDedup,
        channelIds: new Set(["C123"]),
        spreadsheetId: "sheet-id",
        photoService: mockPhotoService,
      });
    });

    it("attaches photos when the issue is created with inline severity", async () => {
      const files = [{ id: "F1", name: "a.jpg", mimetype: "image/jpeg", url_private_download: "u1" }];
      await photoHandler({
        event: { channel: "C123", text: "<@U_BOT> water leak - critical", user: "U1", ts: "1", files },
        say: mockSay,
        client: mockClient,
      });

      expect(mockPhotoService.collectPhotos).toHaveBeenCalledWith(files);
      expect(mockSheets.appendIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          photos: [
            { imageUrl: "https://lh3.googleusercontent.com/d/A", viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
          ],
        })
      );
    });

    it("attaches the original report's photos after a severity reply", async () => {
      const files = [{ id: "F1", name: "a.jpg", mimetype: "image/jpeg", url_private_download: "u1" }];
      // Step 1: report with a photo, no severity -> bot asks for severity, photo deferred
      await photoHandler({
        event: { channel: "C123", text: "<@U_BOT> water leak", user: "U1", ts: "1", files },
        say: mockSay,
        client: mockClient,
      });
      expect(mockSheets.appendIssue).not.toHaveBeenCalled();

      // Step 2: severity reply (no files of its own)
      await photoHandler({
        event: { channel: "C123", text: "critical", user: "U1", ts: "2", thread_ts: "1" },
        say: mockSay,
        client: mockClient,
      });

      expect(mockSheets.appendIssue).toHaveBeenCalledWith(
        expect.objectContaining({ photos: [expect.objectContaining({ name: "a.jpg" })] })
      );
    });

    it("appends a photo-only thread reply to an existing issue", async () => {
      // Step 1: create the issue
      await photoHandler({
        event: { channel: "C123", text: "<@U_BOT> water leak - critical", user: "U1", ts: "1" },
        say: mockSay,
        client: mockClient,
      });
      mockSay.mockClear();

      // Step 2: photo-only reply (no text)
      const files = [{ id: "F2", name: "more.jpg", mimetype: "image/jpeg", url_private_download: "u2" }];
      await photoHandler({
        event: { channel: "C123", text: "", user: "U1", ts: "3", thread_ts: "1", files },
        say: mockSay,
        client: mockClient,
      });

      expect(mockSheets.appendPhotos).toHaveBeenCalledWith("1", [expect.objectContaining({ name: "a.jpg" })]);
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("photo"), thread_ts: "1" })
      );
    });
  });
```

> Note: `collectPhotos` is mocked to always return the same `a.jpg` descriptor regardless of input, so assertions reference `a.jpg` even for the `more.jpg` reply. We only assert that `appendPhotos` was called with the pipeline's output.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/events/mention.test.js`
Expected: FAIL — `appendIssue` called without a `photos` key; `appendPhotos` not called.

- [ ] **Step 3: Update `src/events/mention.js`**

Add `photoService` to the factory signature:

```js
export function createMentionHandler({ sheetsService, groqService, dedupService, channelIds, spreadsheetId, photoService }) {
```

Add a `collectPhotos` helper inside the factory, just after `getBotUserId` is defined:

```js
  async function collectPhotos(files) {
    if (!photoService || !files || files.length === 0) return [];
    try {
      return await photoService.collectPhotos(files);
    } catch (err) {
      console.error("collectPhotos failed:", err.message);
      return [];
    }
  }
```

In `recoverPendingFromThread`, capture the root message's files into the returned descriptor. Change the final return:

```js
    return { user: root.user, reporterName, issueDescription, suggestion, duplicate: null, files: root.files || [] };
```

When storing the pending issue (the `pendingIssues.set(threadKey, {...})` call near the end), add `files`:

```js
      pendingIssues.set(threadKey, {
        user: event.user,
        reporterName,
        issueDescription,
        suggestion,
        duplicate,
        files: event.files || [],
      });
```

In the **severity-reply creation path**, gather photos from both the original report and the reply, then pass to `appendIssue`. Replace the `appendIssue` call in the `if (pending) { ... }` block:

```js
      const photos = await collectPhotos([...(pending.files || []), ...(event.files || [])]);

      let id;
      try {
        id = await sheetsService.appendIssue({
          reporter: pending.reporterName,
          description: pending.issueDescription,
          severity,
          ...(photos.length ? { photos } : {}),
        });
      } catch {
```

In the **inline-severity creation path**, gather photos from the event and pass them. Replace that `appendIssue` call:

```js
      const photos = await collectPhotos(event.files);

      let id;
      try {
        id = await sheetsService.appendIssue({
          reporter: reporterName,
          description: issueDescription,
          severity: inlineSeverity,
          ...(photos.length ? { photos } : {}),
        });
      } catch {
```

Replace the **thread-reply note block** (the `if (issueRowId && event.thread_ts && description) { ... }` block) with one that also handles photos and photo-only replies:

```js
    // If this is a thread reply for a created issue and not a command, append
    // the text as a note and/or attach any photos.
    const issueRowId = createdIssues.get(threadKey);
    if (issueRowId && event.thread_ts) {
      const isCommand =
        description &&
        (/\b(list|show|what are|open requests|open issues|status)\b/i.test(description) ||
          /^(?:close|resolve|mark as resolved)\s+/i.test(description) ||
          /^create new:\s*/i.test(description));

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
      }
    }
```

- [ ] **Step 4: Run the full mention suite to verify pass**

Run: `npx vitest run tests/events/mention.test.js`
Expected: PASS — existing tests still green (they pass no `photoService`, so `photos` is omitted), new photo tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/events/mention.js tests/events/mention.test.js
git commit -m "feat(mention): capture photos on report and thread replies"
```

---

## Task 5: Dispatch — route file_share thread messages

**Files:**
- Modify: `src/lambda/dispatch.js`
- Test: `tests/lambda/dispatch.test.js`

- [ ] **Step 1: Add tests for file_share routing**

Add these tests inside `describe("dispatchSlackEvent", ...)`:

```js
  it("passes a file_share thread reply (no @mention) through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C1",
          thread_ts: "1",
          text: "",
          user: "U1",
          files: [{ id: "F1", mimetype: "image/jpeg" }],
        },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still skips a file_share that is not a thread reply", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: { type: "message", subtype: "file_share", channel: "C1", text: "", user: "U1", files: [{ id: "F1" }] },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still skips non-file_share subtyped thread messages", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", subtype: "message_changed" },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: FAIL — the file_share thread reply is currently skipped (subtype guard), so the handler is not called.

- [ ] **Step 3: Update `shouldSkip` in `src/lambda/dispatch.js`**

Replace the `message` branch of `shouldSkip`:

```js
  if (event.type === "message") {
    if (!event.thread_ts) return true;
    if (event.bot_id) return true;
    // Allow file_share (photo uploads) through; skip other subtypes (edits, joins, etc.)
    if (event.subtype && event.subtype !== "file_share") return true;
    if (/<@[A-Z0-9_]+>/.test(event.text || "")) return true;
    return false;
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/lambda/dispatch.test.js`
Expected: PASS — including the existing `"skips bot messages and subtyped messages"` test (it uses `subtype: "message_changed"`, still skipped).

- [ ] **Step 5: Commit**

```bash
git add src/lambda/dispatch.js tests/lambda/dispatch.test.js
git commit -m "feat(dispatch): route file_share thread replies to the handler"
```

---

## Task 6: Config + clients wiring

**Files:**
- Modify: `src/config.js`
- Test: `tests/config.test.js`
- Modify: `src/lambda/clients.js`
- Modify: `scripts/get-google-token.js`

- [ ] **Step 1: Add a config test for the new optional var**

Add to `tests/config.test.js` (inside the existing top-level describe). First inspect the file's existing setup; it sets all REQUIRED env vars before calling `loadConfig()`. Add:

```js
  it("exposes googleDriveFolderId (null when unset)", () => {
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    expect(loadConfig().googleDriveFolderId).toBeNull();

    process.env.GOOGLE_DRIVE_FOLDER_ID = "FOLDER1";
    expect(loadConfig().googleDriveFolderId).toBe("FOLDER1");
  });
```

> Note: read `tests/config.test.js` first to match its exact env-setup pattern (it likely sets/clears `process.env` in `beforeEach`). Place the test so REQUIRED vars are present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL — `googleDriveFolderId` is `undefined`, not `null`/`"FOLDER1"`.

- [ ] **Step 3: Add the field to `src/config.js`**

In the returned object of `loadConfig()`, after `googleRefreshToken`:

```js
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
```

(Leave `GOOGLE_DRIVE_FOLDER_ID` out of `REQUIRED` — it is optional; when null the drive service uploads to the Drive root.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the Drive client + photo service in `src/lambda/clients.js`**

Add the imports near the other service imports:

```js
import { createDriveService } from "../services/drive.js";
import { createPhotoService } from "../lib/photos.js";
```

After `sheetsService` is built, add:

```js
  const driveClient = google.drive({ version: "v3", auth: oauth2Client });
  const driveService = createDriveService(driveClient, config.googleDriveFolderId);
  const photoService = createPhotoService({
    driveService,
    slackBotToken: config.slackBotToken,
  });
```

Pass `photoService` into the handler:

```js
  const handler = createMentionHandler({
    sheetsService,
    groqService,
    dedupService,
    channelIds: config.slackChannelIds,
    spreadsheetId: config.googleSheetId,
    photoService,
  });
```

- [ ] **Step 6: Add the `drive.file` scope to `scripts/get-google-token.js`**

Change the `scope` array in `generateAuthUrl`:

```js
  scope: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
  ],
```

Also update the script's header comment line `This will open a browser for you to sign in and grant Sheets access.` to:

```js
 * This will open a browser for you to sign in and grant Sheets + Drive access.
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all tests.

- [ ] **Step 8: Commit**

```bash
git add src/config.js tests/config.test.js src/lambda/clients.js scripts/get-google-token.js
git commit -m "feat(config): wire Drive client + GOOGLE_DRIVE_FOLDER_ID"
```

---

## Task 7: Infra + docs

**Files:**
- Modify: `template.yaml`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the SAM parameter + worker env var in `template.yaml`**

Add to `Parameters`:

```yaml
  GoogleDriveFolderId:  { Type: String, Default: "" }
```

Add to `WorkerFn` → `Environment` → `Variables`:

```yaml
          GOOGLE_DRIVE_FOLDER_ID: !Ref GoogleDriveFolderId
```

> Note: also confirm the deploy workflow passes parameter overrides. Inspect `.github/workflows/deploy.yml`; if it lists `--parameter-overrides` explicitly, add `GoogleDriveFolderId=...` sourced from a GitHub secret/var. If it uses `samconfig.toml`, add the parameter there. Match the existing pattern used for `GoogleSheetId`.

- [ ] **Step 2: Document the env var in `.env.example`**

Add a line (optional var):

```
# Optional: Drive folder ID for issue photos (uploads to Drive root if unset)
GOOGLE_DRIVE_FOLDER_ID=
```

- [ ] **Step 3: Update `README.md`**

- Add a row to the env-var table:

```
| `GOOGLE_DRIVE_FOLDER_ID` | (Optional) Drive folder ID for uploaded issue photos |
```

- Under Features, add: `- **Photo attachments** — photos on a report or thread reply are copied to Google Drive and linked in the sheet (first photo shown as an inline thumbnail).`
- Add a short "Photos" subsection documenting the one-time setup: regenerate the Google token (now requests `drive.file`), create and share a Drive folder, set `GOOGLE_DRIVE_FOLDER_ID`, and add the **`files:read`** Slack OAuth scope (reinstall the app). Note the Event Subscriptions already cover `message.channels`/`message.groups`, which carry `file_share` events.

- [ ] **Step 4: Run the full suite once more**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add template.yaml .env.example README.md
git commit -m "docs: document photo attachments setup and Drive folder"
```

---

## Self-Review notes

- **Spec coverage:** two-column layout (Task 3), thumbnail-first-wins (`appendPhotos`, Task 3), capture on report + reply incl. deferred-severity recovery (Task 4), file_share routing (Task 5), `drive.file` scope + folder env var (Task 6/7), `files:read` documentation (Task 7), graceful degradation (`collectPhotos` try/catch, Task 2 + 4), testing across all units. ✓
- **Pre-existing row-id quirk:** intentionally unchanged — `appendPhotos`, like `appendNote`, targets the row id stored in `createdIssues` (always `"5"` from `appendIssue`). Matches existing behavior; out of scope to fix.
- **Type consistency:** photo descriptor `{ imageUrl, viewUrl, name }` produced by `drive.js`/`photos.js` and consumed by `sheets.js` (`photoThumbFormula` reads `imageUrl`, `photoLinksText` reads `viewUrl`). Consistent across tasks. `photoService.collectPhotos(files)` signature matches the mention handler's call site and the clients.js construction.
