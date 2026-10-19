// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA, REQUEST_EVENT_TYPE, ASK_EVENT_TYPE, NOTE_EVENT_TYPE } from "../../src/lib/reservation-format.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
const NOW = new Date("2026-10-14T16:00:00Z");
// A Slack ts `secAgo` seconds before NOW.
const ts = (secAgo) => `${NOW.getTime() / 1000 - secAgo}.000100`;

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
      // Posting to a user id lands in the DM; Slack answers with the DM id.
      postMessage: vi.fn().mockResolvedValue({ ok: true, channel: "D9", ts: ts(0) }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: "https://slack/p1" }),
    },
    conversations: {
      history: vi.fn().mockResolvedValue({ messages: [] }),
      open: vi.fn().mockResolvedValue({ ok: true, channel: { id: "D9" } }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555-0100" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

const BOOK = { intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" };
const cmd = (o = {}) => ({ type: "slash_command", command: "/reserve", user_id: "U9", channel_id: "D9", text: "book tech set 2 sat 2-4 for youth night", response_url: "https://hooks.slack/r", ...o });
const dm = (o = {}) => ({ type: "message", channel: "D9", channel_type: "im", user: "U9", text: "book tech set 2 sat 2-4 for youth night", ts: ts(0), ...o });
const marker = (text, secAgo) => ({
  bot_id: "B1", text: `📅 You asked: ${text}`, ts: ts(secAgo),
  metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: { user: "U9", text } },
});

describe("reservations handler", () => {
  let llm, adapters, client, livingDigest, h;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest });
  });
  const isMarker = (p) => p.metadata?.event_type === REQUEST_EVENT_TYPE;
  const markers = () => client.chat.postMessage.mock.calls.map((c) => c[0]).filter(isMarker);
  // The bot's answers, not its start markers.
  const posts = () => client.chat.postMessage.mock.calls.map((c) => c[0]).filter((p) => !isMarker(p));

  it("exposes its channel", () => {
    expect(h.channelId).toBe("CRES");
  });

  describe("/reserve", () => {
    it("/reserve posts the start marker to the member's DM", async () => {
      await h.handleCommand({ envelope: cmd(), client });
      const [request] = markers();
      expect(request).toMatchObject({
        channel: "D9", text: "📅 You asked: book tech set 2 sat 2-4 for youth night", username: "FH Reservations",
        metadata: { event_type: "reservation_request", event_payload: { user: "U9", text: "book tech set 2 sat 2-4 for youth night" } },
      });
      expect(request.thread_ts).toBeUndefined();
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("tells the member to look in their DM when run elsewhere", async () => {
      await h.handleCommand({ envelope: cmd({ channel_id: "CRES" }), client });
      expect(client.conversations.open).toHaveBeenCalledWith({ users: "U9" });
      expect(markers()[0].channel).toBe("D9");
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({
        channel: "CRES", user: "U9", text: "Continuing in your DM with me: <https://slack/p1|open DM>",
      });
      expect(client.chat.getPermalink).toHaveBeenCalledWith({ channel: "D9", message_ts: ts(0) });
      expect(posts()[0].channel).toBe("D9");
    });

    it("still points to the DM, without a link, when the permalink lookup fails", async () => {
      client.chat.getPermalink.mockRejectedValue(new Error("ratelimited"));
      await h.handleCommand({ envelope: cmd({ channel_id: "CRES" }), client });
      expect(client.chat.postEphemeral.mock.calls[0][0].text).toBe("Continuing in your DM with me (FH Maintenance, under Apps).");
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
    });

    it("answers an empty /reserve privately with an example", async () => {
      await h.handleCommand({ envelope: cmd({ channel_id: "CRES", text: "  " }), client });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ channel: "CRES", user: "U9" });
      expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/\/reserve the MPR/);
    });

    it("shows a find overview with category counts for an empty /reserve", async () => {
      await h.handleCommand({ envelope: cmd({ text: "" }), client });
      const text = client.chat.postEphemeral.mock.calls[0][0].text;
      expect(text).toMatch(/Rooms \(\d+\) · Kitchen \(1\) · Tech \(1\)/);
      expect(text).toMatch(/\/reserve what speakers/);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("tells the member privately when it can't open their DM", async () => {
      client.conversations.open.mockRejectedValue(new Error("An API error occurred: missing_scope"));
      await h.handleCommand({ envelope: cmd(), client });
      expect(client.chat.postEphemeral.mock.calls[0][0].text).toBe("I couldn't message you directly. Please open a DM with me and try again.");
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    });

    it("tells the member privately when it can't post to their DM", async () => {
      client.chat.postMessage.mockRejectedValue(new Error("cannot_dm_bot"));
      await expect(h.handleCommand({ envelope: cmd({ channel_id: "CRES" }), client })).resolves.toBeUndefined();
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({
        channel: "CRES", user: "U9", text: "I couldn't message you directly. Please open a DM with me and try again.",
      });
    });

    it("parses the request with today's date context", async () => {
      await h.handleCommand({ envelope: cmd(), client });
      expect(llm.parseReservationRequest).toHaveBeenCalledWith(
        "Member: book tech set 2 sat 2-4 for youth night",
        expect.objectContaining({ today: "2026-10-14", weekday: "Wednesday", catalogText: expect.stringContaining("Tech Set 2") })
      );
    });
  });

  describe("booking", () => {
    it("booking confirmation goes to the DM, closed, never to the channel", async () => {
      await h.handleCommand({ envelope: cmd({ channel_id: "CRES" }), client });
      expect(adapters.rms.book).toHaveBeenCalledWith({
        date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night", ministry: null,
        requesterName: "Deandra", requesterUserId: "U9", phone: "555-0100", appliances: {},
      });
      const [p] = posts();
      expect(p).toMatchObject({ channel: "D9", username: "FH Reservations", metadata: CLOSED_METADATA });
      expect(p.thread_ts).toBeUndefined();
      expect(p.reply_broadcast).toBeUndefined();
      expect(p.text).toContain("✅ Tech Set 2 · Sat 10/17 · 2:00–4:00 PM · Youth night · <@U9>");
      expect(p.text).toContain("ENTIRE time");
      expect(client.chat.postMessage.mock.calls.some((c) => c[0].channel === "CRES")).toBe(false);
    });

    it("refreshes the digest for the booked date", async () => {
      await h.handleCommand({ envelope: cmd(), client });
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
      expect(livingDigest.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(adapters.rms.book.mock.invocationCallOrder[0]);
    });

    it("digest refresh failure never fails the booking", async () => {
      livingDigest.refresh.mockRejectedValue(new Error("ratelimited"));
      await expect(h.handleCommand({ envelope: cmd(), client })).resolves.toBeUndefined();
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
      expect(posts()[0].text).toMatch(/^✅ Tech Set 2/);
    });

    it("never fails the event after a booking is written, so SQS can't book it twice", async () => {
      client.chat.postMessage.mockRejectedValue(new Error("ratelimited")).mockResolvedValueOnce({ ok: true, channel: "D9", ts: ts(0) });
      await expect(h.handleCommand({ envelope: cmd(), client })).resolves.toBeUndefined();
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
    });

    describe("booking claims", () => {
      let claimBooking;
      beforeEach(() => {
        claimBooking = vi.fn().mockResolvedValue(true);
        h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest, claimBooking });
      });

      it("claims a /reserve booking by its trigger before writing", async () => {
        await h.handleCommand({ envelope: cmd({ trigger_id: "T123" }), client });
        expect(claimBooking).toHaveBeenCalledWith("cmd:T123");
        expect(claimBooking.mock.invocationCallOrder[0]).toBeLessThan(adapters.rms.book.mock.invocationCallOrder[0]);
        expect(adapters.rms.book).toHaveBeenCalledTimes(1);
      });

      it("claims a DM booking by the message it answers", async () => {
        const event = dm({ text: "Saturday 2-4, youth night" });
        client.conversations.history.mockResolvedValue({ messages: [event,
          { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: ts(60) },
          marker("book tech set 2", 120)] });
        await h.handleMessage({ event, client });
        expect(claimBooking).toHaveBeenCalledWith(`dm:D9:${event.ts}`);
      });

      it("a retry of a booking already attempted writes nothing and says so", async () => {
        // The first delivery timed out after it started writing.
        claimBooking.mockResolvedValue(false);
        await h.handleCommand({ envelope: cmd({ trigger_id: "T123" }), client });
        expect(adapters.rms.book).not.toHaveBeenCalled();
        expect(posts()[0]).toMatchObject({
          text: expect.stringMatching(/^I may already have booked this\. Please check before booking again: /),
          metadata: expect.objectContaining({ event_type: CLOSED_METADATA.event_type }),
        });
      });

      it("books without a claim when the command carries no trigger", async () => {
        await h.handleCommand({ envelope: cmd(), client });
        expect(claimBooking).not.toHaveBeenCalled();
        expect(adapters.rms.book).toHaveBeenCalledTimes(1);
      });
    });

    it("books without a digest when reservations have none", async () => {
      h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW });
      await h.handleCommand({ envelope: cmd(), client });
      expect(posts()[0].text).toMatch(/^✅ Tech Set 2/);
    });

    it("writes nothing on conflict, names the holder and closes the request", async () => {
      adapters.rms.findConflicts.mockResolvedValue([{
        category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 930, title: "Fall rally", holder: "Alan Chow", holderUserId: null, holderEmail: "alan@x",
      }]);
      client.users.lookupByEmail.mockResolvedValue({ user: { id: "UALAN" } });
      await h.handleCommand({ envelope: cmd(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      const [p] = posts();
      expect(p.text).toBe("❌ Tech Set 2 is taken Sat 10/17:\n• 2:00–3:30 PM · Tech Set 2 · Fall rally (<@UALAN>)\nPlease check with them.");
      expect(p.metadata).toEqual(CLOSED_METADATA);
      expect(livingDigest.refresh).not.toHaveBeenCalled();
    });

    it("asks for missing details without closing the request", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"] });
      await h.handleCommand({ envelope: cmd(), client });
      const [p] = posts();
      expect(p).toMatchObject({ channel: "D9", text: "Happy to book Tech Set 2. I still need: date, start and end time, what it's for." });
      expect(p.metadata).toEqual({ event_type: ASK_EVENT_TYPE, event_payload: {} });
    });

    it("asks which item when ambiguous, leaving the request open", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
      await h.handleCommand({ envelope: cmd(), client });
      expect(posts()[0].text).toBe("Which one did you mean by \"a speaker\": Tech Set 2, MPR?");
      expect(posts()[0].metadata).toEqual({ event_type: ASK_EVENT_TYPE, event_payload: {} });
    });

    it("says when it doesn't know an item and closes the request", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Hologram"] });
      await h.handleCommand({ envelope: cmd(), client });
      expect(posts()[0].text).toMatch(/^I don't know "Hologram"\./);
      expect(posts()[0].text).toMatch(/vehicles/);
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
    });

    it("refuses to mix backends in one booking", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Tech Set 2", "MPR"] });
      await h.handleCommand({ envelope: cmd(), client });
      expect(posts()[0].text).toMatch(/one request per kind/i);
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
      expect(adapters.rms.book).not.toHaveBeenCalled();
    });

    it("stays silent on chatter", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
      await h.handleCommand({ envelope: cmd({ text: "lol nice" }), client });
      expect(posts()).toEqual([]);
    });

    it("apologises when the model call fails, leaving the request open", async () => {
      llm.parseReservationRequest.mockResolvedValue(null);
      await h.handleCommand({ envelope: cmd(), client });
      expect(posts()[0].text).toBe("Sorry, I couldn't read that. Please try again.");
      expect(posts()[0].metadata).toEqual({ event_type: ASK_EVENT_TYPE, event_payload: {} });
    });

    it("reports a backend write failure with the direct link", async () => {
      adapters.rms.book.mockRejectedValue(new Error("403 forbidden"));
      await h.handleCommand({ envelope: cmd(), client });
      expect(posts()[0].text).toBe("⚠️ I couldn't save that booking (403 forbidden). Please book it directly: https://rms");
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
    });

    it("passes on an unavailable result", async () => {
      adapters.kitchen.book.mockResolvedValue({ status: "unavailable", reason: "The kitchen sheet is not open yet for that date.", link: "https://kitchen" });
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Kitchen"], appliances: { airFryer: true } });
      await h.handleCommand({ envelope: cmd(), client });
      expect(adapters.kitchen.book.mock.calls[0][0].appliances).toEqual({ airFryer: true });
      expect(posts()[0].text).toBe("The kitchen sheet is not open yet for that date. You can book it here: https://kitchen");
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
    });

    it("answers a check without booking and closes the request", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
      await h.handleCommand({ envelope: cmd(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(posts()[0].text).toBe("Tech Set 2 is free Sat 10/17, 2:00–4:00 PM.");
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
    });

    it("lists across all backends when no item is named", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", date: "2026-10-17", toDate: "2026-10-18" });
      adapters.rooms.listReservations.mockResolvedValue({ reservations: [{ category: "rooms", item: "MPR", date: "2026-10-17", start: 600, end: 720, title: "MBS", holder: "Arie", holderUserId: null, holderEmail: null }], errors: [] });
      await h.handleCommand({ envelope: cmd(), client });
      for (const a of Object.values(adapters)) expect(a.listReservations).toHaveBeenCalledWith({ from: "2026-10-17", to: "2026-10-18", items: [] });
      expect(posts()[0].text).toBe("*Sat 10/17*\n• 10:00 AM–12:00 PM · MPR · MBS (Arie)");
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
    });
  });

  describe("DM messages", () => {
    const openHistory = [
      { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: ts(60) },
      marker("book tech set 2", 120),
    ];

    it("ignores #reservations threads", async () => {
      await h.handleMessage({ event: { type: "message", channel: "CRES", channel_type: "channel", user: "U9", text: "Saturday 2-4", ts: ts(0), thread_ts: ts(120) }, client });
      await h.handleMessage({ event: { type: "message", channel: "CRES", channel_type: "channel", user: "U9", text: "book the MPR", ts: ts(0) }, client });
      expect(client.conversations.history).not.toHaveBeenCalled();
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("ignores bot posts, edits and empty messages in the DM", async () => {
      await h.handleMessage({ event: dm({ bot_id: "B1" }), client });
      await h.handleMessage({ event: dm({ subtype: "message_changed" }), client });
      await h.handleMessage({ event: dm({ text: "  " }), client });
      expect(client.conversations.history).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("continues the open request", async () => {
      const event = dm({ text: "Saturday 2-4, youth night" });
      client.conversations.history.mockResolvedValue({ messages: [event, ...openHistory] });
      await h.handleMessage({ event, client });
      expect(client.conversations.history).toHaveBeenCalledWith({ channel: "D9", limit: 50, include_all_metadata: true });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: Saturday 2-4, youth night"
      );
      expect(markers()).toEqual([]);
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
      expect(posts()[0]).toMatchObject({ channel: "D9", metadata: CLOSED_METADATA });
      expect(posts()[0].thread_ts).toBeUndefined();
    });

    it("a thread reply in the DM continues the open request", async () => {
      // History holds only top-level messages, so the reply itself is missing.
      client.conversations.history.mockResolvedValue({ messages: openHistory });
      await h.handleMessage({ event: dm({ text: "Saturday 2-4, youth night", thread_ts: ts(60) }), client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: Saturday 2-4, youth night"
      );
      expect(posts()[0].channel).toBe("D9");
      expect(posts()[0].thread_ts).toBeUndefined();
    });

    it("chatter with nothing open is ignored", async () => {
      const event = dm({ text: "thanks!" });
      client.conversations.history.mockResolvedValue({ messages: [
        event,
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: ts(60), metadata: CLOSED_METADATA },
        marker("book tech set 2 sat 2-4", 120),
      ] });
      llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe("Member: thanks!");
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("a plain message with nothing open starts a request", async () => {
      const event = dm({ text: "also the MPR sat 2-4 for youth night" });
      client.conversations.history.mockResolvedValue({ messages: [
        event,
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: ts(60), metadata: CLOSED_METADATA },
        marker("book tech set 2 sat 2-4", 120),
      ] });
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe("Member: also the MPR sat 2-4 for youth night");
      expect(markers()[0]).toMatchObject({
        channel: "D9", text: "📅 You asked: also the MPR sat 2-4 for youth night",
        metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: { user: "U9", text: "also the MPR sat 2-4 for youth night" } },
      });
      expect(client.chat.postMessage.mock.invocationCallOrder[0]).toBeLessThan(adapters.rooms.book.mock.invocationCallOrder[0]);
      expect(adapters.rooms.book).toHaveBeenCalledTimes(1);
      expect(posts()[0].text).toMatch(/^✅ MPR/);
    });

    it("a request idle past the stale limit starts fresh", async () => {
      const event = dm({ text: "MPR sat 2-4 for youth night" });
      client.conversations.history.mockResolvedValue({ messages: [
        event,
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: ts(3 * 3600) },
        marker("book tech set 2", 3 * 3600 + 60),
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe("Member: MPR sat 2-4 for youth night");
      expect(markers()).toHaveLength(1);
    });

    it("escape closes the open request", async () => {
      const event = dm({ text: "Start over" });
      client.conversations.history.mockResolvedValue({ messages: [event, ...openHistory] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(posts()).toEqual([expect.objectContaining({ channel: "D9", text: "Okay, starting fresh.", metadata: { event_type: CLOSED_METADATA.event_type, event_payload: { reply_to: event.ts } } })]);
    });

    it("every reply names the message it answers", async () => {
      const event = dm({ text: "Saturday 2-4, youth night" });
      client.conversations.history.mockResolvedValue({ messages: [event, ...openHistory] });
      await h.handleMessage({ event, client });
      expect(posts()[0].metadata).toEqual({ event_type: CLOSED_METADATA.event_type, event_payload: { reply_to: event.ts } });
    });

    it("a question names the message it answers, leaving the request open", async () => {
      const event = dm({ text: "book tech set 2" });
      client.conversations.history.mockResolvedValue({ messages: [event] });
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"] });
      await h.handleMessage({ event, client });
      expect(posts()[0].metadata).toEqual({ event_type: ASK_EVENT_TYPE, event_payload: { reply_to: event.ts } });
      expect(markers()[0].metadata.event_payload.reply_to).toBe(event.ts);
    });

    it("a redelivered message the bot already closed is dropped", async () => {
      // SQS redelivers the member's answer after the bot booked and closed.
      const event = dm({ text: "Saturday 2-4, youth night", ts: ts(20) });
      client.conversations.history.mockResolvedValue({ messages: [
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: ts(10), metadata: { event_type: CLOSED_METADATA.event_type, event_payload: { reply_to: event.ts } } },
        event,
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: ts(30) },
        marker("book tech set 2", 40),
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("a redelivered message the bot already asked about is dropped", async () => {
      const event = dm({ text: "book tech set 2", ts: ts(20) });
      client.conversations.history.mockResolvedValue({ messages: [
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: ts(10), metadata: { event_type: ASK_EVENT_TYPE, event_payload: { reply_to: event.ts } } },
        marker("book tech set 2", 15),
        event,
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("a redelivery after only the start marker was posted carries on without a second marker", async () => {
      // The first delivery died between posting the marker and replying.
      const event = dm({ text: "MPR sat 2-4 for youth night", ts: ts(20) });
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"] });
      client.conversations.history.mockResolvedValue({ messages: [
        { ...marker("MPR sat 2-4 for youth night", 10), metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: { user: "U9", text: "MPR sat 2-4 for youth night", reply_to: ts(20) } } },
        event,
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe("Member: MPR sat 2-4 for youth night");
      expect(markers()).toEqual([]);
      expect(adapters.rooms.book).toHaveBeenCalledTimes(1);
    });

    it("a message handled after the bot's reply to an earlier one joins the open request", async () => {
      // Sent seconds after the first; the queue ran them in order, so the
      // bot's question to the first is newer than this message.
      const first = dm({ text: "book tech set 2", ts: ts(30) });
      const event = dm({ text: "saturday 2-4 for youth night", ts: ts(20) });
      client.conversations.history.mockResolvedValue({ messages: [
        { bot_id: "B1", text: "Happy to book Tech Set 2. I still need: date…", ts: ts(10), metadata: { event_type: ASK_EVENT_TYPE, event_payload: { reply_to: first.ts } } },
        { ...marker("book tech set 2", 15), metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: { user: "U9", text: "book tech set 2", reply_to: first.ts } } },
        event,
        first,
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: saturday 2-4 for youth night"
      );
      expect(markers()).toEqual([]);
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
    });

    it("leaves out the member's later messages that haven't had their turn", async () => {
      const event = dm({ text: "Saturday", ts: ts(20) });
      client.conversations.history.mockResolvedValue({ messages: [
        dm({ text: "2-4 for youth night", ts: ts(10) }),
        event,
        ...openHistory,
      ] });
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"], date: "2026-10-17" });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: Saturday"
      );
    });

    it("a message out of turn (a later one was already answered) is not merged; the member is asked to resend", async () => {
      // E failed, sat in the DLQ, and was redriven after the member moved on.
      const event = dm({ text: "book MPR sat 2-4 for youth night", ts: ts(300) });
      const later = dm({ text: "the van friday", ts: ts(200) });
      client.conversations.history.mockResolvedValue({ messages: [
        { bot_id: "B1", text: "Happy to book CP Transit. I still need: start and end time…", ts: ts(100), metadata: { event_type: ASK_EVENT_TYPE, event_payload: { reply_to: later.ts } } },
        { ...marker("the van friday", 150), metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: { user: "U9", text: "the van friday", reply_to: later.ts } } },
        later,
        event,
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(adapters.rooms.book).not.toHaveBeenCalled();
      expect(posts()).toEqual([expect.objectContaining({
        channel: "D9",
        text: 'Sorry, I missed your earlier message ("book MPR sat 2-4 for youth night"). Please send it again if you still need it.',
        metadata: { event_type: NOTE_EVENT_TYPE, event_payload: { reply_to: event.ts } },
      })]);
    });

    it("a resend note never enters the open request's transcript", async () => {
      const event = dm({ text: "5-7pm for outreach", ts: ts(10) });
      client.conversations.history.mockResolvedValue({ messages: [
        event,
        { bot_id: "B1", text: 'Sorry, I missed your earlier message ("book MPR sat 2-4"). Please send it again if you still need it.', ts: ts(50), metadata: { event_type: NOTE_EVENT_TYPE, event_payload: { reply_to: ts(300) } } },
        ...openHistory,
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe(
        "Member: book tech set 2\nBot: Happy to book Tech Set 2. I still need: date…\nMember: 5-7pm for outreach"
      );
    });

    it("a message handled after an earlier request closed starts its own", async () => {
      const first = dm({ text: "book tech set 2 sat 2-4 for youth night", ts: ts(30) });
      const event = dm({ text: "also the MPR sat 2-4 for youth night", ts: ts(20) });
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"] });
      client.conversations.history.mockResolvedValue({ messages: [
        { bot_id: "B1", text: "✅ Tech Set 2 …", ts: ts(10), metadata: { event_type: CLOSED_METADATA.event_type, event_payload: { reply_to: first.ts } } },
        marker("book tech set 2 sat 2-4 for youth night", 15),
        event,
        first,
      ] });
      await h.handleMessage({ event, client });
      expect(llm.parseReservationRequest.mock.calls[0][0]).toBe("Member: also the MPR sat 2-4 for youth night");
      expect(markers()).toHaveLength(1);
      expect(adapters.rooms.book).toHaveBeenCalledTimes(1);
    });

    it("an escape word with nothing open is ignored", async () => {
      client.conversations.history.mockResolvedValue({ messages: [] });
      await h.handleMessage({ event: dm({ text: "cancel" }), client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
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

    it("refuses a date that has passed and closes the request", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, date: "2026-10-01" });
      await h.handleCommand({ envelope: cmd(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(posts()[0].text).toBe("Thu 10/1 has already passed. Please send the request again with the right date.");
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
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
      expect(posts()[0].metadata).toEqual(CLOSED_METADATA);
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

describe("find intent", () => {
  const mk = (catalog, raw) => {
    const llm = { parseReservationRequest: vi.fn().mockResolvedValue(raw) };
    const client = makeClient();
    const h = createReservationsHandler({ llm, adapters: {}, catalog, channelId: "CRES", now: () => NOW });
    const answers = () => client.chat.postMessage.mock.calls.map((c) => c[0]).filter((p) => p.metadata?.event_type !== REQUEST_EVENT_TYPE);
    return { h, client, answers };
  };
  const run = (h, client) => h.handleCommand({ envelope: cmd({ text: "what speakers are there?" }), client });

  it("groups matches by category and says how to book, closing the request", async () => {
    const cat = [
      { label: "Tech Set 1", category: "tech", backend: "rms" }, { label: "Tech Set 2", category: "tech", backend: "rms" },
      { label: "MPR", category: "rooms", backend: "rooms" },
    ];
    const { h, client, answers } = mk(cat, { intent: "find", items: ["Tech Set 1", "MPR", "Tech Set 2"] });
    await run(h, client);
    const [a] = answers();
    expect(a.text).toContain("Rooms: MPR");
    expect(a.text).toContain("Tech: Tech Set 1, Tech Set 2");
    expect(a.text).toContain("/reserve <name> <day> <time> for <what>");
    expect(a.metadata).toEqual(CLOSED_METADATA);
  });

  it("caps at 25 and counts the rest", async () => {
    const cat = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i + 1}`, category: "tech", backend: "rms" }));
    const { h, client, answers } = mk(cat, { intent: "find", items: cat.map((c) => c.label) });
    await run(h, client);
    const text = answers()[0].text;
    expect(text).toContain("Item 25");
    expect(text).not.toContain("Item 26,");
    expect(text).not.toMatch(/Item 26(\b|$)/);
    expect(text).toContain("+5 more. Try a narrower word.");
  });

  it("lists only the matched items when some names are unknown", async () => {
    const { h, client, answers } = mk(CATALOG, { intent: "find", items: ["Tech Set 2", "Hologram"] });
    await run(h, client);
    const text = answers()[0].text;
    expect(text).toContain("Tech: Tech Set 2");
    expect(text).not.toContain("Hologram");
    expect(text).not.toMatch(/^Nothing matches/);
  });

  it("says nothing matches and shows what is available", async () => {
    const { h, client, answers } = mk(CATALOG, { intent: "find", items: [], unmatched: ["flamethrower"] });
    await run(h, client);
    const [a] = answers();
    expect(a.text).toMatch(/^Nothing matches/);
    expect(a.text).toMatch(/Kitchen \(1\) · Tech \(1\)/);
    expect(a.metadata).toEqual(CLOSED_METADATA);
  });
});
