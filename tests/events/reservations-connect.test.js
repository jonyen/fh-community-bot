// tests/events/reservations-connect.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA, REQUEST_EVENT_TYPE } from "../../src/lib/reservation-format.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const TRANSIT = { label: "CP Transit", category: "vehicles", backend: "rms", calendarId: "tr" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2, TRANSIT] });
const BOOK = { intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" };
const MEMBER_CLIENTS = { sheetsClient: { kind: "member-sheets" }, calendarClient: { kind: "member-cal" } };

function makeAdapter(backend) {
  return {
    backend, link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn().mockResolvedValue({ status: "booked", link: `https://${backend}/item` }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, channel: "D9", ts: "100.1" }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) },
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

const cmd = (o = {}) => ({ type: "slash_command", command: "/reserve", user_id: "U9", channel_id: "D9", text: "book tech set 2 sat 2-4pm for youth night", response_url: "https://hooks.slack/r", ...o });

describe("reservations with connected accounts", () => {
  let llm, adapters, client, livingDigest;
  beforeEach(() => {
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
  });
  // Everything the bot posts except the /reserve start marker.
  const posts = () => client.chat.postMessage.mock.calls.map((c) => c[0]).filter((p) => p.metadata?.event_type !== REQUEST_EVENT_TYPE);
  const isPrompt = (p) => !!p.blocks;
  const prompts = () => posts().filter(isPrompt);
  const replies = () => posts().filter((p) => !isPrompt(p));
  const handler = (connect) => createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => new Date("2026-10-14T16:00:00Z"), connect, livingDigest });

  it("prompts a member who isn't connected, keeps the booking pending, writes nothing", async () => {
    const connect = makeConnect("none");
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(adapters.rms.book).not.toHaveBeenCalled();
    const pending = connect.authStore.createPending.mock.calls[0][0];
    expect(pending).toMatchObject({ slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "D9", threadTs: null });
    expect(pending.request.backend).toBe("rms");
    expect(pending.request.req.items).toEqual([SET2]);
    expect(pending.request.requester).toEqual({ requesterName: "Deandra", requesterUserId: "U9", phone: "555", slackEmail: "deandra.shim@acts2.network" });
    expect(connect.consentUrl).toHaveBeenCalledWith({ state: "NONCE", loginHint: "deandra.shim@acts2.network" });
    // The DM is private, so the prompt is a plain DM message, left open.
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    const [prompt] = prompts();
    expect(prompt).toMatchObject({ channel: "D9", username: "FH Reservations" });
    expect(prompt.thread_ts).toBeUndefined();
    expect(prompt.metadata).toBeUndefined();
    expect(prompt.text).toMatch(/connect your Google account once/);
    expect(prompt.blocks[1].elements[0]).toMatchObject({ type: "button", url: "https://accounts.google.com/o/oauth2/v2/auth?state=NONCE", action_id: "reservations_connect_google" });
    expect(replies()).toEqual([]);
    expect(livingDigest.refresh).not.toHaveBeenCalled();
  });

  it("books as a connected member", async () => {
    const connect = makeConnect("active");
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(adapters.rms.book.mock.calls[0][1]).toEqual({ clients: MEMBER_CLIENTS });
    expect(adapters.rms.book.mock.calls[0][0]).not.toHaveProperty("slackEmail");
    expect(replies()[0].text).toMatch(/^✅ Tech Set 2/);
  });

  it("re-prompts when the member's token was revoked in Google", async () => {
    const connect = makeConnect("active");
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }));
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
    expect(connect.memberGoogle.forget).toHaveBeenCalledWith("U9");
    expect(prompts()[0].text).toMatch(/expired/);
    expect(connect.authStore.createPending).toHaveBeenCalled();
  });

  it("re-prompts a member whose status is already revoked", async () => {
    const connect = makeConnect("revoked");
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(prompts()[0].text).toMatch(/expired/);
    expect(adapters.rms.book).not.toHaveBeenCalled();
  });

  it("names who to ask when the member can't edit the room sheet", async () => {
    const connect = makeConnect("active");
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"] });
    adapters.rooms.book.mockRejectedValue(Object.assign(new Error("The caller does not have permission"), { code: 403 }));
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(replies()[0].text).toBe("You don't have edit access to the room request sheet. Ask Management to share it with you: https://rooms");
  });

  it("names the equipment owner when Calendar refuses the member", async () => {
    const connect = makeConnect("active");
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: 403 }));
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(replies()[0].text).toBe("Google Calendar won't let your account book Tech Set 2. Ask Alan Chow.");
  });

  it("names the vehicle's own owner when Calendar refuses the member", async () => {
    const connect = makeConnect("active");
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["CP Transit"] });
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: 403 }));
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(replies()[0].text).toBe("Google Calendar won't let your account book CP Transit. Ask Mark Yeh.");
  });

  it("can't connect a member with no email on their Slack profile", async () => {
    const connect = makeConnect("none");
    client.users.info.mockResolvedValue({ user: { real_name: "X", profile: { display_name: "X" } } });
    await handler(connect).handleCommand({ envelope: cmd(), client });
    expect(connect.authStore.createPending).not.toHaveBeenCalled();
    expect(replies()[0].text).toMatch(/can't see an email on your Slack profile/);
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
    await handler(null).handleCommand({ envelope: cmd(), client });
    expect(adapters.rms.book.mock.calls[0]).toHaveLength(1);
  });

  describe("resume after sign-in", () => {
    const pending = (connect, where = { channel: "D9", threadTs: null }) => connect.authStore.getPending.mockResolvedValue({
      slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", ...where,
      request: {
        backend: "rms",
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

    it("resume replies in the DM, closes the request and refreshes the digest", async () => {
      const connect = makeConnect("active");
      pending(connect);
      await handler(connect).resume({ pendingId: "P1", client });
      const [p] = replies();
      expect(p).toMatchObject({ channel: "D9", metadata: CLOSED_METADATA });
      expect(p.text).toMatch(/^✅ Tech Set 2/);
      expect(p.thread_ts).toBeUndefined();
      expect(p.reply_broadcast).toBeUndefined();
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
    });

    it("a pending row from before the DM change replies in its old thread", async () => {
      const connect = makeConnect("active");
      pending(connect, { channel: "CRES", threadTs: "100.1" });
      await handler(connect).resume({ pendingId: "P1", client });
      expect(replies()[0]).toMatchObject({ channel: "CRES", thread_ts: "100.1", metadata: CLOSED_METADATA });
    });

    it("reports a slot taken during sign-in instead of booking", async () => {
      const connect = makeConnect("active");
      pending(connect);
      adapters.rms.findConflicts.mockResolvedValue([{ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 900, title: "Rally", holder: "Alan", holderUserId: null, holderEmail: null }]);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(replies()[0].text).toMatch(/^❌ Tech Set 2 is taken/);
    });

    it("does nothing for an unknown or already-used pending id", async () => {
      const connect = makeConnect("active");
      connect.authStore.getPending.mockResolvedValue(null);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(replies()).toEqual([]);
    });
  });

  describe("review fixes", () => {
    it("re-prompts instead of blaming the sheet owner when the token lacks a scope", async () => {
      const connect = makeConnect("active");
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"] });
      adapters.rooms.book.mockRejectedValue(Object.assign(new Error("Request had insufficient authentication scopes."), { code: 403 }));
      await handler(connect).handleCommand({ envelope: cmd(), client });
      expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
      expect(prompts()[0].text).toMatch(/expired|connect/i);
      expect(replies()).toEqual([]);
    });

    it("tells the member when a resume fails instead of going silent", async () => {
      const connect = makeConnect("active");
      connect.authStore.getPending.mockResolvedValue({
        slackUserId: "U9", slackEmail: "e", channel: "D9", threadTs: null,
        request: { backend: "rms", req: { items: [SET2], date: "2026-10-17", start: 840, end: 960, title: "T", ministry: null, appliances: {} },
          requester: { requesterName: "D", requesterUserId: "U9", phone: "", slackEmail: "e" } },
      });
      adapters.rms.findConflicts.mockRejectedValue(new Error("backendError"));
      await expect(handler(connect).resume({ pendingId: "P1", client })).resolves.toBeUndefined();
      expect(replies()[0]).toMatchObject({ channel: "D9", metadata: CLOSED_METADATA });
      expect(replies()[0].thread_ts).toBeUndefined();
      expect(replies()[0].text).toBe("⚠️ I couldn't finish this booking after you connected (backendError). Please send it again, or book directly: https://rms");
    });
  });
});

