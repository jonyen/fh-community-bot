// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler, WELCOME_TEXT, WELCOME_TTL_S, NUDGE_TTL_S, nudgeText } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";
import { EDIT_ACTION, CANCEL_ACTION, CANCEL_BOOKING_ACTION, cardMessage, decodeCard, decodeRef, encodeRef, bookedMessage } from "../../src/lib/reservation-card.js";
import { normalizeRequest } from "../../src/lib/reservation-request.js";
import { MINE_CANCEL_ACTION, MINE_SERIES_ACTION } from "../../src/lib/reservation-mine.js";
import { log } from "../../src/lib/logger.js";
import { buildEditModal, ITEM_ACTION } from "../../src/lib/reservation-modal.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
const NOW = new Date("2026-10-14T16:00:00Z");
const MSG_TS = "200.1";
const CARD_TS = "200.2";

function makeAdapter(backend) {
  return {
    backend,
    link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn().mockResolvedValue({ status: "booked", link: `https://${backend}/item` }),
    cancel: vi.fn().mockResolvedValue({ status: "cancelled", link: `https://${backend}/item` }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, channel: "CRES", ts: CARD_TS }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555-0100" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

const BOOK = { intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" };
const msg = (o = {}) => ({ type: "message", channel: "CRES", channel_type: "channel", user: "U9", text: "book tech set 2 sat 2-4 for youth night", ts: MSG_TS, ...o });
const TAKEN = { category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 930, title: "Fall rally", holder: "Alan Chow", holderUserId: null, holderEmail: "alan@x" };

// A public card posted in a thread before requests moved to /reserve, as the
// handler's assess and cardMessage drew it. Its buttons still work.
const existingCard = (raw = BOOK, assessment = { state: "free" }) => cardMessage({ user: "U9", req: normalizeRequest(raw, CATALOG), assessment });

// The Task 6 contract: version 0 means "no tray yet"; a stale version loses.
function makeTrayStore() {
  const rows = new Map();
  return {
    rows,
    getTray: vi.fn(async (u) => (rows.has(u) ? structuredClone(rows.get(u)) : null)),
    putTray: vi.fn(async (u, tray, { expectVersion }) => {
      if ((rows.get(u)?.version ?? 0) !== expectVersion) return false;
      rows.set(u, structuredClone({ ...tray, version: expectVersion + 1 }));
      return true;
    }),
    deleteTray: vi.fn(async (u) => rows.delete(u)),
  };
}

const sectionText = (m) => m.blocks.filter((b) => b.type === "section").map((b) => b.text.text).join("\n");
const buttons = (m) => m.blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements);

describe("reservations handler", () => {
  let llm, adapters, client, livingDigest, h;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest });
  });
  const updates = () => client.chat.update.mock.calls.map((c) => c[0]);

  it("exposes its channel", () => {
    expect(h.channelId).toBe("CRES");
  });

  describe("channel messages", () => {
    it("parses the message with today's date context", async () => {
      await h.handleMessage({ event: msg(), client });
      expect(llm.parseReservationRequest).toHaveBeenCalledWith(
        "Member: book tech set 2 sat 2-4 for youth night",
        expect.objectContaining({ today: "2026-10-14", weekday: "Wednesday", catalogText: expect.stringContaining("Tech Set 2") })
      );
    });

    it("ignores other channels, thread replies, bots, edits and empty messages", async () => {
      for (const event of [msg({ channel: "COTHER" }), msg({ thread_ts: "1.0" }), msg({ bot_id: "B1" }), msg({ subtype: "message_changed" }), msg({ text: "  " })]) {
        await h.handleMessage({ event, client });
      }
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("drops obvious chatter before calling the model", async () => {
      for (const text of ["thanks!", "Thank you :pray:", "ok", "👍", "<@U5> lol"]) await h.handleMessage({ event: msg({ text }), client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    });

    it("stays silent when the model says it's chatter, or can't read it", async () => {
      llm.parseReservationRequest.mockResolvedValueOnce({ intent: "other" }).mockResolvedValueOnce(null);
      await h.handleMessage({ event: msg({ text: "see you all there" }), client });
      await h.handleMessage({ event: msg({ ts: "300.1", text: "see you all there" }), client });
      expect(llm.parseReservationRequest).toHaveBeenCalledTimes(2);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("reads a request posted with an attachment", async () => {
      await h.handleMessage({ event: msg({ subtype: "file_share" }), client });
      expect(llm.parseReservationRequest).toHaveBeenCalled();
    });
  });

  describe("a request posted in the channel gets a private nudge to /reserve", () => {
    const ephemerals = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);

    it("nudges a booking request privately, with the request as a /reserve example, and books nothing", async () => {
      await h.handleMessage({ event: msg(), client });
      expect(ephemerals()).toEqual([{ channel: "CRES", user: "U9", text: nudgeText("book tech set 2 sat 2-4 for youth night"), username: "Reservations", icon_emoji: ":calendar:" }]);
      expect(ephemerals()[0].text).toContain("`/reserve book tech set 2 sat 2-4 for youth night`");
      expect(ephemerals()[0].thread_ts).toBeUndefined();
      for (const a of Object.values(adapters)) {
        expect(a.findConflicts).not.toHaveBeenCalled();
        expect(a.book).not.toHaveBeenCalled();
      }
    });

    it("nudges a question too, without answering it", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
      await h.handleMessage({ event: msg({ text: "is tech set 2 free sat 2-4" }), client });
      expect(ephemerals()).toEqual([expect.objectContaining({ channel: "CRES", user: "U9", text: nudgeText("is tech set 2 free sat 2-4") })]);
      expect(adapters.rms.findConflicts).not.toHaveBeenCalled();
    });

    it("posts nothing in the thread and doesn't read it", async () => {
      for (const raw of [BOOK, { ...BOOK, intent: "check" }, { intent: "mine" }, { intent: "book", items: ["Hologram"] }]) {
        llm.parseReservationRequest.mockResolvedValueOnce(raw);
        await h.handleMessage({ event: msg(), client });
      }
      expect(ephemerals()).toHaveLength(4);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.conversations.replies).not.toHaveBeenCalled();
    });

    it("nudges once per message, however often SQS delivers it", async () => {
      const claimed = new Set();
      const claimOnce = vi.fn(async (key) => (claimed.has(key) ? false : (claimed.add(key), true)));
      h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, claimOnce });
      await h.handleMessage({ event: msg(), client });
      await h.handleMessage({ event: msg(), client });
      expect(ephemerals()).toHaveLength(1);
      expect(claimOnce).toHaveBeenCalledWith(`nudge:CRES:${MSG_TS}`, NUDGE_TTL_S);
      // Another message from the same member is nudged again.
      await h.handleMessage({ event: msg({ ts: "300.1" }), client });
      expect(ephemerals()).toHaveLength(2);
    });

    it("doesn't claim a message that gets no nudge", async () => {
      const claimOnce = vi.fn().mockResolvedValue(true);
      h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, claimOnce });
      llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
      await h.handleMessage({ event: msg({ text: "see you all there" }), client });
      await h.handleMessage({ event: msg({ text: "thanks!" }), client });
      expect(claimOnce).not.toHaveBeenCalled();
    });

    it("the example is the request on one line, without backticks, cut to fit", () => {
      expect(nudgeText("tech set 2\nsat `2-4`")).toMatch(/\n`\/reserve tech set 2 sat 2-4`$/);
      const long = nudgeText("x".repeat(400));
      expect(long).toMatch(/\n`\/reserve x+…`$/);
      expect(long.length).toBeLessThan(400);
    });
  });

  describe("Book", () => {
    let card;
    beforeEach(() => {
      card = existingCard(BOOK, { state: "free", adapter: adapters.rms });
      // The card as Slack holds it now.
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS, user: "U9" }, { ts: CARD_TS, bot_id: "B1", blocks: card.blocks }] });
    });
    const press = (o = {}) => ({
      type: "block_actions",
      user: { id: "U9" },
      channel: { id: "CRES" },
      container: { type: "message", message_ts: CARD_TS, channel_id: "CRES" },
      message: { ts: CARD_TS, thread_ts: MSG_TS, blocks: card.blocks },
      actions: [buttons(card)[0]],
      ...o,
    });

    it("books once and replaces the card with the confirmation", async () => {
      await h.handleCardAction({ payload: press(), client });
      expect(adapters.rms.book).toHaveBeenCalledWith({
        date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night", ministry: null,
        requesterName: "Deandra", requesterUserId: "U9", phone: "555-0100", appliances: {},
      });
      const [u] = updates();
      expect(u).toMatchObject({ channel: "CRES", ts: CARD_TS, metadata: CLOSED_METADATA });
      expect(u.text).toContain("✅ Tech Set 2 · Sat 10/17 · 2:00–4:00 PM · Youth night · <@U9>");
      expect(u.text).toContain("ENTIRE time");
      expect(u.blocks.some((b) => b.type === "actions")).toBe(false);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
    });

    it("a second press on a card already booked does nothing", async () => {
      await h.handleCardAction({ payload: press(), client });
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS }, { ts: CARD_TS, bot_id: "B1", blocks: updates()[0].blocks }] });
      await h.handleCardAction({ payload: press(), client });
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
      expect(updates()).toHaveLength(1);
    });

    it("a press on a card since edited does nothing", async () => {
      const edited = { ...card, blocks: card.blocks.map((b) => (b.type === "actions" ? { ...b, elements: b.elements.map((e) => ({ ...e, value: e.value.replace("Youth night", "Prayer") })) } : b)) };
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS }, { ts: CARD_TS, bot_id: "B1", blocks: edited.blocks }] });
      await h.handleCardAction({ payload: press(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
    });

    it("someone else pressing Book or Edit is told privately and nothing happens", async () => {
      await h.handleCardAction({ payload: press({ user: { id: "U7" } }), client });
      await h.handleCardAction({ payload: press({ user: { id: "U7" }, actions: [buttons(card)[1]] }), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls.map((c) => c[0])).toEqual([
        expect.objectContaining({ channel: "CRES", user: "U7", thread_ts: MSG_TS, text: "Only <@U9> can book this." }),
        expect.objectContaining({ user: "U7", text: "Only <@U9> can book this." }),
      ]);
    });

    it("the requester's Edit press is left to the receiver", async () => {
      await h.handleCardAction({ payload: press({ actions: [buttons(card)[1]] }), client });
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("ignores other buttons", async () => {
      await h.handleCardAction({ payload: press({ actions: [{ action_id: "maintenance_submit", value: "x" }] }), client });
      expect(client.conversations.replies).not.toHaveBeenCalled();
      expect(adapters.rms.book).not.toHaveBeenCalled();
    });

    it("refuses to book an item the catalog no longer has, instead of booking the rest", async () => {
      const gone = buttons(card)[0].value.replace('"Tech Set 2"', '"Tech Set 2","Old Set"');
      const blocks = card.blocks.map((b) => (b.type === "actions" ? { ...b, elements: b.elements.map((e) => ({ ...e, value: gone })) } : b));
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: CARD_TS, bot_id: "B1", blocks }] });
      await h.handleCardAction({ payload: press({ actions: [{ ...buttons(card)[0], value: gone }] }), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(updates()[0]).toMatchObject({ text: 'I can\'t book "Old Set" any more. Please post the request again.', metadata: CLOSED_METADATA });
    });

    it("a slot taken since the card was posted turns the card to taken and writes nothing", async () => {
      adapters.rms.findConflicts.mockResolvedValue([TAKEN]);
      await h.handleCardAction({ payload: press(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      const [u] = updates();
      expect(sectionText(u)).toContain("❌ Taken:");
      expect(buttons(u).map((b) => b.action_id)).toEqual([EDIT_ACTION, CANCEL_ACTION]);
    });

    it("reports a backend write failure with the direct link", async () => {
      adapters.rms.book.mockRejectedValue(new Error("403 forbidden"));
      await h.handleCardAction({ payload: press(), client });
      expect(updates()[0]).toMatchObject({ text: "⚠️ I couldn't save that booking (403 forbidden). Please book it directly: https://rms", metadata: CLOSED_METADATA });
    });

    it("passes on an unavailable result", async () => {
      adapters.rms.book.mockResolvedValue({ status: "unavailable", reason: "Not open yet.", link: "https://rms/x" });
      await h.handleCardAction({ payload: press(), client });
      expect(updates()[0].text).toBe("Not open yet. You can book it here: https://rms/x");
    });

    it("never fails the event after a booking is written, so SQS can't book it twice", async () => {
      client.chat.update.mockRejectedValue(new Error("ratelimited"));
      livingDigest.refresh.mockRejectedValue(new Error("ratelimited"));
      await expect(h.handleCardAction({ payload: press(), client })).resolves.toBeUndefined();
      expect(adapters.rms.book).toHaveBeenCalledTimes(1);
    });

    describe("booking claims", () => {
      let claimBooking;
      beforeEach(() => {
        claimBooking = vi.fn().mockResolvedValue(true);
        h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest, claimBooking });
      });

      it("claims the card before writing", async () => {
        await h.handleCardAction({ payload: press(), client });
        expect(claimBooking).toHaveBeenCalledWith(`card:CRES:${CARD_TS}`);
        expect(claimBooking.mock.invocationCallOrder[0]).toBeLessThan(adapters.rms.book.mock.invocationCallOrder[0]);
      });

      it("a retry of a booking already attempted writes nothing and says so", async () => {
        claimBooking.mockResolvedValue(false);
        await h.handleCardAction({ payload: press(), client });
        expect(adapters.rms.book).not.toHaveBeenCalled();
        expect(updates()[0].text).toMatch(/^I may already have booked this\. Please check before booking again: /);
      });
    });

    it("passes kitchen appliances through to the booking", async () => {
      const kitchen = existingCard({ ...BOOK, items: ["Kitchen"], appliances: { airFryer: true } }, { state: "free", adapter: adapters.kitchen });
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: CARD_TS, bot_id: "B1", blocks: kitchen.blocks }] });
      await h.handleCardAction({ payload: press({ actions: [buttons(kitchen)[0]] }), client });
      expect(adapters.kitchen.book.mock.calls[0][0].appliances).toEqual({ airFryer: true });
    });
  });

  describe("Cancel on an open card", () => {
    let card;
    beforeEach(() => {
      card = existingCard(BOOK, { state: "free", adapter: adapters.rms });
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS, user: "U9" }, { ts: CARD_TS, bot_id: "B1", blocks: card.blocks }] });
    });
    const cancelButton = () => buttons(card).find((b) => b.action_id === CANCEL_ACTION);
    const press = (o = {}) => ({
      type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
      container: { type: "message", message_ts: CARD_TS, channel_id: "CRES" },
      message: { ts: CARD_TS, thread_ts: MSG_TS, blocks: card.blocks },
      actions: [cancelButton()], ...o,
    });

    it("Cancel on an open card closes it with 🚫 Cancelled by <@U9>.", async () => {
      await h.handleCardAction({ payload: press(), client });
      expect(updates()).toEqual([{ channel: "CRES", ts: CARD_TS, text: "🚫 Cancelled by <@U9>.", blocks: [{ type: "section", text: { type: "mrkdwn", text: "🚫 Cancelled by <@U9>." } }], metadata: CLOSED_METADATA }]);
      for (const a of Object.values(adapters)) {
        expect(a.book).not.toHaveBeenCalled();
        expect(a.cancel).not.toHaveBeenCalled();
      }
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
      expect(livingDigest.refresh).not.toHaveBeenCalled();
    });

    it("Cancel by someone else is answered privately", async () => {
      await h.handleCardAction({ payload: press({ user: { id: "U7" } }), client });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ channel: "CRES", user: "U7", thread_ts: MSG_TS, text: "Only <@U9> can cancel this.", username: "Reservations" });
    });

    it("Cancel on an already closed card does nothing", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: CARD_TS, bot_id: "B1", blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ done" } }] }] });
      await h.handleCardAction({ payload: press(), client });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });
  });

  describe("Cancel booking", () => {
    // now = 2026-10-14 12:00 NY
    const REF = { backend: "rms", eventId: "ev1", organizerEmail: null, organizerSelf: true, resources: ["t2"], date: "2026-10-17", start: 840, end: 960, title: "Youth night — Deandra" };
    const SUMMARY = "✅ Tech Set 2 · Sat 10/17 · 2:00–4:00 PM · Youth night · <@U9>";
    const REQ = { items: [SET2], date: "2026-10-17", start: 840, end: 960, title: "Youth night" };
    let ledger, booked;
    const showCard = (m) => client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS, user: "U9" }, { ts: CARD_TS, bot_id: "B1", blocks: m.blocks }] });
    const bookedCard = (ref = REF) => bookedMessage({ user: "U9", text: `${SUMMARY}\n<https://rms/item|Open the booking>`, ref, req: REQ });
    // An open card for the request, as Slack holds it.
    const postCard = async () => {
      const card = existingCard(BOOK, { state: "free", adapter: adapters.rms });
      showCard(card);
      return card;
    };
    const press = (m, o = {}) => ({
      type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
      container: { type: "message", message_ts: CARD_TS, channel_id: "CRES" },
      message: { ts: CARD_TS, thread_ts: MSG_TS, blocks: m.blocks },
      actions: [buttons(m)[0]], ...o,
    });
    beforeEach(() => {
      ledger = { recordBooking: vi.fn().mockResolvedValue(), bookingsFor: vi.fn().mockResolvedValue([]) };
      h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest, ledger });
      booked = bookedCard();
      showCard(booked);
    });

    it("a booking ends with a Cancel booking button and records the ref in the ledger", async () => {
      adapters.rms.book.mockResolvedValue({ status: "booked", link: "https://rms/item", ref: REF });
      const card = await postCard();
      await h.handleCardAction({ payload: press(card), client });
      const [u] = updates();
      expect(u).toMatchObject({ channel: "CRES", ts: CARD_TS, metadata: CLOSED_METADATA });
      expect(u.text.startsWith(`${SUMMARY}\n<https://rms/item|Open the booking>\n`)).toBe(true);
      expect(u.text).toContain("ENTIRE time");
      expect(buttons(u).map((b) => b.action_id)).toEqual([CANCEL_BOOKING_ACTION]);
      expect(decodeRef(buttons(u)[0].value)).toEqual({ user: "U9", ref: REF });
      expect(buttons(u)[0].confirm.text.text).toBe("Tech Set 2 · Sat 10/17 · 2:00–4:00 PM will be released.");
      expect(ledger.recordBooking).toHaveBeenCalledWith("U9", REF, { today: "2026-10-14" });
    });

    it("a failed ledger write is logged, never rethrown", async () => {
      adapters.rms.book.mockResolvedValue({ status: "booked", link: "https://rms/item", ref: REF });
      ledger.recordBooking.mockRejectedValue(new Error("ddb down"));
      const spy = vi.spyOn(log, "error").mockImplementation(() => {});
      const card = await postCard();
      await expect(h.handleCardAction({ payload: press(card), client })).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith("booking ledger write failed", expect.objectContaining({ backend: "rms" }));
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
      spy.mockRestore();
    });

    it("a booking without a ref still closes with no buttons and records nothing", async () => {
      const card = await postCard();
      await h.handleCardAction({ payload: press(card), client });
      expect(buttons(updates()[0])).toEqual([]);
      expect(ledger.recordBooking).not.toHaveBeenCalled();
    });

    it("Cancel booking cancels, keeps the summary, adds 🚫 Booking cancelled by <@U9>. and refreshes the digest", async () => {
      await h.handleCardAction({ payload: press(booked), client });
      expect(adapters.rms.cancel.mock.calls).toEqual([[REF]]);
      const [u] = updates();
      expect(u).toMatchObject({ channel: "CRES", ts: CARD_TS, metadata: CLOSED_METADATA, text: `${SUMMARY}\n🚫 Booking cancelled by <@U9>.` });
      expect(buttons(u)).toEqual([]);
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-17");
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("Cancel booking by someone else is answered privately", async () => {
      await h.handleCardAction({ payload: press(booked, { user: { id: "U7" } }), client });
      expect(adapters.rms.cancel).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ user: "U7", thread_ts: MSG_TS, text: "Only <@U9> can cancel this." });
    });

    it("Cancel booking after the end time answers That booking has already ended. privately", async () => {
      for (const ref of [{ ...REF, date: "2026-10-14", start: 540, end: 600 }, { ...REF, date: "2026-10-13" }]) {
        const m = bookedCard(ref);
        showCard(m);
        await h.handleCardAction({ payload: press(m), client });
      }
      expect(adapters.rms.cancel).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls.map((c) => c[0])).toEqual([
        expect.objectContaining({ user: "U9", thread_ts: MSG_TS, text: "That booking has already ended." }),
        expect.objectContaining({ user: "U9", text: "That booking has already ended." }),
      ]);
    });

    it("a booking today with no end time has not ended", async () => {
      const m = bookedCard({ ...REF, date: "2026-10-14", start: 540, end: null });
      showCard(m);
      await h.handleCardAction({ payload: press(m), client });
      expect(adapters.rms.cancel).toHaveBeenCalledTimes(1);
    });

    it("a redelivered Cancel booking says That booking was already cancelled.", async () => {
      adapters.rms.cancel.mockResolvedValue({ status: "already", link: "https://rms/item" });
      await h.handleCardAction({ payload: press(booked), client });
      expect(updates()[0]).toMatchObject({ ts: CARD_TS, metadata: CLOSED_METADATA, text: `${SUMMARY}\nThat booking was already cancelled.` });
      expect(livingDigest.refresh).not.toHaveBeenCalled();
    });

    it("a press on a card already cancelled does nothing", async () => {
      await h.handleCardAction({ payload: press(booked), client });
      showCard(updates()[0]);
      await h.handleCardAction({ payload: press(booked), client });
      expect(adapters.rms.cancel).toHaveBeenCalledTimes(1);
      expect(updates()).toHaveLength(1);
    });

    it("changed booking: nothing cancelled, link given", async () => {
      adapters.rms.cancel.mockResolvedValue({ status: "changed", link: "https://rms/x" });
      await h.handleCardAction({ payload: press(booked), client });
      expect(updates()[0].text).toBe(`${SUMMARY}\nI couldn't find that booking as it was; it may have been changed. Please check it here: https://rms/x`);
      expect(livingDigest.refresh).not.toHaveBeenCalled();
    });

    it("an unexpected failure keeps the booked card and answers privately", async () => {
      adapters.rms.cancel.mockRejectedValue(new Error("backendError"));
      const spy = vi.spyOn(log, "error").mockImplementation(() => {});
      await h.handleCardAction({ payload: press(booked), client });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({
        channel: "CRES", user: "U9", thread_ts: MSG_TS,
        text: "⚠️ I couldn't cancel that (backendError). Please try again, or cancel it here: https://rms",
      });
      spy.mockRestore();
    });

    it("a calendar event someone else organized can't be cancelled without connect", async () => {
      const m = bookedCard({ ...REF, organizerSelf: false, organizerEmail: "deandra@x" });
      showCard(m);
      await h.handleCardAction({ payload: press(m), client });
      expect(adapters.rms.cancel).not.toHaveBeenCalled();
      expect(updates()[0].text).toBe(`${SUMMARY}\nI can't cancel that one from here. Please cancel it in Google Calendar: https://rms`);
    });

    it("ignores a ref for a backend it has no adapter for, and garbage values", async () => {
      delete adapters.kitchen;
      const m = bookedCard({ backend: "kitchen", row: 5, date: "2026-10-17", name: "D", start: 600, end: 700 });
      showCard(m);
      await h.handleCardAction({ payload: press(m), client });
      await h.handleCardAction({ payload: press(booked, { actions: [{ action_id: CANCEL_BOOKING_ACTION, value: "{nope" }] }), client });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
      expect(adapters.rms.cancel).not.toHaveBeenCalled();
    });

    it("a press whose value no longer matches the card does nothing", async () => {
      showCard(bookedCard({ ...REF, eventId: "ev2" }));
      await h.handleCardAction({ payload: press(booked), client });
      expect(adapters.rms.cancel).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });
  });

  describe("Edit modal submit", () => {
    let card;
    beforeEach(() => {
      card = existingCard(BOOK, { state: "free", adapter: adapters.rms });
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS }, { ts: CARD_TS, bot_id: "B1", blocks: card.blocks }] });
    });
    const submit = (o = {}) => {
      const view = buildEditModal({ user: "U9", channel: "CRES", threadTs: MSG_TS, cardTs: CARD_TS, req: decodeCard(buttons(card)[0].value, CATALOG).req });
      view.state = { values: {
        items: { [ITEM_ACTION]: { selected_options: [{ value: "Tech Set 2" }] } },
        date: { date: { selected_date: "2026-10-18" } },
        start: { start: { selected_time: "18:00" } },
        end: { end: { selected_time: "20:00" } },
        title: { title: { value: "Prayer night" } },
      } };
      return { type: "view_submission", user: { id: "U9" }, view, ...o };
    };

    it("updates the card with the new details and writes nothing", async () => {
      await h.handleModalSubmit({ payload: submit(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      const [u] = updates();
      expect(u).toMatchObject({ channel: "CRES", ts: CARD_TS });
      expect(sectionText(u)).toBe("📅 *Tech Set 2* · Sun 10/18 · 6:00–8:00 PM · Prayer night\n✅ Free");
      expect(decodeCard(buttons(u)[0].value, CATALOG).req.title).toBe("Prayer night");
    });

    it("says so when the card is already finished", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: CARD_TS, bot_id: "B1", blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ done" } }] }] });
      await h.handleModalSubmit({ payload: submit(), client });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ user: "U9", text: "That request is already finished. Use `/reserve` to book again." });
    });

    it("ignores other modals and other users", async () => {
      await h.handleModalSubmit({ payload: submit({ user: { id: "U7" } }), client });
      const other = submit();
      other.view.callback_id = "something_else";
      await h.handleModalSubmit({ payload: other, client });
      expect(client.chat.update).not.toHaveBeenCalled();
    });
  });

  describe("/reserve answers privately", () => {
    const command = (text, channel = "CRES") => h.handleCommand({ userId: "U1", channel, text, client, responseUrl: "https://r" });
    const ephemerals = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);

    it("answers a check to the asker alone, with nothing posted in the channel", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
      await command("is tech set 2 free sat 2-4");
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(ephemerals()[0]).toMatchObject({ channel: "CRES", user: "U1", text: "Tech Set 2 is free Sat 10/17, 2:00–4:00 PM." });
      expect(ephemerals()[0].thread_ts).toBeUndefined();
    });

    it("with no text, or asking what can be reserved, shows the list privately", async () => {
      await command("  ");
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      llm.parseReservationRequest.mockResolvedValue({ intent: "browse", search: null });
      await command("what can i reserve");
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(ephemerals()).toHaveLength(2);
      for (const m of ephemerals()) expect(m).toMatchObject({ channel: "CRES", user: "U1", username: "Reservations" });
    });

    it("something that is not a reservation question gets examples instead of silence", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
      await command("hello");
      expect(ephemerals()[0]).toMatchObject({ channel: "CRES", user: "U1" });
      expect(ephemerals()[0].text).toMatch(/^Book or ask with \/reserve, for example `\/reserve Tech Set 2 Sat 2-4pm for youth night`, `\/reserve what are my reservations`/);
    });

    it("apologises privately when the model call fails", async () => {
      llm.parseReservationRequest.mockResolvedValue(null);
      await command("tech set 2 sat 2-4 youth night");
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(ephemerals()).toEqual([expect.objectContaining({ channel: "CRES", user: "U1", text: "Sorry, I couldn't read that. Please try again.", username: "Reservations" })]);
    });

    it("says when it doesn't know an item", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Hologram"] });
      await command("book the hologram sat 2-4");
      expect(ephemerals()[0].text).toMatch(/^I don't know "Hologram"\./);
      expect(ephemerals()[0].text).toMatch(/vehicles/);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("asks which item when a booking request is ambiguous", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
      await command("book a speaker sat 2-4");
      expect(ephemerals()).toEqual([expect.objectContaining({ user: "U1", text: 'Which one did you mean by "a speaker": Tech Set 2, MPR? Ask again with its name.' })]);
    });

    it("a booking request that names nothing asks what to book", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" });
      await command("book something sat 2-4");
      expect(ephemerals()).toEqual([expect.objectContaining({ user: "U1", text: expect.stringMatching(/^What would you like to book\? For example `\/reserve Tech Set 2 Sat 2-4pm for youth night`/) })]);
      expect(adapters.rms.book).not.toHaveBeenCalled();
    });

    it("without a tray table, a booking request shows the plain listing", async () => {
      await command("tech set 2 sat 2-4 youth night");
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(ephemerals()).toEqual([expect.objectContaining({ channel: "CRES", user: "U1", username: "Reservations" })]);
      expect(ephemerals()[0].blocks).toBeUndefined();
    });

    describe("a booking request goes into the tray", () => {
      let trayStore;
      beforeEach(() => {
        trayStore = makeTrayStore();
        h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest, trayStore });
      });
      const stored = () => trayStore.rows.get("U1");

      it("adds it to the member's tray and shows the private listing card; nothing is booked", async () => {
        await command("tech set 2 sat 2-4 youth night");
        expect(stored().lines).toEqual([expect.objectContaining({ item: "Tech Set 2", date: "2026-10-17", start: 840, end: 960, title: "Youth night", appliances: {} })]);
        expect(client.chat.postMessage).not.toHaveBeenCalled();
        const [m] = ephemerals();
        expect(m).toMatchObject({ channel: "CRES", user: "U1", username: "Reservations" });
        expect(m.thread_ts).toBeUndefined();
        expect(sectionText(m).split("\n")[0]).toBe("Added to your tray. Check the details, then press *Reserve all*.");
        expect(sectionText(m)).toContain("*Your tray (1)*");
        for (const a of Object.values(adapters)) expect(a.book).not.toHaveBeenCalled();
        expect(livingDigest.refresh).not.toHaveBeenCalled();
      });

      it("a request missing details still goes in, with the gaps left to fill", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"] });
        await command("tech set 2");
        expect(stored().lines).toEqual([expect.objectContaining({ item: "Tech Set 2", date: null, start: null, end: null, title: null })]);
      });

      it("treats a small-hours time nobody said am for as missing", async () => {
        llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "02:00", end: "04:00" });
        await command("tech set 2 sat 2-4 youth night");
        expect(stored().lines[0]).toMatchObject({ date: "2026-10-17", start: null, end: null });
      });

      it("keeps a small-hours time the member wrote as am", async () => {
        llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "05:00", end: "07:00" });
        await command("tech set 2 sat 5-7am for sunrise hike");
        expect(stored().lines[0]).toMatchObject({ start: 300, end: 420 });
      });

      it("keeps the lines already in the tray", async () => {
        await command("tech set 2 sat 2-4 youth night");
        llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"], title: "MBS" });
        await command("mpr sat 2-4 mbs");
        expect(stored().lines.map((l) => [l.item, l.title])).toEqual([["Tech Set 2", "Youth night"], ["MPR", "MBS"]]);
      });
    });

    it("outside the reservations channel, points there without parsing", async () => {
      client.chat.postEphemeral.mockRejectedValueOnce(new Error("not_in_channel"));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
      await command("what are my reservations", "COTHER");
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith("https://r", expect.objectContaining({ body: JSON.stringify({ response_type: "ephemeral", text: "Use /reserve in <#CRES>." }) }));
      fetchSpy.mockRestore();
    });
  });

  describe("questions are answered privately", () => {
    const ask = (text = "book tech set 2 sat 2-4 for youth night") => h.handleCommand({ userId: "U9", channel: "CRES", text, client, responseUrl: "https://r" });
    // The private answer, and nothing in the channel.
    const answer = () => {
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      const [m] = client.chat.postEphemeral.mock.calls.map((c) => c[0]);
      expect(m).toMatchObject({ channel: "CRES", user: "U9", username: "Reservations" });
      expect(m.thread_ts).toBeUndefined();
      return m;
    };

    it("answers a check without booking", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
      await ask();
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(answer().text).toBe("Tech Set 2 is free Sat 10/17, 2:00–4:00 PM.");
    });

    it("a check naming items in two systems reads both", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check", items: ["MPR", "Tech Set 2"] });
      adapters.rms.findConflicts.mockResolvedValue([{ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 900, title: "Rally", holder: "Alan", holderUserId: null, holderEmail: null }]);
      await ask();
      expect(adapters.rooms.findConflicts).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: "MPR" })] }));
      expect(answer().text).toMatch(/^MPR, Tech Set 2 is taken Sat 10\/17:\n• 2:00–3:00 PM · Tech Set 2 · Rally \(Alan\)/);
    });

    it("an ambiguous question asks which one", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "check", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
      await ask();
      expect(answer().text).toBe('Which one did you mean by "a speaker": Tech Set 2, MPR? Ask again with its name.');
    });

    it("lists across all backends when no item is named", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", date: "2026-10-17", toDate: "2026-10-18" });
      adapters.rooms.listReservations.mockResolvedValue({ reservations: [{ category: "rooms", item: "MPR", date: "2026-10-17", start: 600, end: 720, title: "MBS", holder: "Arie", holderUserId: null, holderEmail: null }], errors: [] });
      await ask();
      for (const a of Object.values(adapters)) expect(a.listReservations).toHaveBeenCalledWith({ from: "2026-10-17", to: "2026-10-18", items: [] });
      expect(answer().text).toBe("*Sat 10/17*\n• 10:00 AM–12:00 PM · MPR · MBS (Arie)");
    });

    describe("list periods", () => {
      // now = 2026-10-14 12:00 NY
      const R = (o) => ({ category: "tech", item: "Tech Set 2", start: 600, end: 660, title: "T", holder: "Alan", holderUserId: null, holderEmail: null, ...o });

      it("with items and no period, shows each item's next upcoming reservation", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"] });
        adapters.rms.listReservations.mockResolvedValue({ reservations: [
          R({ date: "2026-10-14", start: 540, end: 600, title: "Over already" }),
          R({ date: "2026-11-02", start: 1080, end: 1200, title: "Later" }),
          R({ date: "2026-10-20", start: 1140, end: 1260, title: "Youth night" }),
        ], errors: [] });
        await ask("who has tech set 2");
        expect(adapters.rms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2027-04-12", items: [SET2] });
        expect(answer().text).toBe("Next up for Tech Set 2, Tue 10/20:\n• 7:00–9:00 PM · Tech Set 2 · Youth night (Alan)");
      });

      it("says when an item has no upcoming reservations", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"] });
        await ask("who has tech set 2");
        expect(answer().text).toBe("No upcoming reservations for Tech Set 2.");
      });

      it("with no items and no period, lists the next 14 days", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list" });
        await ask("what's booked");
        expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2026-10-27", items: [] });
        expect(answer().text).toBe("Nothing booked Wed 10/14 – Tue 10/27.");
      });

      it("names the items when a period has nothing booked", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"], date: "2026-10-17", toDate: "2026-10-18" });
        await ask("who has tech set 2 this weekend");
        expect(answer().text).toBe("Nothing booked for Tech Set 2, Sat 10/17 – Sun 10/18.");
      });
    });
  });
});

describe("find intent", () => {
  const mk = (catalog, raw) => {
    const llm = { parseReservationRequest: vi.fn().mockResolvedValue(raw) };
    const client = makeClient();
    const h = createReservationsHandler({ llm, adapters: {}, catalog, channelId: "CRES", now: () => NOW });
    const answers = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);
    return { h, client, answers };
  };
  const run = (h, client) => h.handleCommand({ userId: "U9", channel: "CRES", text: "what speakers are there?", client, responseUrl: "https://r" });

  it("groups matches by category and says how to book", async () => {
    const cat = [
      { label: "Tech Set 1", category: "tech", backend: "rms" }, { label: "Tech Set 2", category: "tech", backend: "rms" },
      { label: "MPR", category: "rooms", backend: "rooms" },
    ];
    const { h, client, answers } = mk(cat, { intent: "find", items: ["Tech Set 1", "MPR", "Tech Set 2"] });
    await run(h, client);
    const [a] = answers();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(a).toMatchObject({ channel: "CRES", user: "U9", username: "Reservations" });
    expect(a.thread_ts).toBeUndefined();
    expect(a.text).toContain("Rooms: MPR");
    expect(a.text).toContain("Tech: Tech Set 1, Tech Set 2");
    expect(a.text).toContain("To book one, use `/reserve` with its name, the day, the time and what it's for.");
  });

  it("caps at 25 and counts the rest", async () => {
    const cat = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i + 1}`, category: "tech", backend: "rms" }));
    const { h, client, answers } = mk(cat, { intent: "find", items: cat.map((c) => c.label) });
    await run(h, client);
    const text = answers()[0].text;
    expect(text).toContain("Item 25");
    expect(text).not.toMatch(/Item 26(\b|$)/);
    expect(text).toContain("+5 more. Try a narrower word.");
  });

  it("says nothing matches and shows what is available", async () => {
    const { h, client, answers } = mk(CATALOG, { intent: "find", items: [], unmatched: ["flamethrower"] });
    await run(h, client);
    expect(answers()[0].text).toMatch(/^Nothing matches/);
    expect(answers()[0].text).toMatch(/Kitchen \(1\) · Tech \(1\)/);
  });
});

describe("my reservations", () => {
  // now = Tue 2026-10-20, 12:00 PM in New York.
  const NOW_MINE = new Date("2026-10-20T16:00:00Z");
  const TRANSIT = { label: "CP Transit", category: "vehicles", backend: "rms", calendarId: "tr" };
  const CAT = buildCatalog({ rooms: true, kitchen: true, rms: [SET2, TRANSIT] });
  const LINKS = "Rooms: https://rooms · Kitchen: https://kitchen · Calendar: https://rms";
  const room = (o = {}) => {
    const r = { category: "rooms", item: "MPR", date: "2026-10-24", start: 600, end: 720, title: "MBS", holder: "Deandra Shim", holderName: "Deandra Shim", holderUserId: null, holderEmail: null, ...o };
    return { ...r, ref: { backend: "rooms", date: r.date, start: r.start, end: r.end, title: r.title, holder: r.holder, rooms: [r.item] } };
  };
  const kitchen = (o = {}) => {
    const r = { category: "kitchen", item: "Kitchen", date: "2026-10-22", start: 1020, end: 1140, title: "Dee S", holder: "Dee S", holderName: "Dee S", phone: "(201) 555-0100", holderUserId: null, holderEmail: null, row: 7, ...o };
    return { ...r, ref: { backend: "kitchen", row: r.row, date: r.date, name: r.holderName, start: r.start, end: r.end } };
  };
  const rms = (o = {}, ref = {}) => {
    const r = { category: "tech", item: "Tech Set 2", date: "2026-10-21", start: 840, end: 960, title: "Youth night", holder: "deandra@x", holderUserId: null, holderEmail: "deandra@x", ...o };
    return { ...r, ref: { backend: "rms", eventId: "ev1", organizerEmail: "deandra@x", organizerSelf: false, resources: ["t2"], date: r.date, start: r.start, end: r.end, title: r.title, ...ref } };
  };

  let llm, adapters, client, ledger, livingDigest, fetchSpy;
  const make = (o = {}) => createReservationsHandler({ llm, adapters, catalog: CAT, channelId: "CRES", now: () => NOW_MINE, livingDigest, ledger, ...o });
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue({ intent: "mine" }) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    client.users.info.mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Dee", email: "Deandra@x", phone: "+1 201-555-0100" } } });
    ledger = { recordBooking: vi.fn(), bookingsFor: vi.fn().mockResolvedValue([]) };
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
    return () => fetchSpy.mockRestore();
  });
  const ask = (h) => h.handleCommand({ userId: "U9", channel: "CRES", text: "what do I have booked?", client, responseUrl: "https://r" });
  const reply = () => client.chat.postEphemeral.mock.calls[0][0];
  const lines = (m) => m.blocks.filter((b) => b.type === "section" && b.accessory).map((b) => b.text.text);
  const sectionTexts = (m) => m.blocks.filter((b) => b.type === "section").map((b) => b.text.text);
  const listPress = (value, o = {}) => ({
    type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
    container: { type: "message", message_ts: "300.1", channel_id: "CRES", is_ephemeral: true },
    response_url: "https://hooks.slack/actions/r1",
    actions: [{ action_id: MINE_CANCEL_ACTION, value }], ...o,
  });

  it("mine lists only the asker's bookings for the next 60 days, sorted, privately", async () => {
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [room(), room({ holder: "Alan Chow", holderName: "Alan Chow", title: "Other" }), room({ holder: "Deandra", holderName: "Deandra", title: "First name only" })], errors: [] });
    adapters.kitchen.listReservations.mockResolvedValue({ reservations: [kitchen(), kitchen({ phone: "201-555-9999", holderName: "Someone", row: 8 })], errors: [] });
    adapters.rms.listReservations.mockResolvedValue({ reservations: [
      rms(),
      rms({ holderEmail: "alan@x", title: "Alan's" }, { eventId: "ev2" }),
      // Today, already over at noon.
      rms({ date: "2026-10-20", start: 540, end: 600, title: "Over" }, { eventId: "ev3" }),
      // Today, still going.
      rms({ date: "2026-10-20", start: 660, end: 780, title: "Now", holderUserId: "U9", holderEmail: null }, { eventId: "ev4" }),
    ], errors: [] });
    await ask(make());
    for (const a of Object.values(adapters)) expect(a.listReservations).toHaveBeenCalledWith({ from: "2026-10-20", to: "2026-12-19" });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    const m = reply();
    expect(m).toMatchObject({ channel: "CRES", user: "U9", username: "Reservations" });
    expect(m.thread_ts).toBeUndefined();
    expect(lines(m)).toEqual([
      "📅 *Tech Set 2* · Tue 10/20 · 11:00 AM–1:00 PM · Now",
      "📅 *Tech Set 2* · Wed 10/21 · 2:00–4:00 PM · Youth night",
      "📅 *Kitchen* · Thu 10/22 · 5:00–7:00 PM · Dee S · from the kitchen sheet, matched by name",
      "📅 *MPR* · Sat 10/24 · 10:00 AM–12:00 PM · MBS · from the rooms sheet, matched by name",
    ]);
    expect(ledger.bookingsFor).toHaveBeenCalledWith("U9", { today: "2026-10-20" });
  });

  it("mine merges one calendar event booked on two resources into one line", async () => {
    adapters.rms.listReservations.mockResolvedValue({ reservations: [
      rms(), rms({ category: "vehicles", item: "CP Transit" }, { resources: ["tr"] }),
    ], errors: [] });
    await ask(make({ connect: { authStore: {}, memberGoogle: {} } }));
    const m = reply();
    expect(lines(m)).toEqual(["📅 *Tech Set 2, CP Transit* · Wed 10/21 · 2:00–4:00 PM · Youth night"]);
    const b = m.blocks.find((x) => x.accessory).accessory;
    expect(b.action_id).toBe(MINE_CANCEL_ACTION);
    expect(decodeRef(b.value)).toEqual({ user: "U9", ref: expect.objectContaining({ eventId: "ev1", resources: ["t2", "tr"] }) });
  });

  it("mine caps at 20 lines and adds …and N more with links", async () => {
    adapters.rooms.listReservations.mockResolvedValue({ reservations: Array.from({ length: 23 }, (_, i) => room({ start: 600 + i, title: `T${i}` })), errors: [] });
    await ask(make());
    const m = reply();
    expect(lines(m)).toHaveLength(20);
    expect(lines(m)[0]).toContain("T0");
    expect(sectionTexts(m).at(-1)).toBe(`…and 3 more. ${LINKS}`);
    expect(m.blocks.length).toBeLessThanOrEqual(50);
  });

  it("mine shows a 14-date series as one line, first, with Cancel… opening the chooser", async () => {
    const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 9, 24 + 7 * i)).toISOString().slice(0, 10));
    const rows = dates.map((date) => room({ date, start: 840, end: 960, holder: "D. S.", holderName: "D. S." }));
    const series = { id: "L1-run1", item: "MPR", start: 840, end: 960, title: "MBS", repeat: { days: [6], until: dates.at(-1) }, channel: "CRES", postTs: "500.1", refs: rows.map((r) => r.ref) };
    ledger.seriesFor = vi.fn().mockResolvedValue([series]);
    ledger.bookingsFor.mockResolvedValue(series.refs);
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [...rows.slice(0, 9), room({ date: "2026-10-22", title: "Other" })], errors: [] });
    await ask(make());
    const m = reply();
    expect(ledger.seriesFor).toHaveBeenCalledWith("U9", { today: "2026-10-20" });
    expect(lines(m)).toEqual([
      "📅 *MPR* · every Sat until Sat 1/23 · 14 dates left · 2:00–4:00 PM · MBS",
      "📅 *MPR* · Thu 10/22 · 10:00 AM–12:00 PM · Other · from the rooms sheet, matched by name",
    ]);
    const b = m.blocks.find((x) => x.accessory).accessory;
    expect(b).toMatchObject({ type: "button", action_id: MINE_SERIES_ACTION, text: { text: "Cancel…" } });
    expect(JSON.parse(b.value)).toEqual({ u: "U9", s: "L1-run1" });

    // Cancel… replaces the list with the series chooser.
    await make().handleCardAction({ payload: listPress(b.value, { actions: [{ action_id: MINE_SERIES_ACTION, value: b.value }] }), client });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.replace_original).toBe(true);
    expect(body.blocks.find((x) => x.type === "actions").elements.map((e) => e.action_id)).toEqual(["reservation_series_all", "reservation_series_one"]);
  });

  it("series lines count toward the 20-line cap", async () => {
    const one = (i) => ({ id: `S${i}`, item: "MPR", start: 840, end: 960, title: `S${i}`, repeat: { days: [6], until: "2026-11-07" }, channel: "CRES", postTs: null, refs: [room({ date: "2026-10-24", start: 840 + i, title: `S${i}` }).ref] });
    ledger.seriesFor = vi.fn().mockResolvedValue([one(1), one(2), one(3)]);
    adapters.rooms.listReservations.mockResolvedValue({ reservations: Array.from({ length: 20 }, (_, i) => room({ start: 600 + i, title: `T${i}` })), errors: [] });
    await ask(make());
    expect(lines(reply())).toHaveLength(20);
    expect(lines(reply())[0]).toContain("S1");
    expect(sectionTexts(reply()).at(-1)).toBe(`…and 3 more. ${LINKS}`);
  });

  it("mine with nothing found gives the empty copy and links", async () => {
    await ask(make());
    expect(sectionTexts(reply())).toEqual([`I don't see any upcoming bookings under your name.\n${LINKS}`]);
  });

  it("mine still answers when one backend fails, with Some bookings couldn't be checked.", async () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [room()], errors: [] });
    adapters.kitchen.listReservations.mockRejectedValue(new Error("sheets down"));
    await ask(make());
    expect(lines(reply())).toHaveLength(1);
    expect(sectionTexts(reply())).toContain("⚠️ Some bookings couldn't be checked.");
    // One calendar failing (errors) counts too.
    client.chat.postEphemeral.mockClear();
    adapters.kitchen.listReservations.mockResolvedValue({ reservations: [], errors: [] });
    adapters.rms.listReservations.mockResolvedValue({ reservations: [], errors: ["Tech Set 2: boom"] });
    await ask(make());
    expect(sectionTexts(reply())).toContain("⚠️ Some bookings couldn't be checked.");
    spy.mockRestore();
  });

  it("a name-matched sheet row says matched by name and its confirm quotes the row", async () => {
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [room({ title: "MBS ", holder: "deandra shim (youth)", holderName: "deandra shim (youth)" })], errors: [] });
    await ask(make());
    const b = reply().blocks.find((x) => x.accessory);
    expect(b.text.text).toBe("📅 *MPR* · Sat 10/24 · 10:00 AM–12:00 PM · MBS · from the rooms sheet, matched by name");
    expect(b.accessory.confirm.text.text).toBe('"MBS " · deandra shim (youth) · Sat 10/24 · 10:00 AM–12:00 PM in the rooms sheet');
  });

  it("a sheet row the bot booked for the member is found through the ledger, with no suffix", async () => {
    const mine = room({ holder: "D. S.", holderName: "D. S." });
    ledger.bookingsFor.mockResolvedValue([mine.ref]);
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [mine], errors: [] });
    await ask(make());
    expect(lines(reply())).toEqual(["📅 *MPR* · Sat 10/24 · 10:00 AM–12:00 PM · MBS"]);
    expect(reply().blocks.find((x) => x.accessory).accessory.confirm.text.text).toBe("MPR · Sat 10/24 · 10:00 AM–12:00 PM will be released.");
  });

  it("a failed ledger read is logged and the list still comes back", async () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    ledger.bookingsFor.mockRejectedValue(new Error("ddb down"));
    adapters.rooms.listReservations.mockResolvedValue({ reservations: [room()], errors: [] });
    await ask(make());
    expect(lines(reply())).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith("booking ledger read failed", expect.anything());
    spy.mockRestore();
  });

  it("without connect, a calendar event the member organized gets Open in Calendar; the bot's own gets Cancel", async () => {
    adapters.rms.listReservations.mockResolvedValue({ reservations: [
      rms(), rms({ title: "Bot's", holderUserId: "U9" }, { eventId: "ev9", organizerSelf: true, resources: ["tr"] }),
    ], errors: [] });
    await ask(make());
    const [theirs, bots] = reply().blocks.filter((x) => x.accessory).map((x) => x.accessory);
    expect(theirs).toMatchObject({ text: { text: "Open in Calendar" }, url: "https://calendar.google.com/calendar/u/0/r?cid=t2" });
    expect(theirs.value).toBeUndefined();
    expect(bots).toMatchObject({ action_id: MINE_CANCEL_ACTION, text: { text: "Cancel" } });
  });

  it("with connect, every entry gets Cancel", async () => {
    adapters.rms.listReservations.mockResolvedValue({ reservations: [rms()], errors: [] });
    await ask(make({ connect: { authStore: {}, memberGoogle: {} } }));
    expect(reply().blocks.find((x) => x.accessory).accessory.action_id).toBe(MINE_CANCEL_ACTION);
  });

  describe("Cancel from the list", () => {
    let value;
    beforeEach(async () => {
      adapters.rooms.listReservations.mockResolvedValue({ reservations: [room(), room({ date: "2026-10-31", title: "Later" })], errors: [] });
      await ask(make());
      value = reply().blocks.find((x) => x.accessory).accessory.value;
      client.chat.postEphemeral.mockClear();
      adapters.rooms.listReservations.mockClear();
    });
    const sent = () => JSON.parse(fetchSpy.mock.calls[0][1].body);

    it("cancel from the list replaces the list via response_url with the 🚫 notice on top", async () => {
      adapters.rooms.listReservations.mockResolvedValue({ reservations: [room({ date: "2026-10-31", title: "Later" })], errors: [] });
      await make().handleCardAction({ payload: listPress(value), client });
      expect(adapters.rooms.cancel.mock.calls).toEqual([[room().ref]]);
      expect(fetchSpy).toHaveBeenCalledWith("https://hooks.slack/actions/r1", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } }));
      const body = sent();
      expect(body.replace_original).toBe(true);
      expect(sectionTexts(body)[0]).toBe("🚫 Booking cancelled by <@U9>.");
      expect(lines(body)).toEqual(["📅 *MPR* · Sat 10/31 · 10:00 AM–12:00 PM · Later · from the rooms sheet, matched by name"]);
      expect(adapters.rooms.listReservations).toHaveBeenCalledTimes(1);
      expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-24");
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("a passing failure also replaces the list, with the ⚠️ text on top", async () => {
      const spy = vi.spyOn(log, "error").mockImplementation(() => {});
      adapters.rooms.cancel.mockRejectedValue(new Error("backendError"));
      await make().handleCardAction({ payload: listPress(value), client });
      expect(sectionTexts(sent())[0]).toBe("⚠️ I couldn't cancel that (backendError). Please try again, or cancel it here: https://rooms");
      expect(lines(sent())).toHaveLength(2);
      spy.mockRestore();
    });

    it("if the list can't be rebuilt, the outcome still replaces it", async () => {
      const spy = vi.spyOn(log, "error").mockImplementation(() => {});
      client.users.info.mockRejectedValue(new Error("ratelimited"));
      await make().handleCardAction({ payload: listPress(value), client });
      expect(sent()).toEqual({ replace_original: true, text: "🚫 Booking cancelled by <@U9>." });
      spy.mockRestore();
    });

    it("someone else's press is refused privately before anything else", async () => {
      await make().handleCardAction({ payload: listPress(value, { user: { id: "U7" } }), client });
      expect(adapters.rooms.cancel).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(client.users.info).toHaveBeenCalledTimes(1);
      expect(client.chat.postEphemeral.mock.calls[0][0]).toEqual({ channel: "CRES", user: "U7", text: "Only <@U9> can cancel this.", username: "Reservations", icon_emoji: ":calendar:" });
    });

    it("a press after the booking ended says so privately", async () => {
      const ended = encodeRef({ user: "U9", ref: { ...room().ref, date: "2026-10-19" } });
      await make().handleCardAction({ payload: listPress(ended), client });
      expect(adapters.rooms.cancel).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ channel: "CRES", user: "U9", text: "That booking has already ended." });
    });

    it("ignores garbage values", async () => {
      await make().handleCardAction({ payload: listPress("{nope"), client });
      expect(adapters.rooms.cancel).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });
  });
});

describe("reservations onboarding", () => {
  let llm, client, claimed, claimOnce, h;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    const adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    claimed = new Set();
    claimOnce = vi.fn(async (key) => (claimed.has(key) ? false : (claimed.add(key), true)));
    h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, claimOnce });
  });
  const ephemerals = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);
  const joined = (o = {}) => ({ type: "member_joined_channel", channel: "CRES", user: "U9", event_ts: "500.1", ...o });

  describe("welcome on join", () => {
    it("tells the new member privately that booking and asking both go through /reserve", async () => {
      await h.handleMemberJoined({ event: joined(), client });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(ephemerals()).toHaveLength(1);
      expect(ephemerals()[0]).toMatchObject({ channel: "CRES", user: "U9", text: WELCOME_TEXT, username: "Reservations" });
      expect(WELCOME_TEXT).toMatch(/\/reserve/);
      expect(WELCOME_TEXT).toContain("`/reserve Tech Set 2 Sat 2-4pm for youth night`");
      expect(WELCOME_TEXT).toContain("*Reserve all*");
      expect(WELCOME_TEXT).not.toContain("post what you need here");
      expect(WELCOME_TEXT).toMatch(/connect your \*acts2\.network\* Google account/);
      expect(claimOnce).toHaveBeenCalledWith("welcome:U9:500.1", WELCOME_TTL_S);
    });

    it("welcomes a join once, however often Slack delivers it", async () => {
      await h.handleMemberJoined({ event: joined(), client });
      await h.handleMemberJoined({ event: joined(), client });
      expect(ephemerals()).toHaveLength(1);
    });

    it("welcomes a member again when they leave and rejoin", async () => {
      await h.handleMemberJoined({ event: joined(), client });
      await h.handleMemberJoined({ event: joined({ event_ts: "900.1" }), client });
      expect(ephemerals()).toHaveLength(2);
    });

    it("ignores joins to other channels, and says nothing without a claim store", async () => {
      await h.handleMemberJoined({ event: joined({ channel: "COTHER" }), client });
      const bare = createReservationsHandler({ llm, adapters: {}, catalog: CATALOG, channelId: "CRES", now: () => NOW });
      await bare.handleMemberJoined({ event: joined(), client });
      expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("a failed welcome doesn't fail the event", async () => {
      client.chat.postEphemeral.mockRejectedValue(new Error("user_not_in_channel"));
      await expect(h.handleMemberJoined({ event: joined(), client })).resolves.toBeUndefined();
    });
  });
});
