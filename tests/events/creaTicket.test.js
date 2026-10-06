import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCreaTicketHandler } from "../../src/events/creaTicket.js";

function makeEvent(overrides = {}) {
  return {
    type: "reaction_added",
    user: "U1",
    reaction: "ticket",
    item: { type: "message", channel: "C123", ts: "100.2" },
    ...overrides,
  };
}

function slackError(code) {
  const err = new Error(`An API error occurred: ${code}`);
  err.data = { ok: false, error: code };
  return err;
}

describe("CreaTicketHandler", () => {
  let twa;
  let sheets;
  let client;
  let fetchImpl;
  let handler;

  beforeEach(() => {
    twa = { submitServiceIssue: vi.fn().mockResolvedValue({ status: "created", attachedPhotos: 0, skippedPhotos: 0 }) };
    sheets = {
      findIssueByRef: vi.fn().mockResolvedValue({
        id: "9",
        description: "sink leaking",
        priority: "Medium",
        type: "Plumbing",
        submitter: "Test User",
      }),
      appendNote: vi.fn().mockResolvedValue(),
    };
    client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ ts: "100.1", thread_ts: "100.1", files: [] }] }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
        postEphemeral: vi.fn().mockResolvedValue({}),
      },
    };
    fetchImpl = vi.fn();
    handler = createCreaTicketHandler({
      twaService: twa,
      sheetsService: sheets,
      channelIds: new Set(["C123"]),
      allowedUserIds: new Set(["U1"]),
      slackBotToken: "xoxb",
      fetchImpl,
    });
  });

  it("files the sheet's copy of the report, keyed by the thread root", async () => {
    await handler({ event: makeEvent(), client });

    expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "C123", ts: "100.2", limit: 1 });
    expect(sheets.findIssueByRef).toHaveBeenCalledWith("100.1");
    expect(twa.submitServiceIssue).toHaveBeenCalledWith({
      type: "Plumbing",
      title: "sink leaking",
      description: "sink leaking\n\nSeverity: Medium\nReported by: Test User",
      photos: [],
    });
  });

  it("claims the report with a reaction on the thread root before filing", async () => {
    twa.submitServiceIssue.mockImplementation(async () => {
      expect(client.reactions.add).toHaveBeenCalledWith({ channel: "C123", timestamp: "100.1", name: "incoming_envelope" });
      return { status: "created", attachedPhotos: 0, skippedPhotos: 0 };
    });
    await handler({ event: makeEvent(), client });
    expect(twa.submitServiceIssue).toHaveBeenCalled();
  });

  it("confirms in the thread and notes it in the sheet", async () => {
    await handler({ event: makeEvent(), client });

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "100.1",
      text: "Sent to CREA as a service issue (requested by <@U1>).",
    });
    expect(sheets.appendNote).toHaveBeenCalledWith("9", expect.stringContaining("sent to CREA portal"));
  });

  it("does nothing when the report was already claimed", async () => {
    client.reactions.add.mockRejectedValue(slackError("already_reacted"));
    await handler({ event: makeEvent(), client });

    expect(twa.submitServiceIssue).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("accepts the admission_tickets emoji and skin-tone variants", async () => {
    await handler({ event: makeEvent({ reaction: "admission_tickets" }), client });
    await handler({ event: makeEvent({ reaction: "ticket::skin-tone-2" }), client });
    expect(twa.submitServiceIssue).toHaveBeenCalledTimes(2);
  });

  it("ignores other emoji, other channels and non-message items", async () => {
    await handler({ event: makeEvent({ reaction: "eyes" }), client });
    await handler({ event: makeEvent({ item: { type: "message", channel: "C999", ts: "1.1" } }), client });
    await handler({ event: makeEvent({ item: { type: "file", channel: "C123", file: "F1" } }), client });

    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(twa.submitServiceIssue).not.toHaveBeenCalled();
  });

  it("tells the reactor privately when the message isn't a logged report", async () => {
    sheets.findIssueByRef.mockResolvedValue(null);
    await handler({ event: makeEvent(), client });

    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", user: "U1", text: expect.stringContaining("isn't a logged maintenance report") })
    );
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(twa.submitServiceIssue).not.toHaveBeenCalled();
  });

  it("releases the claim and explains when the portal fails", async () => {
    twa.submitServiceIssue.mockRejectedValue(new Error("Rent Manager login failed (HTTP 200, landed on /Shared/Login)"));
    await handler({ event: makeEvent(), client });

    expect(client.reactions.remove).toHaveBeenCalledWith({ channel: "C123", timestamp: "100.1", name: "incoming_envelope" });
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "100.1", text: expect.stringContaining("Couldn't send this to CREA") })
    );
    expect(sheets.appendNote).not.toHaveBeenCalled();
  });

  it("keeps the claim when the outcome is unknown, so nobody resends blindly", async () => {
    twa.submitServiceIssue.mockResolvedValue({ status: "unknown", attachedPhotos: 0, skippedPhotos: 0 });
    await handler({ event: makeEvent(), client });

    expect(client.reactions.remove).not.toHaveBeenCalled();
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("Check Service Issues in the tenant portal");
  });

  it("downloads the thread-root photos from Slack and passes the bytes on", async () => {
    client.conversations.replies.mockResolvedValue({
      messages: [{
        ts: "100.1",
        files: [
          { id: "F1", name: "leak.jpg", mimetype: "image/jpeg", url_private_download: "https://files.slack/leak.jpg" },
          { id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private: "https://files.slack/notes.pdf" },
        ],
      }],
    });
    fetchImpl.mockResolvedValue(new Response("jpegbytes"));

    await handler({ event: makeEvent(), client });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://files.slack/leak.jpg", { headers: { Authorization: "Bearer xoxb" } });
    const { photos } = twa.submitServiceIssue.mock.calls[0][0];
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ name: "leak.jpg", mimeType: "image/jpeg" });
    expect(photos[0].buffer.toString()).toBe("jpegbytes");
  });

  it("tells someone not on the list that they can't file, and files nothing", async () => {
    await handler({ event: makeEvent({ user: "U_OTHER" }), client });

    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", user: "U_OTHER", text: expect.stringContaining("Only the facilities leads") })
    );
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(twa.submitServiceIssue).not.toHaveBeenCalled();
  });

  it("lets nobody file when the allowlist is empty", async () => {
    const locked = createCreaTicketHandler({
      twaService: twa, sheetsService: sheets, channelIds: new Set(["C123"]),
      allowedUserIds: new Set(), slackBotToken: "xoxb", fetchImpl,
    });
    await locked({ event: makeEvent(), client });
    expect(twa.submitServiceIssue).not.toHaveBeenCalled();
  });
});
