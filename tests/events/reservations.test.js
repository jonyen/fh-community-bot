// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });

function makeAdapter(backend) {
  return {
    backend,
    link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn().mockResolvedValue({ status: "booked", link: `https://${backend}/item` }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "100.1" }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack/p1" }),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555-0100" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

const BOOK = { intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" };
const cmd = (o = {}) => ({ type: "slash_command", command: "/reserve", user_id: "U9", channel_id: "CRES", text: "book tech set 2 sat 2-4 for youth night", response_url: "https://hooks.slack/r", ...o });
const msg = (o = {}) => ({ type: "message", channel: "CRES", user: "U9", text: "book tech set 2 sat 2-4 for youth night", ts: "100.1", ...o });

describe("reservations handler", () => {
  let llm, adapters, client, h;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => new Date("2026-10-14T16:00:00Z") });
  });
  // Bot replies in the request thread (the request post itself has no thread_ts).
  const posts = () => client.chat.postMessage.mock.calls.map((c) => c[0]).filter((p) => p.thread_ts);

  it("exposes its channel", () => {
    expect(h.channelId).toBe("CRES");
  });

  it("ignores top-level messages: only /reserve starts a request", async () => {
    await h.handleMessage({ event: msg(), client });
    await h.handleMessage({ event: msg({ channel: "COTHER", thread_ts: "1.0" }), client });
    expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("parses a top-level message with today's date context", async () => {
    await h.handleCommand({ envelope: cmd(), client });
    expect(llm.parseReservationRequest).toHaveBeenCalledWith(
      "Member: book tech set 2 sat 2-4 for youth night",
      expect.objectContaining({ today: "2026-10-14", weekday: "Wednesday", catalogText: expect.stringContaining("Tech Set 2") })
    );
  });

  it("books a free slot and broadcasts the confirmation", async () => {
    await h.handleCommand({ envelope: cmd(), client });
    expect(adapters.rms.book).toHaveBeenCalledWith({
      date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night", ministry: null,
      requesterName: "Deandra", requesterUserId: "U9", phone: "555-0100", permalink: "https://slack/p1", appliances: {},
    });
    const [p] = posts();
    expect(p).toMatchObject({ channel: "CRES", thread_ts: "100.1", reply_broadcast: true, username: "FH Reservations", metadata: CLOSED_METADATA });
    expect(p.text).toContain("✅ Tech Set 2 · Sat 10/17 · 2:00–4:00 PM · Youth night · <@U9>");
    expect(p.text).toContain("ENTIRE time");
  });

  it("writes nothing on conflict and names the holder", async () => {
    adapters.rms.findConflicts.mockResolvedValue([{
      category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 930, title: "Fall rally", holder: "Alan Chow", holderUserId: null, holderEmail: "alan@x",
    }]);
    client.users.lookupByEmail.mockResolvedValue({ user: { id: "UALAN" } });
    await h.handleCommand({ envelope: cmd(), client });
    expect(adapters.rms.book).not.toHaveBeenCalled();
    const [p] = posts();
    expect(p.text).toBe("❌ Tech Set 2 is taken Sat 10/17:\n• 2:00–3:30 PM · Tech Set 2 · Fall rally (<@UALAN>)\nPlease check with them.");
    expect(p.reply_broadcast).toBeUndefined();
    // Left open so "how about 5-7?" in the thread is answered.
    expect(p.metadata).toBeUndefined();
  });

  it("asks for missing details without closing the thread", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"] });
    await h.handleCommand({ envelope: cmd(), client });
    const [p] = posts();
    expect(p.text).toBe("Happy to book Tech Set 2. I still need: date, start and end time, what it's for.");
    expect(p.metadata).toBeUndefined();
  });

  it("asks which item when ambiguous", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "book", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
    await h.handleCommand({ envelope: cmd(), client });
    expect(posts()[0].text).toBe("Which one did you mean by \"a speaker\": Tech Set 2, MPR?");
  });

  it("says when it doesn't know an item", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Hologram"] });
    await h.handleCommand({ envelope: cmd(), client });
    expect(posts()[0].text).toMatch(/^I don't know "Hologram"\./);
    expect(posts()[0].text).toMatch(/vehicles/);
  });

  it("refuses to mix backends in one booking", async () => {
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Tech Set 2", "MPR"] });
    await h.handleCommand({ envelope: cmd(), client });
    expect(posts()[0].text).toMatch(/one request per kind/i);
    expect(adapters.rms.book).not.toHaveBeenCalled();
  });

  it("stays silent on chatter", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
    await h.handleCommand({ envelope: cmd({ text: "lol nice" }), client });
    expect(posts()).toEqual([]);
  });

  it("apologises when the model call fails", async () => {
    llm.parseReservationRequest.mockResolvedValue(null);
    await h.handleCommand({ envelope: cmd(), client });
    expect(posts()[0].text).toBe("Sorry, I couldn't read that. Please try again.");
  });

  it("reports a backend write failure with the direct link", async () => {
    adapters.rms.book.mockRejectedValue(new Error("403 forbidden"));
    await h.handleCommand({ envelope: cmd(), client });
    expect(posts()[0].text).toBe("⚠️ I couldn't save that booking (403 forbidden). Please book it directly: https://rms");
  });

  it("passes on an unavailable result", async () => {
    adapters.kitchen.book.mockResolvedValue({ status: "unavailable", reason: "The kitchen sheet is not open yet for that date.", link: "https://kitchen" });
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Kitchen"], appliances: { airFryer: true } });
    await h.handleCommand({ envelope: cmd(), client });
    expect(adapters.kitchen.book.mock.calls[0][0].appliances).toEqual({ airFryer: true });
    expect(posts()[0].text).toBe("The kitchen sheet is not open yet for that date. You can book it here: https://kitchen");
  });

  it("answers a check without booking", async () => {
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
    await h.handleCommand({ envelope: cmd(), client });
    expect(adapters.rms.book).not.toHaveBeenCalled();
    expect(posts()[0].text).toBe("Tech Set 2 is free Sat 10/17, 2:00–4:00 PM.");
  });

  it("lists across all backends when no item is named", async () => {
    llm.parseReservationRequest.mockResolvedValue({ intent: "list", date: "2026-10-17", toDate: "2026-10-18" });
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [{ category: "rooms", item: "MPR", date: "2026-10-17", start: 600, end: 720, title: "MBS", holder: "Arie", holderUserId: null, holderEmail: null }], errors: [] });
    await h.handleCommand({ envelope: cmd(), client });
    for (const a of Object.values(adapters)) expect(a.listReservations).toHaveBeenCalledWith({ from: "2026-10-17", to: "2026-10-18", items: [] });
    expect(posts()[0].text).toBe("*Sat 10/17*\n• 10:00 AM–12:00 PM · MPR · MBS (Arie)");
  });

  describe("thread replies", () => {
    const reply = msg({ text: "Saturday 2-4, youth night", ts: "100.5", thread_ts: "100.1" });

    it("ignores threads the bot is not part of", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [{ user: "U9", text: "hi", ts: "100.1" }, { user: "U8", text: "yo", ts: "100.5" }] });
      await h.handleMessage({ event: reply, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    });

    it("never acts again in a closed thread", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { user: "U9", text: "book tech set 2", ts: "100.1" },
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: "100.2", metadata: CLOSED_METADATA },
        { user: "U9", text: "also the MPR", ts: "100.5" },
      ] });
      await h.handleMessage({ event: { ...reply, text: "also the MPR" }, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe("Member: also the MPR");
      for (const a of Object.values(adapters)) expect(a.book).not.toHaveBeenCalled();
      expect(posts().map((p) => p.text)).toEqual(["That booking is done. Please start a new message for a new request."]);
    });

    it("stays silent on chatter in a closed thread", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { user: "U9", text: "book tech set 2", ts: "100.1" },
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: "100.2", metadata: CLOSED_METADATA },
        { user: "U9", text: "thanks!", ts: "100.5" },
      ] });
      llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
      await h.handleMessage({ event: { ...reply, text: "thanks!" }, client });
      expect(posts()).toEqual([]);
    });

    it("answers a follow-up after a conflict in the same thread", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { user: "U9", text: "book tech set 2 sat 2-4 youth night", ts: "100.1" },
        { bot_id: "B1", text: "❌ Tech Set 2 is taken Sat 10/17", ts: "100.2" },
        { user: "U9", text: "how about 5-7?", ts: "100.5" },
      ] });
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "17:00", end: "19:00" });
      await h.handleMessage({ event: { ...reply, text: "how about 5-7?" }, client });
      expect(adapters.rms.book.mock.calls[0][0]).toMatchObject({ start: 1020, end: 1140 });
    });

    it("parses the whole conversation when the bot asked a question", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { user: "U9", text: "book tech set 2", ts: "100.1" },
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: "100.2" },
        { user: "U9", text: "Saturday 2-4, youth night", ts: "100.5" },
      ] });
      await h.handleMessage({ event: reply, client });
      expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "CRES", ts: "100.1", limit: 50, include_all_metadata: true });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: Saturday 2-4, youth night"
      );
      expect(posts()[0].thread_ts).toBe("100.1");
    });
  });

  describe("review fixes", () => {
    it("a check naming items in two systems reads both", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check", items: ["MPR", "Tech Set 2"] });
      adapters.rms.findConflicts.mockResolvedValue([{ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 900, title: "Rally", holder: "Alan", holderUserId: null, holderEmail: null }]);
      await h.handleCommand({ envelope: cmd(), client });
      expect(adapters.rooms.findConflicts).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: "MPR" })] }));
      expect(adapters.rms.findConflicts).toHaveBeenCalledWith(expect.objectContaining({ items: [SET2] }));
      expect(posts()[0].text).toMatch(/^MPR, Tech Set 2 is taken Sat 10\/17:\n• 2:00–3:00 PM · Tech Set 2 · Rally \(Alan\)/);
    });

    it("asks instead of booking a small-hours time nobody said am for", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "02:00", end: "04:00" });
      await h.handleCommand({ envelope: cmd({ text: "book tech set 2 sat 2-4 for youth night" }), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(posts()[0].text).toBe("Happy to book Tech Set 2. I still need: start and end time.");
    });

    it("keeps a small-hours time the member wrote as am", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "05:00", end: "07:00" });
      await h.handleCommand({ envelope: cmd({ text: "book tech set 2 sat 5-7am for sunrise hike" }), client });
      expect(adapters.rms.book.mock.calls[0][0]).toMatchObject({ start: 300, end: 420 });
    });

    it("reads '7am' written right after the number", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "05:00", end: "07:00", title: "Breakfast prep" });
      await h.handleCommand({ envelope: cmd({ text: "book tech set 2 sat 5-7am breakfast prep" }), client });
      expect(adapters.rms.book.mock.calls[0][0]).toMatchObject({ start: 300, end: 420 });
    });

    it("refuses a date that has passed", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, date: "2026-10-01" });
      await h.handleCommand({ envelope: cmd(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(posts()[0].text).toBe("Thu 10/1 has already passed. Which date did you mean?");
    });

    it("never fails the event after a booking is written, so SQS can't book it twice", async () => {
      client.chat.postMessage.mockRejectedValue(new Error("ratelimited")).mockResolvedValueOnce({ ok: true, ts: "100.1" });
      await expect(h.handleCommand({ envelope: cmd(), client })).resolves.toBeUndefined();
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
    });
  });

  describe("/reserve", () => {
    it("posts the member's request to #reservations and answers in its thread", async () => {
      await h.handleCommand({ envelope: cmd(), client });
      const request = client.chat.postMessage.mock.calls[0][0];
      expect(request).toMatchObject({
        channel: "CRES", text: "📅 <@U9>: book tech set 2 sat 2-4 for youth night", username: "FH Reservations",
        metadata: { event_type: "reservation_request", event_payload: { user: "U9", text: "book tech set 2 sat 2-4 for youth night" } },
      });
      expect(request.thread_ts).toBeUndefined();
      expect(client.chat.getPermalink).toHaveBeenCalledWith({ channel: "CRES", message_ts: "100.1" });
      expect(posts()[0]).toMatchObject({ thread_ts: "100.1", reply_broadcast: true });
    });

    it("answers an empty /reserve privately with an example", async () => {
      await h.handleCommand({ envelope: cmd({ text: "  " }), client });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ channel: "CRES", user: "U9" });
      expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/\/reserve the MPR/);
    });

    it("from another channel, books in #reservations and says where", async () => {
      await h.handleCommand({ envelope: cmd({ channel_id: "COTHER" }), client });
      expect(client.chat.postMessage.mock.calls[0][0].channel).toBe("CRES");
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ channel: "COTHER", user: "U9", text: "Posted your request in <#CRES>." });
    });

    it("reads the request post as the member's words in a thread reply", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [
        { bot_id: "B1", text: "📅 <@U9>: book tech set 2", ts: "100.1", metadata: { event_type: "reservation_request", event_payload: { user: "U9", text: "book tech set 2" } } },
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: "100.2" },
        { user: "U9", text: "Saturday 2-4, youth night", ts: "100.5" },
      ] });
      await h.handleMessage({ event: msg({ text: "Saturday 2-4, youth night", ts: "100.5", thread_ts: "100.1" }), client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: Saturday 2-4, youth night"
      );
    });
  });

  describe("list periods (bug: 'this month' listed only today)", () => {
    // now = 2026-10-14 12:00 NY
    const R = (o) => ({ category: "tech", item: "Tech Set 2", start: 600, end: 660, title: "T", holder: "Alan", holderUserId: null, holderEmail: null, ...o });

    it("with items and no period, shows each item's next upcoming reservation", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"], date: null, toDate: null });
      adapters.rms.listReservations.mockResolvedValue({ reservations: [
        R({ date: "2026-10-14", start: 540, end: 600, title: "Over already" }),
        R({ date: "2026-11-02", start: 1080, end: 1200, title: "Later" }),
        R({ date: "2026-10-20", start: 1140, end: 1260, title: "Youth night" }),
      ], errors: [] });
      await h.handleCommand({ envelope: cmd({ text: "who has tech set 2" }), client });
      expect(adapters.rms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2027-04-12", items: [SET2] });
      expect(posts()[0].text).toBe("Next up for Tech Set 2, Tue 10/20:\n• 7:00–9:00 PM · Tech Set 2 · Youth night (Alan)");
    });

    it("counts a reservation still running today as upcoming", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"] });
      adapters.rms.listReservations.mockResolvedValue({ reservations: [R({ date: "2026-10-14", start: 660, end: 780, title: "Now" })], errors: [] });
      await h.handleCommand({ envelope: cmd({ text: "who has tech set 2" }), client });
      expect(posts()[0].text).toMatch(/^Next up for Tech Set 2, Wed 10\/14:/);
    });

    it("says when an item has no upcoming reservations", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"] });
      adapters.rms.listReservations.mockResolvedValue({ reservations: [R({ date: "2026-10-14", start: 540, end: 600 })], errors: [] });
      await h.handleCommand({ envelope: cmd({ text: "who has tech set 2" }), client });
      expect(posts()[0].text).toBe("No upcoming reservations for Tech Set 2.");
    });

    it("answers each named item on its own line group", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2", "MPR"] });
      adapters.rooms.listReservations.mockResolvedValue({ reservations: [R({ category: "rooms", item: "MPR", date: "2026-10-16", start: 1140, end: 1260, title: "Ignite", holder: "Virginia" })], errors: [] });
      await h.handleCommand({ envelope: cmd({ text: "who has tech set 2 and the mpr" }), client });
      expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2027-04-12", items: [expect.objectContaining({ label: "MPR" })] });
      expect(posts()[0].text).toBe("No upcoming reservations for Tech Set 2.\n\nNext up for MPR, Fri 10/16:\n• 7:00–9:00 PM · MPR · Ignite (Virginia)");
    });

    it("with no items and no period, lists the next 14 days", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list" });
      await h.handleCommand({ envelope: cmd({ text: "what's booked" }), client });
      expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2026-10-27", items: [] });
      expect(posts()[0].text).toBe("Nothing booked Wed 10/14 – Tue 10/27.");
    });

    it("names the items when a period has nothing booked", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"], date: "2026-10-17", toDate: "2026-10-18" });
      await h.handleCommand({ envelope: cmd({ text: "who has tech set 2 this weekend" }), client });
      expect(posts()[0].text).toBe("Nothing booked for Tech Set 2, Sat 10/17 – Sun 10/18.");
    });

    it("keeps a period the model resolved", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"], date: "2026-10-14", toDate: "2026-10-31" });
      await h.handleCommand({ envelope: cmd({ text: "who has tech set 2 this month" }), client });
      expect(adapters.rms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2026-10-31", items: [SET2] });
    });

    it("an empty list for everything says so without naming items", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", date: "2026-10-17", toDate: "2026-10-17" });
      await h.handleCommand({ envelope: cmd({ text: "what's booked saturday" }), client });
      expect(posts()[0].text).toBe("Nothing booked Sat 10/17.");
    });
  });
});

