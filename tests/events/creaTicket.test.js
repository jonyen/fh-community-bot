import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCreaTicketHandler } from "../../src/events/creaTicket.js";
import { buildCreaDraftBlocks } from "../../src/lib/crea-ticket.js";

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

// A block_actions payload for a click on a posted draft, with the fields
// holding `title` / `description` as the user left them.
function makeDraftPayload({ actionId = "send_crea_ticket", user = "U1", type = "Plumbing", title = null, description = "The kitchen sink is leaking." } = {}) {
  const blocks = buildCreaDraftBlocks({ title, description, type, draftKey: "100.1" });
  const values = { "crea_description:100.1": { crea_description: { type: "plain_text_input", value: description } } };
  if (title !== null) values["crea_title:100.1"] = { crea_title: { type: "plain_text_input", value: title } };
  return {
    type: "block_actions",
    user: { id: user },
    channel: { id: "C123" },
    actions: [{ action_id: actionId }],
    message: { ts: "100.5", thread_ts: "100.1", blocks },
    state: { values },
  };
}

describe("CreaTicketHandler", () => {
  let twa;
  let sheets;
  let client;
  let fetchImpl;
  let ticketWriter;
  let crea;

  function makeHandler(overrides = {}) {
    return createCreaTicketHandler({
      twaService: twa,
      sheetsService: sheets,
      ticketWriter,
      channelIds: new Set(["C123"]),
      allowedUserIds: new Set(["U1", "U2"]),
      slackBotToken: "xoxb",
      fetchImpl,
      ...overrides,
    });
  }

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
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    fetchImpl = vi.fn();
    ticketWriter = {
      writeLandlordTicket: vi.fn().mockResolvedValue({
        title: "Leaking kitchen sink",
        description: "The kitchen sink is leaking.",
      }),
    };
    crea = makeHandler();
  });

  function postedDraft() {
    const call = client.chat.postMessage.mock.calls.find(([args]) => args.blocks);
    return call?.[0];
  }

  function draftInputValue(blocks, actionId) {
    return blocks.find((b) => b.element?.action_id === actionId)?.element.initial_value;
  }

  describe("reaction: posting the draft", () => {
    it("posts the rewritten report as a draft in the thread and files nothing yet", async () => {
      await crea.handleReaction({ event: makeEvent(), client });

      expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "C123", ts: "100.2", limit: 1 });
      expect(sheets.findIssueByRef).toHaveBeenCalledWith("100.1");
      expect(ticketWriter.writeLandlordTicket).toHaveBeenCalledWith("sink leaking", { type: "Plumbing" });
      const draft = postedDraft();
      expect(draft).toMatchObject({ channel: "C123", thread_ts: "100.1" });
      expect(draftInputValue(draft.blocks, "crea_description")).toBe("The kitchen sink is leaking.");
      expect(JSON.stringify(draft.blocks)).not.toContain("Severity");
      expect(JSON.stringify(draft.blocks)).not.toContain("Test User");
      expect(JSON.stringify(draft.blocks)).toContain("send_crea_ticket");
      expect(twa.submitServiceIssue).not.toHaveBeenCalled();
    });

    it("only shows a title field when the type is Other", async () => {
      await crea.handleReaction({ event: makeEvent(), client });
      expect(draftInputValue(postedDraft().blocks, "crea_title")).toBeUndefined();

      client.chat.postMessage.mockClear();
      client.reactions.add.mockResolvedValue({});
      sheets.findIssueByRef.mockResolvedValue({ id: "9", description: "odd noise", type: "Other", priority: "Minor" });
      await crea.handleReaction({ event: makeEvent(), client });
      expect(draftInputValue(postedDraft().blocks, "crea_title")).toBe("Leaking kitchen sink");
    });

    it("drafts from the report as written when the rewrite fails", async () => {
      for (const writeLandlordTicket of [vi.fn().mockResolvedValue(null), vi.fn().mockRejectedValue(new Error("down"))]) {
        client.chat.postMessage.mockClear();
        await makeHandler({ ticketWriter: { writeLandlordTicket } }).handleReaction({ event: makeEvent(), client });
        expect(draftInputValue(postedDraft().blocks, "crea_description")).toBe("sink leaking");
      }
    });

    it("claims the report on the thread root before drafting", async () => {
      await crea.handleReaction({ event: makeEvent(), client });
      expect(client.reactions.add).toHaveBeenCalledWith({ channel: "C123", timestamp: "100.1", name: "incoming_envelope" });
    });

    it("does nothing when the report was already drafted or sent", async () => {
      client.reactions.add.mockRejectedValue(slackError("already_reacted"));
      await crea.handleReaction({ event: makeEvent(), client });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("releases the claim when the draft can't be posted", async () => {
      client.chat.postMessage.mockRejectedValue(new Error("boom"));
      await crea.handleReaction({ event: makeEvent(), client });
      expect(client.reactions.remove).toHaveBeenCalledWith({ channel: "C123", timestamp: "100.1", name: "incoming_envelope" });
    });

    it("accepts the admission_tickets emoji and skin-tone variants", async () => {
      await crea.handleReaction({ event: makeEvent({ reaction: "admission_tickets" }), client });
      await crea.handleReaction({ event: makeEvent({ reaction: "ticket::skin-tone-2" }), client });
      expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    });

    it("ignores other emoji, other channels and non-message items", async () => {
      await crea.handleReaction({ event: makeEvent({ reaction: "eyes" }), client });
      await crea.handleReaction({ event: makeEvent({ item: { type: "message", channel: "C999", ts: "1.1" } }), client });
      await crea.handleReaction({ event: makeEvent({ item: { type: "file", channel: "C123", file: "F1" } }), client });
      expect(client.conversations.replies).not.toHaveBeenCalled();
    });

    it("tells the reactor privately when the message isn't a logged report", async () => {
      sheets.findIssueByRef.mockResolvedValue(null);
      await crea.handleReaction({ event: makeEvent(), client });

      expect(client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "C123", user: "U1", text: expect.stringContaining("isn't a logged maintenance report") })
      );
      expect(client.reactions.add).not.toHaveBeenCalled();
    });

    it("tells someone not on the list that they can't file, and drafts nothing", async () => {
      await crea.handleReaction({ event: makeEvent({ user: "U_OTHER" }), client });

      expect(client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "C123", user: "U_OTHER", text: expect.stringContaining("Only the facilities leads") })
      );
      expect(client.reactions.add).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("lets nobody draft when the allowlist is empty", async () => {
      await makeHandler({ allowedUserIds: new Set() }).handleReaction({ event: makeEvent(), client });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("draft: Send and Cancel", () => {
    it("ignores clicks that aren't on a CREA draft button", async () => {
      await crea.handleDraftAction({ payload: makeDraftPayload({ actionId: "submit_maintenance_form" }), client });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(twa.submitServiceIssue).not.toHaveBeenCalled();
    });

    it("files the draft exactly as edited, with no severity or reporter added", async () => {
      const payload = makeDraftPayload({ description: "Kitchen sink leaks under the basin." });
      await crea.handleDraftAction({ payload, client });

      expect(twa.submitServiceIssue).toHaveBeenCalledWith({
        type: "Plumbing",
        title: "Kitchen sink leaks under the basin.",
        description: "Kitchen sink leaks under the basin.",
        photos: [],
      });
    });

    it("uses the edited title for an Other ticket", async () => {
      sheets.findIssueByRef.mockResolvedValue({ id: "9", description: "x", type: "Other", priority: "Minor" });
      await crea.handleDraftAction({ payload: makeDraftPayload({ type: "Other", title: "Strange noise in boiler room" }), client });
      expect(twa.submitServiceIssue).toHaveBeenCalledWith(expect.objectContaining({ type: "Other", title: "Strange noise in boiler room" }));
    });

    it("lets anyone on the list send, not only whoever reacted", async () => {
      await crea.handleDraftAction({ payload: makeDraftPayload({ user: "U2" }), client });
      expect(twa.submitServiceIssue).toHaveBeenCalled();
    });

    it("refuses a Send from someone not on the list", async () => {
      await crea.handleDraftAction({ payload: makeDraftPayload({ user: "U_OTHER" }), client });
      expect(client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({ user: "U_OTHER", text: expect.stringContaining("Only the facilities leads") })
      );
      expect(twa.submitServiceIssue).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("strips the buttons before filing, so a second click is dropped", async () => {
      twa.submitServiceIssue.mockImplementation(async () => {
        expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "100.5", text: "Sending to CREA…" }));
        return { status: "created", attachedPhotos: 0, skippedPhotos: 0 };
      });
      await crea.handleDraftAction({ payload: makeDraftPayload(), client });
      expect(twa.submitServiceIssue).toHaveBeenCalled();

      const stale = { ...makeDraftPayload(), message: { ts: "100.5", thread_ts: "100.1", blocks: [{ type: "section" }] } };
      twa.submitServiceIssue.mockClear();
      await crea.handleDraftAction({ payload: stale, client });
      expect(twa.submitServiceIssue).not.toHaveBeenCalled();
    });

    it("replaces the draft with a record of what was sent and notes it in the sheet", async () => {
      await crea.handleDraftAction({ payload: makeDraftPayload(), client });

      const last = client.chat.update.mock.calls.at(-1)[0];
      expect(last.text).toContain("Sent to CREA as a service issue by <@U1>.");
      expect(last.text).toContain("> The kitchen sink is leaking.");
      expect(last.text).not.toContain("Severity");
      expect(sheets.appendNote).toHaveBeenCalledWith("9", expect.stringContaining("sent to CREA portal"));
    });

    it("asks for a description instead of filing an empty one", async () => {
      await crea.handleDraftAction({ payload: makeDraftPayload({ description: "  " }), client });
      expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("description is empty") }));
      expect(twa.submitServiceIssue).not.toHaveBeenCalled();
    });

    it("puts the edited draft back and explains when the portal fails", async () => {
      twa.submitServiceIssue.mockRejectedValue(new Error("Rent Manager login failed"));
      await crea.handleDraftAction({ payload: makeDraftPayload({ description: "Edited text." }), client });

      const restored = client.chat.update.mock.calls.at(-1)[0];
      expect(draftInputValue(restored.blocks, "crea_description")).toBe("Edited text.");
      expect(JSON.stringify(restored.blocks)).toContain("send_crea_ticket");
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: "100.1", text: expect.stringContaining("Couldn't send this to CREA") })
      );
      expect(client.reactions.remove).not.toHaveBeenCalled();
      expect(sheets.appendNote).not.toHaveBeenCalled();
    });

    it("warns when the outcome is unknown, so nobody resends blindly", async () => {
      twa.submitServiceIssue.mockResolvedValue({ status: "unknown", attachedPhotos: 0, skippedPhotos: 0 });
      await crea.handleDraftAction({ payload: makeDraftPayload(), client });
      expect(client.chat.update.mock.calls.at(-1)[0].text).toContain("Check Service Issues in the tenant portal");
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

      await crea.handleDraftAction({ payload: makeDraftPayload(), client });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith("https://files.slack/leak.jpg", { headers: { Authorization: "Bearer xoxb" } });
      const { photos } = twa.submitServiceIssue.mock.calls[0][0];
      expect(photos).toHaveLength(1);
      expect(photos[0]).toMatchObject({ name: "leak.jpg", mimeType: "image/jpeg" });
      expect(photos[0].buffer.toString()).toBe("jpegbytes");
    });

    it("sends an iPhone HEIC as a JPEG made from Slack's largest preview", async () => {
      const { PNG } = await import("pngjs");
      const png = new PNG({ width: 2, height: 2 });
      png.data.fill(200);
      client.conversations.replies.mockResolvedValue({
        messages: [{
          ts: "100.1",
          files: [{
            id: "F1", name: "IMG_7061.HEIC", mimetype: "image/heic", size: 2_116_704,
            url_private_download: "https://files.slack/orig.heic",
            thumb_480: "https://files.slack/t480.png", thumb_1024: "https://files.slack/t1024.png",
          }],
        }],
      });
      fetchImpl.mockResolvedValue(new Response(PNG.sync.write(png), { headers: { "content-type": "image/png" } }));

      await crea.handleDraftAction({ payload: makeDraftPayload(), client });

      expect(fetchImpl).toHaveBeenCalledWith("https://files.slack/t1024.png", { headers: { Authorization: "Bearer xoxb" } });
      const [photo] = twa.submitServiceIssue.mock.calls[0][0].photos;
      expect(photo).toMatchObject({ name: "IMG_7061.jpg", mimeType: "image/jpeg" });
      expect([...photo.buffer.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    });

    it("Cancel deletes the draft and frees the report for a new :ticket:", async () => {
      await crea.handleDraftAction({ payload: makeDraftPayload({ actionId: "cancel_crea_ticket" }), client });

      expect(client.chat.delete).toHaveBeenCalledWith({ channel: "C123", ts: "100.5" });
      expect(client.reactions.remove).toHaveBeenCalledWith({ channel: "C123", timestamp: "100.1", name: "incoming_envelope" });
      expect(twa.submitServiceIssue).not.toHaveBeenCalled();
    });
  });
});
