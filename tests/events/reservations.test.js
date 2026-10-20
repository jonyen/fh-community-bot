// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";
import { BOOK_ACTION, EDIT_ACTION, CARD_EVENT_TYPE, decodeCard } from "../../src/lib/reservation-card.js";
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
  const posts = () => client.chat.postMessage.mock.calls.map((c) => c[0]);
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
    });

    it("drops obvious chatter before calling the model", async () => {
      for (const text of ["thanks!", "Thank you :pray:", "ok", "👍", "<@U5> lol"]) await h.handleMessage({ event: msg({ text }), client });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    });

    it("stays silent when the model says it's chatter", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "other" });
      await h.handleMessage({ event: msg({ text: "see you all there" }), client });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("does nothing for a message the bot already answered (SQS redelivery)", async () => {
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: MSG_TS, user: "U9" }, { ts: CARD_TS, bot_id: "B1" }] });
      await h.handleMessage({ event: msg(), client });
      expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "CRES", ts: MSG_TS, limit: 20 });
      expect(llm.parseReservationRequest).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("apologises in the thread when the model call fails", async () => {
      llm.parseReservationRequest.mockResolvedValue(null);
      await h.handleMessage({ event: msg(), client });
      expect(posts()[0]).toMatchObject({ channel: "CRES", thread_ts: MSG_TS, text: "Sorry, I couldn't read that. Please try again.", username: "FH Reservations" });
    });

    it("says when it doesn't know an item", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Hologram"] });
      await h.handleMessage({ event: msg(), client });
      expect(posts()[0].text).toMatch(/^I don't know "Hologram"\./);
      expect(posts()[0].text).toMatch(/vehicles/);
    });
  });

  describe("booking requests get a card", () => {
    it("posts a free card in the thread and writes nothing", async () => {
      await h.handleMessage({ event: msg(), client });
      expect(adapters.rms.findConflicts).toHaveBeenCalledWith({ date: "2026-10-17", start: 840, end: 960, items: [SET2] });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      const [card] = posts();
      expect(card).toMatchObject({ channel: "CRES", thread_ts: MSG_TS, username: "FH Reservations", metadata: { event_type: CARD_EVENT_TYPE, event_payload: { user: "U9" } } });
      expect(card.reply_broadcast).toBeUndefined();
      expect(sectionText(card)).toBe("📅 *Tech Set 2* · Sat 10/17 · 2:00–4:00 PM · Youth night\n✅ Free");
      expect(buttons(card).map((b) => b.action_id)).toEqual([BOOK_ACTION, EDIT_ACTION]);
      expect(decodeCard(buttons(card)[0].value, CATALOG)).toMatchObject({ user: "U9", req: { items: [SET2], date: "2026-10-17", start: 840, end: 960, title: "Youth night" } });
      expect(livingDigest.refresh).not.toHaveBeenCalled();
    });

    it("shows who holds a taken slot and offers only Edit", async () => {
      adapters.rms.findConflicts.mockResolvedValue([TAKEN]);
      client.users.lookupByEmail.mockResolvedValue({ user: { id: "UALAN" } });
      await h.handleMessage({ event: msg(), client });
      const [card] = posts();
      expect(sectionText(card)).toContain("❌ Taken:\n• 2:00–3:30 PM · Tech Set 2 · Fall rally (<@UALAN>)");
      expect(buttons(card).map((b) => b.action_id)).toEqual([EDIT_ACTION]);
    });

    it("lists missing details", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", items: ["Tech Set 2"] });
      await h.handleMessage({ event: msg(), client });
      expect(sectionText(posts()[0])).toContain("Missing: date, start and end time, what it's for. Press Edit to fill it in.");
      expect(adapters.rms.findConflicts).not.toHaveBeenCalled();
    });

    it("asks which item when ambiguous", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "book", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
      await h.handleMessage({ event: msg(), client });
      expect(sectionText(posts()[0])).toContain('Which one did you mean by "a speaker": Tech Set 2, MPR? Press Edit to pick.');
    });

    it("refuses mixed kinds and past dates on the card", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Tech Set 2", "MPR"] });
      await h.handleMessage({ event: msg(), client });
      expect(sectionText(posts()[0])).toContain("booked separately");
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, date: "2026-10-01" });
      await h.handleMessage({ event: msg({ ts: "300.1" }), client });
      expect(sectionText(posts()[1])).toContain("That date has passed.");
    });

    it("treats a small-hours time nobody said am for as missing", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "02:00", end: "04:00" });
      await h.handleMessage({ event: msg(), client });
      expect(sectionText(posts()[0])).toContain("Missing: start and end time.");
    });

    it("keeps a small-hours time the member wrote as am", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, start: "05:00", end: "07:00" });
      await h.handleMessage({ event: msg({ text: "book tech set 2 sat 5-7am for sunrise hike" }), client });
      expect(sectionText(posts()[0])).toContain("5:00–7:00 AM");
    });
  });

  describe("Book", () => {
    let card;
    beforeEach(async () => {
      await h.handleMessage({ event: msg(), client });
      card = posts()[0];
      client.chat.postMessage.mockClear();
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
      expect(client.conversations.replies).toHaveBeenCalledTimes(1);
      expect(adapters.rms.book).not.toHaveBeenCalled();
    });

    it("a slot taken since the card was posted turns the card to taken and writes nothing", async () => {
      adapters.rms.findConflicts.mockResolvedValue([TAKEN]);
      await h.handleCardAction({ payload: press(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      const [u] = updates();
      expect(sectionText(u)).toContain("❌ Taken:");
      expect(buttons(u).map((b) => b.action_id)).toEqual([EDIT_ACTION]);
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
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["Kitchen"], appliances: { airFryer: true } });
      client.conversations.replies.mockResolvedValue({ messages: [] });
      client.chat.postMessage.mockClear();
      await h.handleMessage({ event: msg({ ts: "400.1" }), client });
      const kitchen = posts()[0];
      client.conversations.replies.mockResolvedValue({ messages: [{ ts: CARD_TS, bot_id: "B1", blocks: kitchen.blocks }] });
      await h.handleCardAction({ payload: press({ actions: [buttons(kitchen)[0]] }), client });
      expect(adapters.kitchen.book.mock.calls[0][0].appliances).toEqual({ airFryer: true });
    });
  });

  describe("Edit modal submit", () => {
    let card;
    beforeEach(async () => {
      await h.handleMessage({ event: msg(), client });
      card = posts()[0];
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
      expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ user: "U9", text: "That request is already finished. Post a new message to book again." });
    });

    it("ignores other modals and other users", async () => {
      await h.handleModalSubmit({ payload: submit({ user: { id: "U7" } }), client });
      const other = submit();
      other.view.callback_id = "something_else";
      await h.handleModalSubmit({ payload: other, client });
      expect(client.chat.update).not.toHaveBeenCalled();
    });
  });

  describe("questions are answered in the thread", () => {
    it("answers a check without booking", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check" });
      await h.handleMessage({ event: msg(), client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(posts()[0]).toMatchObject({ thread_ts: MSG_TS, text: "Tech Set 2 is free Sat 10/17, 2:00–4:00 PM." });
    });

    it("a check naming items in two systems reads both", async () => {
      llm.parseReservationRequest.mockResolvedValue({ ...BOOK, intent: "check", items: ["MPR", "Tech Set 2"] });
      adapters.rms.findConflicts.mockResolvedValue([{ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 900, title: "Rally", holder: "Alan", holderUserId: null, holderEmail: null }]);
      await h.handleMessage({ event: msg(), client });
      expect(adapters.rooms.findConflicts).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: "MPR" })] }));
      expect(posts()[0].text).toMatch(/^MPR, Tech Set 2 is taken Sat 10\/17:\n• 2:00–3:00 PM · Tech Set 2 · Rally \(Alan\)/);
    });

    it("an ambiguous question asks which one", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "check", ambiguous: [{ phrase: "a speaker", options: ["Tech Set 2", "MPR"] }] });
      await h.handleMessage({ event: msg(), client });
      expect(posts()[0].text).toBe('Which one did you mean by "a speaker": Tech Set 2, MPR? Ask again with its name.');
    });

    it("lists across all backends when no item is named", async () => {
      llm.parseReservationRequest.mockResolvedValue({ intent: "list", date: "2026-10-17", toDate: "2026-10-18" });
      adapters.rooms.listReservations.mockResolvedValue({ reservations: [{ category: "rooms", item: "MPR", date: "2026-10-17", start: 600, end: 720, title: "MBS", holder: "Arie", holderUserId: null, holderEmail: null }], errors: [] });
      await h.handleMessage({ event: msg(), client });
      for (const a of Object.values(adapters)) expect(a.listReservations).toHaveBeenCalledWith({ from: "2026-10-17", to: "2026-10-18", items: [] });
      expect(posts()[0].text).toBe("*Sat 10/17*\n• 10:00 AM–12:00 PM · MPR · MBS (Arie)");
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
        await h.handleMessage({ event: msg({ text: "who has tech set 2" }), client });
        expect(adapters.rms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2027-04-12", items: [SET2] });
        expect(posts()[0].text).toBe("Next up for Tech Set 2, Tue 10/20:\n• 7:00–9:00 PM · Tech Set 2 · Youth night (Alan)");
      });

      it("says when an item has no upcoming reservations", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"] });
        await h.handleMessage({ event: msg({ text: "who has tech set 2" }), client });
        expect(posts()[0].text).toBe("No upcoming reservations for Tech Set 2.");
      });

      it("with no items and no period, lists the next 14 days", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list" });
        await h.handleMessage({ event: msg({ text: "what's booked" }), client });
        expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-14", to: "2026-10-27", items: [] });
        expect(posts()[0].text).toBe("Nothing booked Wed 10/14 – Tue 10/27.");
      });

      it("names the items when a period has nothing booked", async () => {
        llm.parseReservationRequest.mockResolvedValue({ intent: "list", items: ["Tech Set 2"], date: "2026-10-17", toDate: "2026-10-18" });
        await h.handleMessage({ event: msg({ text: "who has tech set 2 this weekend" }), client });
        expect(posts()[0].text).toBe("Nothing booked for Tech Set 2, Sat 10/17 – Sun 10/18.");
      });
    });
  });
});

describe("find intent", () => {
  const mk = (catalog, raw) => {
    const llm = { parseReservationRequest: vi.fn().mockResolvedValue(raw) };
    const client = makeClient();
    const h = createReservationsHandler({ llm, adapters: {}, catalog, channelId: "CRES", now: () => NOW });
    const answers = () => client.chat.postMessage.mock.calls.map((c) => c[0]);
    return { h, client, answers };
  };
  const run = (h, client) => h.handleMessage({ event: msg({ text: "what speakers are there?" }), client });

  it("groups matches by category and says how to book", async () => {
    const cat = [
      { label: "Tech Set 1", category: "tech", backend: "rms" }, { label: "Tech Set 2", category: "tech", backend: "rms" },
      { label: "MPR", category: "rooms", backend: "rooms" },
    ];
    const { h, client, answers } = mk(cat, { intent: "find", items: ["Tech Set 1", "MPR", "Tech Set 2"] });
    await run(h, client);
    const [a] = answers();
    expect(a.thread_ts).toBe(MSG_TS);
    expect(a.text).toContain("Rooms: MPR");
    expect(a.text).toContain("Tech: Tech Set 1, Tech Set 2");
    expect(a.text).toContain("To book one, post its name, the day, the time and what it's for.");
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
