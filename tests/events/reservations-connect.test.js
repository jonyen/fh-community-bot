// tests/events/reservations-connect.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";
import { cardMessage, bookedMessage, EDIT_ACTION, CANCEL_ACTION } from "../../src/lib/reservation-card.js";
import { mineMessage } from "../../src/lib/reservation-mine.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const TRANSIT = { label: "CP Transit", category: "vehicles", backend: "rms", calendarId: "tr" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2, TRANSIT] });
const MPR = CATALOG.find((e) => e.label === "MPR");
const MEMBER_CLIENTS = { sheetsClient: { kind: "member-sheets" }, calendarClient: { kind: "member-cal" } };
const REQ = { intent: "book", items: [SET2], ambiguous: [], unmatched: [], date: "2026-10-17", toDate: null, start: 840, end: 960, title: "Youth night", ministry: null, appliances: {} };
const MSG_TS = "200.1";
const CARD_TS = "200.2";

function makeAdapter(backend) {
  return {
    backend, link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn().mockResolvedValue({ status: "booked", link: `https://${backend}/item` }),
    cancel: vi.fn().mockResolvedValue({ status: "cancelled", link: `https://${backend}/item` }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: CARD_TS }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555", email: "deandra.shim@acts2.network" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

function makeConnect(status = "none") {
  return {
    authStore: {
      createPending: vi.fn().mockResolvedValue({ pendingId: "P1", nonce: "NONCE" }),
      getPending: vi.fn(),
      deletePending: vi.fn().mockResolvedValue(),
      markRevoked: vi.fn().mockResolvedValue(),
    },
    memberGoogle: {
      clientsFor: vi.fn().mockResolvedValue(status === "active" ? { status, clients: MEMBER_CLIENTS, googleEmail: "deandra.shim@acts2.network" } : { status }),
      forget: vi.fn(),
      revoke: vi.fn().mockResolvedValue(true),
    },
    consentUrl: vi.fn(({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  };
}

describe("reservations with connected accounts", () => {
  let adapters, client, livingDigest;
  beforeEach(() => {
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
  });
  const handler = (connect) => createReservationsHandler({
    llm: { parseReservationRequest: vi.fn() }, adapters, catalog: CATALOG, channelId: "CRES",
    now: () => new Date("2026-10-14T16:00:00Z"), connect, livingDigest,
  });
  const updates = () => client.chat.update.mock.calls.map((c) => c[0]);
  const ephemerals = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);

  // Press Book on a free card for req, as the requester.
  async function pressBook(h, req = REQ) {
    const card = cardMessage({ user: "U9", req, assessment: { state: "free" } });
    client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS }, { ts: CARD_TS, bot_id: "B1", blocks: card.blocks }] });
    const book = card.blocks.find((b) => b.type === "actions").elements[0];
    await h.handleCardAction({ client, payload: {
      user: { id: "U9" }, channel: { id: "CRES" }, container: { message_ts: CARD_TS, channel_id: "CRES" },
      message: { ts: CARD_TS, thread_ts: MSG_TS, blocks: card.blocks }, actions: [book],
    } });
  }

  it("prompts a member who isn't connected, privately in the thread, and writes nothing", async () => {
    const connect = makeConnect("none");
    await pressBook(handler(connect));
    expect(adapters.rms.book).not.toHaveBeenCalled();
    const pending = connect.authStore.createPending.mock.calls[0][0];
    expect(pending).toMatchObject({ slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES", threadTs: MSG_TS });
    expect(pending.request).toMatchObject({ backend: "rms", cardTs: CARD_TS });
    expect(pending.request.req.items).toEqual([SET2]);
    expect(pending.request.requester).toEqual({ requesterName: "Deandra", requesterUserId: "U9", phone: "555", slackEmail: "deandra.shim@acts2.network" });
    expect(connect.consentUrl).toHaveBeenCalledWith({ state: "NONCE", loginHint: "deandra.shim@acts2.network" });
    const [prompt] = ephemerals();
    expect(prompt).toMatchObject({ channel: "CRES", user: "U9", thread_ts: MSG_TS, username: "Reservations" });
    expect(prompt.text).toMatch(/connect your acts2.network Google account once/);
    expect(prompt.blocks[1].elements[0]).toMatchObject({ type: "button", url: "https://accounts.google.com/o/oauth2/v2/auth?state=NONCE", action_id: "reservations_connect_google" });
    // The card stays open, so it can still be edited.
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(livingDigest.refresh).not.toHaveBeenCalled();
  });

  it("books as a connected member", async () => {
    const connect = makeConnect("active");
    await pressBook(handler(connect));
    expect(adapters.rms.book.mock.calls[0][1]).toEqual({ clients: MEMBER_CLIENTS });
    expect(adapters.rms.book.mock.calls[0][0]).not.toHaveProperty("slackEmail");
    expect(updates()[0].text).toMatch(/^✅ Tech Set 2/);
  });

  it("re-prompts when the member's token was revoked in Google", async () => {
    const connect = makeConnect("active");
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }));
    await pressBook(handler(connect));
    expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
    expect(connect.memberGoogle.forget).toHaveBeenCalledWith("U9");
    expect(ephemerals()[0].text).toMatch(/expired/);
  });

  it("re-prompts a member whose status is already revoked", async () => {
    const connect = makeConnect("revoked");
    await pressBook(handler(connect));
    expect(ephemerals()[0].text).toMatch(/expired/);
    expect(adapters.rms.book).not.toHaveBeenCalled();
  });

  it("re-prompts instead of blaming the sheet owner when the token lacks a scope", async () => {
    const connect = makeConnect("active");
    adapters.rooms.book.mockRejectedValue(Object.assign(new Error("Request had insufficient authentication scopes."), { code: 403 }));
    await pressBook(handler(connect), { ...REQ, items: [MPR] });
    expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
    expect(ephemerals()[0].text).toMatch(/expired|connect/i);
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("names who to ask when the member can't edit the room sheet", async () => {
    const connect = makeConnect("active");
    adapters.rooms.book.mockRejectedValue(Object.assign(new Error("The caller does not have permission"), { code: 403 }));
    await pressBook(handler(connect), { ...REQ, items: [MPR] });
    expect(updates()[0]).toMatchObject({ text: "You don't have edit access to the room request sheet. Ask Management to share it with you: https://rooms", metadata: CLOSED_METADATA });
  });

  it("names the vehicle's own owner when Calendar refuses the member", async () => {
    const connect = makeConnect("active");
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: 403 }));
    await pressBook(handler(connect), { ...REQ, items: [TRANSIT] });
    expect(updates()[0].text).toBe("Google Calendar won't let your account book CP Transit. Ask Mark Yeh.");
  });

  it("can't connect a member with no email on their Slack profile", async () => {
    const connect = makeConnect("none");
    client.users.info.mockResolvedValue({ user: { real_name: "X", profile: { display_name: "X" } } });
    await pressBook(handler(connect));
    expect(connect.authStore.createPending).not.toHaveBeenCalled();
    expect(updates()[0].text).toMatch(/can't see an email on your Slack profile/);
  });

  it("disconnect via slash command falls back to response_url", async () => {
    const connect = makeConnect("active");
    connect.memberGoogle.revoke.mockResolvedValue(false);
    client.chat.postEphemeral.mockRejectedValue(new Error("channel_not_found"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
    await handler(connect).disconnect({ userId: "U9", channel: "D1", client, responseUrl: "https://hooks.slack/r" });
    expect(fetchSpy).toHaveBeenCalledWith("https://hooks.slack/r", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ response_type: "ephemeral", text: "Your Google account wasn't connected." });
    fetchSpy.mockRestore();
  });

  it("without connect, books on the bot account as before", async () => {
    await pressBook(handler(null));
    expect(adapters.rms.book.mock.calls[0]).toHaveLength(1);
  });

  describe("Cancel booking", () => {
    const ROOM_REF = { backend: "rooms", date: "2026-10-17", start: 840, end: 960, title: "Youth night", holder: "Deandra", rooms: ["MPR"] };
    const BOT_RMS_REF = { backend: "rms", eventId: "ev1", organizerEmail: null, organizerSelf: true, resources: ["t2"], date: "2026-10-17", start: 840, end: 960, title: "Youth night — Deandra" };
    const SUMMARY = "✅ MPR · Sat 10/17 · 2:00–4:00 PM · Youth night · <@U9>";
    const REQUESTER = { requesterName: "Deandra", requesterUserId: "U9", phone: "555", slackEmail: "deandra.shim@acts2.network" };
    const bookedCard = (ref) => bookedMessage({ user: "U9", text: `${SUMMARY}\n<https://rooms/item|Open the booking>`, ref, req: { ...REQ, items: [MPR] } });

    async function pressCancel(h, ref) {
      const card = bookedCard(ref);
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS }, { ts: CARD_TS, bot_id: "B1", blocks: card.blocks }] });
      const button = card.blocks.find((b) => b.type === "actions").elements[0];
      await h.handleCardAction({ client, payload: {
        user: { id: "U9" }, channel: { id: "CRES" }, container: { message_ts: CARD_TS, channel_id: "CRES" },
        message: { ts: CARD_TS, thread_ts: MSG_TS, blocks: card.blocks }, actions: [button],
      } });
    }

    it("an unconnected member's cancel prompts Connect Google and resumes into cancel", async () => {
      const connect = makeConnect("none");
      await pressCancel(handler(connect), ROOM_REF);
      expect(adapters.rooms.cancel).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
      const row = connect.authStore.createPending.mock.calls[0][0];
      expect(row).toEqual({
        slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES", threadTs: MSG_TS,
        request: { kind: "cancel", ref: ROOM_REF, requester: REQUESTER, cardTs: CARD_TS, responseUrl: null },
      });
      const [prompt] = ephemerals();
      expect(prompt).toMatchObject({ channel: "CRES", user: "U9", thread_ts: MSG_TS, text: "To cancel as you, connect your acts2.network Google account once. I'll cancel this booking as soon as you approve." });
      expect(prompt.blocks[1].elements[0]).toMatchObject({ action_id: "reservations_connect_google", url: "https://accounts.google.com/o/oauth2/v2/auth?state=NONCE" });

      // The member approves: the pending row resumes into the cancel, as them.
      const after = makeConnect("active");
      after.authStore.getPending.mockResolvedValue(row);
      await handler(after).resume({ pendingId: "P1", client });
      expect(after.authStore.deletePending).toHaveBeenCalledWith("P1");
      expect(after.authStore.deletePending.mock.invocationCallOrder[0]).toBeLessThan(adapters.rooms.cancel.mock.invocationCallOrder[0]);
      expect(adapters.rooms.cancel.mock.calls).toEqual([[ROOM_REF, { clients: MEMBER_CLIENTS }]]);
      expect(adapters.rooms.book).not.toHaveBeenCalled();
      expect(updates()).toEqual([expect.objectContaining({ channel: "CRES", ts: CARD_TS, metadata: CLOSED_METADATA, text: `${SUMMARY}\n🚫 Booking cancelled by <@U9>.` })]);
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
    });

    it("a cancel from the list prompts privately, then resumes and answers privately, never in public", async () => {
      const connect = makeConnect("none");
      const button = mineMessage({ user: "U9", entries: [{ item: "MPR", ...ROOM_REF, matchedBy: null, openLink: null, ref: ROOM_REF }], more: 0, links: {} })
        .blocks.find((b) => b.accessory).accessory;
      await handler(connect).handleCardAction({ client, payload: {
        type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
        container: { type: "message", message_ts: "300.1", channel_id: "CRES", is_ephemeral: true },
        response_url: "https://hooks.slack/actions/r1", actions: [button],
      } });
      expect(adapters.rooms.cancel).not.toHaveBeenCalled();
      const row = connect.authStore.createPending.mock.calls[0][0];
      expect(row).toEqual({
        slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES", threadTs: null,
        request: { kind: "cancel", ref: ROOM_REF, requester: REQUESTER, cardTs: null, responseUrl: "https://hooks.slack/actions/r1" },
      });
      const [prompt] = ephemerals();
      expect(prompt).toMatchObject({ channel: "CRES", user: "U9", text: "To cancel as you, connect your acts2.network Google account once. I'll cancel this booking as soon as you approve." });
      expect(prompt.thread_ts).toBeUndefined();

      client.chat.postEphemeral.mockClear();
      const after = makeConnect("active");
      after.authStore.getPending.mockResolvedValue(row);
      await handler(after).resume({ pendingId: "P1", client });
      expect(adapters.rooms.cancel.mock.calls).toEqual([[ROOM_REF, { clients: MEMBER_CLIENTS }]]);
      expect(ephemerals()).toEqual([{ channel: "CRES", user: "U9", text: "🚫 Booking cancelled by <@U9>.", username: "Reservations", icon_emoji: ":calendar:" }]);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("a resumed cancel with no card answers privately, even with a thread on the row", async () => {
      const connect = makeConnect("active");
      adapters.rooms.cancel.mockResolvedValue({ status: "changed", link: "https://rooms/x" });
      connect.authStore.getPending.mockResolvedValue({
        slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES", threadTs: MSG_TS,
        request: { kind: "cancel", ref: ROOM_REF, requester: REQUESTER, cardTs: null, responseUrl: null },
      });
      await handler(connect).resume({ pendingId: "P1", client });
      expect(ephemerals()).toEqual([expect.objectContaining({ channel: "CRES", user: "U9", text: "I couldn't find that booking as it was; it may have been changed. Please check it here: https://rooms/x" })]);
      expect(ephemerals()[0].thread_ts).toBeUndefined();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("cancels as a connected member", async () => {
      const connect = makeConnect("active");
      await pressCancel(handler(connect), ROOM_REF);
      expect(adapters.rooms.cancel.mock.calls).toEqual([[ROOM_REF, { clients: MEMBER_CLIENTS }]]);
      expect(updates()[0].text).toBe(`${SUMMARY}\n🚫 Booking cancelled by <@U9>.`);
    });

    it("a bot-organized RMS event is cancelled with the bot client even when connect is on", async () => {
      const connect = makeConnect("none");
      await pressCancel(handler(connect), BOT_RMS_REF);
      expect(adapters.rms.cancel.mock.calls).toEqual([[BOT_RMS_REF]]);
      expect(connect.memberGoogle.clientsFor).not.toHaveBeenCalled();
      expect(connect.authStore.createPending).not.toHaveBeenCalled();
      expect(updates()[0].text).toBe(`${SUMMARY}\n🚫 Booking cancelled by <@U9>.`);
    });

    it("a member-organized RMS event is cancelled as the member", async () => {
      const connect = makeConnect("active");
      const ref = { ...BOT_RMS_REF, organizerSelf: false, organizerEmail: "deandra.shim@acts2.network" };
      await pressCancel(handler(connect), ref);
      expect(adapters.rms.cancel.mock.calls).toEqual([[ref, { clients: MEMBER_CLIENTS }]]);
    });

    it("re-prompts when the member's token was revoked during a cancel", async () => {
      const connect = makeConnect("active");
      adapters.rooms.cancel.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }));
      await pressCancel(handler(connect), ROOM_REF);
      expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
      expect(connect.memberGoogle.forget).toHaveBeenCalledWith("U9");
      expect(connect.authStore.createPending.mock.calls[0][0].request.kind).toBe("cancel");
      expect(ephemerals()[0].text).toMatch(/expired/);
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("names who to ask when the member can't edit the room sheet", async () => {
      const connect = makeConnect("active");
      adapters.rooms.cancel.mockRejectedValue(Object.assign(new Error("The caller does not have permission"), { code: 403 }));
      await pressCancel(handler(connect), ROOM_REF);
      expect(updates()[0].text).toBe(`${SUMMARY}\nYou don't have edit access to the room request sheet. Ask Management to share it with you: https://rooms`);
    });
  });

  describe("resume after sign-in", () => {
    const pending = (connect, { channel = "CRES", threadTs = MSG_TS, cardTs = CARD_TS } = {}) => connect.authStore.getPending.mockResolvedValue({
      slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel, threadTs,
      request: {
        backend: "rms", cardTs,
        req: { items: [SET2], date: "2026-10-17", start: 840, end: 960, title: "Youth night", ministry: null, appliances: {} },
        requester: { requesterName: "Deandra", requesterUserId: "U9", phone: "555", slackEmail: "deandra.shim@acts2.network" },
      },
    });

    it("deletes the pending booking first, re-checks conflicts, then books as the member", async () => {
      const connect = makeConnect("active");
      pending(connect);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(connect.authStore.deletePending).toHaveBeenCalledWith("P1");
      expect(connect.authStore.deletePending.mock.invocationCallOrder[0]).toBeLessThan(adapters.rms.book.mock.invocationCallOrder[0]);
      expect(adapters.rms.findConflicts).toHaveBeenCalledWith({ date: "2026-10-17", start: 840, end: 960, items: [SET2] });
      expect(adapters.rms.book.mock.calls[0]).toEqual([
        { date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night", ministry: null, requesterName: "Deandra", requesterUserId: "U9", phone: "555", appliances: {} },
        { clients: MEMBER_CLIENTS },
      ]);
    });

    it("replaces the card with the confirmation and refreshes the digest", async () => {
      const connect = makeConnect("active");
      pending(connect);
      await handler(connect).resume({ pendingId: "P1", client });
      const [u] = updates();
      expect(u).toMatchObject({ channel: "CRES", ts: CARD_TS, metadata: CLOSED_METADATA });
      expect(u.text).toMatch(/^✅ Tech Set 2/);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
    });

    it("a pending row from before cards replies where it was made", async () => {
      const connect = makeConnect("active");
      pending(connect, { channel: "D9", threadTs: null, cardTs: null });
      await handler(connect).resume({ pendingId: "P1", client });
      const [p] = client.chat.postMessage.mock.calls.map((c) => c[0]);
      expect(p).toMatchObject({ channel: "D9" });
      expect(p.thread_ts).toBeUndefined();
      expect(p.text).toMatch(/^✅ Tech Set 2/);
    });

    it("a slot taken during sign-in turns the card to taken instead of booking", async () => {
      const connect = makeConnect("active");
      pending(connect);
      adapters.rms.findConflicts.mockResolvedValue([{ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 900, title: "Rally", holder: "Alan", holderUserId: null, holderEmail: null }]);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      const [u] = updates();
      expect(u.blocks[0].text.text).toContain("❌ Taken:");
      expect(u.blocks[1].elements.map((e) => e.action_id)).toEqual([EDIT_ACTION, CANCEL_ACTION]);
    });

    it("does nothing for an unknown or already-used pending id", async () => {
      const connect = makeConnect("active");
      connect.authStore.getPending.mockResolvedValue(null);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("tells the member when a resume fails instead of going silent", async () => {
      const connect = makeConnect("active");
      pending(connect);
      adapters.rms.findConflicts.mockRejectedValue(new Error("backendError"));
      await expect(handler(connect).resume({ pendingId: "P1", client })).resolves.toBeUndefined();
      expect(updates()[0]).toMatchObject({
        ts: CARD_TS, metadata: CLOSED_METADATA,
        text: "⚠️ I couldn't finish this booking after you connected (backendError). Please send it again, or book directly: https://rms",
      });
    });
  });
});
