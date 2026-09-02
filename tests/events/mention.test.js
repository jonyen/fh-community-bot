import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMentionHandler } from "../../src/events/mention.js";
import { SUBMIT_ACTION_ID } from "../../src/lib/maintenance-form.js";

function recentDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-US");
}

describe("MentionHandler", () => {
  let mockSheets;
  let handler;
  let mockSay;
  let mockClient;

  let mockDedup;
  let mockClassifier;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("5"),
      updateIssueStatus: vi.fn().mockResolvedValue({}),
      appendNote: vi.fn().mockResolvedValue({}),
      appendPhotos: vi.fn().mockResolvedValue({}),
      findIssueRowByRef: vi.fn().mockResolvedValue(null),
    };
    mockDedup = { findDuplicate: vi.fn().mockResolvedValue(null) };
    mockClassifier = {
      classify: vi.fn().mockResolvedValue({ type: null, severity: null }),
    };
    mockSay = vi.fn().mockResolvedValue({});
    mockClient = {
      reactions: { add: vi.fn().mockResolvedValue({}) },
    };
    handler = createMentionHandler({
      sheetsService: mockSheets,
      dedupService: mockDedup,
      issueClassifier: mockClassifier,
      channelIds: new Set(["C123"]),
      spreadsheetId: "sheet-id",
    });
  });

  it("ignores mentions outside the configured channel", async () => {
    await handler({
      event: { channel: "C999", text: "<@U_BOT> printer broke", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).not.toHaveBeenCalled();
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

  it("pre-selects the type and severity the classifier read out of the mention", async () => {
    mockClassifier.classify.mockResolvedValue({ type: "Plumbing", severity: "Critical" });

    await handler({
      event: {
        channel: "C123",
        text: "<@U_BOT> the toilet on 2 is clogged, this is urgent",
        user: "U1",
        ts: "1",
      },
      say: mockSay,
      client: mockClient,
    });

    // Classified on the report text, with the @mention stripped out.
    expect(mockClassifier.classify).toHaveBeenCalledWith(
      "the toilet on 2 is clogged, this is urgent"
    );
    const blocks = mockSay.mock.calls[0][0].blocks;
    expect(blocks.find((b) => b.block_id === "issue_type").element.initial_option.value).toBe(
      "Plumbing"
    );
    expect(
      blocks.find((b) => b.block_id === "issue_severity").element.initial_option.value
    ).toBe("Critical");
  });

  it("leaves the selects empty when the classifier won't commit", async () => {
    mockClassifier.classify.mockResolvedValue({ type: null, severity: null });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    const blocks = mockSay.mock.calls[0][0].blocks;
    expect(blocks.find((b) => b.block_id === "issue_type").element).not.toHaveProperty(
      "initial_option"
    );
    expect(blocks.find((b) => b.block_id === "issue_severity").element).not.toHaveProperty(
      "initial_option"
    );
  });

  it("still posts the form when the classifier blows up", async () => {
    mockClassifier.classify.mockRejectedValue(new Error("groq down"));

    await handler({
      event: { channel: "C123", text: "<@U_BOT> sink leaking", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    const blocks = mockSay.mock.calls[0][0].blocks;
    expect(blocks.find((b) => b.block_id === "issue_description").element.initial_value).toBe(
      "sink leaking"
    );
    expect(blocks.find((b) => b.block_id === "issue_type").element).not.toHaveProperty(
      "initial_option"
    );
  });

  it("classifies without a classifier wired in, using the keyword fallback", async () => {
    const bare = createMentionHandler({
      sheetsService: mockSheets,
      dedupService: mockDedup,
      channelIds: new Set(["C123"]),
      spreadsheetId: "sheet-id",
    });

    await bare({
      event: { channel: "C123", text: "<@U_BOT> roaches in the kitchen", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(
      mockSay.mock.calls[0][0].blocks.find((b) => b.block_id === "issue_type").element
        .initial_option.value
    ).toBe("Pest Control");
  });

  it("runs the dedup check and the classifier together, not one after the other", async () => {
    // Assert after the handler returns, not inside the mock: the handler
    // catches classifier failures, so a throw in there would be swallowed and
    // this test would pass against sequential code.
    let dedupSettled = false;
    let classifierStartedBeforeDedupSettled = null;

    mockDedup.findDuplicate.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            dedupSettled = true;
            resolve(null);
          }, 20)
        )
    );
    mockClassifier.classify.mockImplementation(async () => {
      classifierStartedBeforeDedupSettled = !dedupSettled;
      return { type: null, severity: null };
    });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> sink leaking", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(classifierStartedBeforeDedupSettled).toBe(true);
    expect(mockSay).toHaveBeenCalled();
  });

  it("lists a possible duplicate in the form when one matches", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "7", description: "leak under the sink", date: recentDate(2), status: "Open" },
      { id: "3", description: "old busted door", date: recentDate(30), status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "7", confident: true });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> sink is leaking", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    // Only issues from the last 7 days are considered
    expect(mockDedup.findDuplicate).toHaveBeenCalledWith("sink is leaking", [
      expect.objectContaining({ id: "7" }),
    ]);
    const call = mockSay.mock.calls[0][0];
    const warning = call.blocks.find((b) => b.block_id === "duplicate_warning");
    expect(warning).toBeDefined();
    expect(warning.text.text).toContain("#7");
    expect(warning.text.text).toContain("leak under the sink");
  });

  it("posts a plain form when the dedup check fails", async () => {
    mockSheets.getOpenIssues.mockRejectedValue(new Error("sheets down"));

    await handler({
      event: { channel: "C123", text: "<@U_BOT> sink is leaking", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    const call = mockSay.mock.calls[0][0];
    expect(call.blocks.find((b) => b.block_id === "duplicate_warning")).toBeUndefined();
    expect(call.blocks.find((b) => b.block_id === "issue_description")).toBeDefined();
  });

  it("skips the dedup check when the mention has no description", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT>", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockDedup.findDuplicate).not.toHaveBeenCalled();
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
    mockSheets.findIssueRowByRef.mockResolvedValue("5");

    await handler({
      event: { channel: "C123", text: "it's getting worse", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.findIssueRowByRef).toHaveBeenCalledWith("1");
    expect(mockSheets.appendNote).toHaveBeenCalledWith("5", "it's getting worse");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("added that to the notes") })
    );
  });

  it("closes an issue by ID", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close #5", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("marked as resolved"),
      })
    );
  });

  it("closes an issue by description when single match", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Lobby printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
      { id: "6", description: "AC broken in room 3", submitter: "Bob", date: "4/2/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("marked as resolved"),
      })
    );
  });

  it("asks for clarification when multiple issues match close description", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed in lobby", submitter: "Alice", date: "4/1/2026", status: "Open" },
      { id: "6", description: "Printer jammed in office", submitter: "Bob", date: "4/2/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Multiple issues match"),
      })
    );
  });

  it("reports no match when close description doesn't match any issue", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close elevator stuck", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No open issue matching"),
      })
    );
  });

  it("lists open requests from the past 7 days", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(1), status: "Open" },
      { id: "6", description: "AC broken", submitter: "Bob", date: recentDate(20), status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> list", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Requests from the Past 7 Days"),
      })
    );
    const call = mockSay.mock.calls[0][0];
    expect(call.text).toContain("Printer jammed");
    expect(call.text).not.toContain("AC broken");
  });

  it("falls back to 5 most recent requests when none are within 7 days", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(20), status: "Open" },
      { id: "6", description: "AC broken", submitter: "Bob", date: recentDate(30), status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> list", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("5 Most Recent Requests"),
      })
    );
  });

  it("reports no open requests", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT> list", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({ text: "No open requests right now." })
    );
  });

  it("detects list/close commands inside an issue thread instead of appending a note", async () => {
    mockSheets.findIssueRowByRef.mockResolvedValue("5");
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "close #5", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
    expect(mockSheets.appendNote).not.toHaveBeenCalled();
  });

  it("handles sheets failure gracefully for the list command", async () => {
    mockSheets.getOpenIssues.mockRejectedValue(new Error("Sheets down"));

    await handler({
      event: { channel: "C123", text: "<@U_BOT> list", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Couldn't fetch requests"),
      })
    );
  });

  describe("photos", () => {
    let mockPhotoService;
    let photoHandler;

    beforeEach(() => {
      mockPhotoService = {
        collectPhotos: vi.fn().mockResolvedValue([
          { viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
        ]),
      };
      mockSheets.findIssueRowByRef.mockResolvedValue("5");
      photoHandler = createMentionHandler({
        sheetsService: mockSheets,
        channelIds: new Set(["C123"]),
        spreadsheetId: "sheet-id",
        photoService: mockPhotoService,
      });
    });

    it("appends a text + photo thread reply to an existing issue", async () => {
      const files = [{ id: "F2", name: "more.jpg", mimetype: "image/jpeg", url_private_download: "u2" }];
      await photoHandler({
        event: { channel: "C123", text: "here's a photo", user: "U1", ts: "3", thread_ts: "1", files },
        say: mockSay,
        client: mockClient,
      });

      expect(mockPhotoService.collectPhotos).toHaveBeenCalledWith(files);
      expect(mockSheets.appendNote).toHaveBeenCalledWith("5", "here's a photo");
      expect(mockSheets.appendPhotos).toHaveBeenCalledWith("5", [
        { viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
      ]);
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("added that to the notes"), thread_ts: "1" })
      );
    });

    it("appends a photo-only thread reply to an existing issue", async () => {
      const files = [{ id: "F2", name: "more.jpg", mimetype: "image/jpeg", url_private_download: "u2" }];
      await photoHandler({
        event: { channel: "C123", text: "", user: "U1", ts: "3", thread_ts: "1", files },
        say: mockSay,
        client: mockClient,
      });

      expect(mockSheets.appendPhotos).toHaveBeenCalledWith("5", [
        { viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
      ]);
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("photo"), thread_ts: "1" })
      );
    });
  });
});
