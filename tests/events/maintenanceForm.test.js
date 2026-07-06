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
    expect(mockClient.chat.update.mock.calls[0][0].text).toContain("cc <@U0000000000>");

    mockClient.chat.update.mockClear();
    const minor = makePayload();
    minor.state.values.issue_severity.severity.selected_option.value = "Minor";
    await handler({ payload: minor, client: mockClient });
    expect(mockClient.chat.update.mock.calls[0][0].text).not.toContain("cc <@U0000000000>");
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

  it("resolves without throwing when both chat.update and chat.postMessage reject", async () => {
    mockClient.chat.update.mockRejectedValue(new Error("update failed"));
    mockClient.chat.postMessage.mockRejectedValue(new Error("postMessage failed"));

    await expect(handler({ payload: makePayload(), client: mockClient })).resolves.toBeUndefined();
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", thread_ts: "100.1" })
    );
  });
});
