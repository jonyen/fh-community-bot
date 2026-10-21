// tests/events/reservations-series.test.js
// Cancelling from the combined public post: a single line, a whole repeat
// series, or one date of it, and the connect-then-resume path.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { combinedMessage, SERIES_ALL_ACTION, SERIES_ONE_ACTION } from "../../src/lib/reservation-combined.js";
import { MINE_SERIES_ACTION } from "../../src/lib/reservation-mine.js";
import { refKey } from "../../src/lib/reservation-owner.js";
import { log } from "../../src/lib/logger.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
// Tue 2026-10-20, 12:00 PM in New York.
const NOW = new Date("2026-10-20T16:00:00Z");
const POST_TS = "500.1";
const SERIES_ID = "L1-run1";
const MEMBER_CLIENTS = { sheetsClient: { kind: "member-sheets" }, calendarClient: { kind: "member-cal" } };

const RMS_REF = { backend: "rms", eventId: "ev1", organizerEmail: null, organizerSelf: true, resources: ["t2"], date: "2026-10-24", start: 600, end: 720, title: "Youth night" };
const roomRef = (date, o = {}) => ({ backend: "rooms", date, start: 840, end: 960, title: "MBS", holder: "Deandra", rooms: ["MPR"], ...o });
// Today's date is already over at noon; the other three are still to come.
const ENDED_REF = roomRef("2026-10-20", { start: 540, end: 600 });
const LIVE_REFS = [roomRef("2026-10-24"), roomRef("2026-10-31"), roomRef("2026-11-07")];
const SERIES = {
  id: SERIES_ID, item: "MPR", start: 840, end: 960, title: "MBS", repeat: { days: [6], until: "2026-11-07" },
  channel: "CRES", postTs: POST_TS, refs: [ENDED_REF, ...LIVE_REFS],
};
const POST = combinedMessage({
  user: "U9",
  booked: [
    { summary: "Tech Set 2 · Sat 10/24 · 10:00 AM–12:00 PM · Youth night", ref: RMS_REF, count: 1 },
    { summary: "MPR · every Sat 10/24 – 11/7 (4 dates) · 2:00–4:00 PM · MBS", seriesId: SERIES_ID, count: 4 },
  ],
});

function makeAdapter(backend) {
  return {
    backend, link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ status: "cancelled", link: `https://${backend}/item` }),
  };
}

// The ledger as the auth store keeps it: refs dated today or later, and a
// series' cancelled refs dropped by key.
function makeLedger(series = [structuredClone(SERIES)]) {
  const state = { series };
  return {
    state,
    recordBooking: vi.fn(),
    bookingsFor: vi.fn(async (_u, { today }) => state.series.flatMap((s) => s.refs).filter((r) => r.date >= today)),
    seriesFor: vi.fn(async (u, { today }) => (u !== "U9" ? [] : state.series
      .map((s) => ({ ...s, refs: s.refs.filter((r) => r.date >= today) }))
      .filter((s) => s.refs.length))),
    dropSeriesRefs: vi.fn(async (_u, id, keys) => {
      state.series = state.series.map((s) => (s.id === id ? { ...s, refs: s.refs.filter((r) => !keys.includes(refKey(r))) } : s)).filter((s) => s.refs.length);
    }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "999.1" }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
      history: vi.fn().mockResolvedValue({ messages: [{ ts: POST_TS, bot_id: "B1", ...structuredClone(POST) }] }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555", email: "deandra.shim@acts2.network" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

function makeConnect(status) {
  return {
    authStore: {
      createPending: vi.fn().mockResolvedValue({ pendingId: "P1", nonce: "NONCE" }),
      getPending: vi.fn(),
      deletePending: vi.fn().mockResolvedValue(),
      markRevoked: vi.fn().mockResolvedValue(),
    },
    memberGoogle: {
      clientsFor: vi.fn().mockResolvedValue(status === "active" ? { status, clients: MEMBER_CLIENTS } : { status }),
      forget: vi.fn(),
      revoke: vi.fn(),
    },
    consentUrl: vi.fn(({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  };
}

describe("cancelling from the combined post", () => {
  let adapters, client, ledger, livingDigest, fetchSpy;
  const make = (o = {}) => createReservationsHandler({
    llm: { parseReservationRequest: vi.fn() }, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, livingDigest, ledger, ...o,
  });
  beforeEach(() => {
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    ledger = makeLedger();
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
  });
  afterEach(() => fetchSpy.mockRestore());

  const ephemerals = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);
  const updates = () => client.chat.update.mock.calls.map((c) => c[0]);
  const postButton = (i) => POST.blocks[i + 1].accessory;
  const postPress = (button, user = "U9") => ({
    type: "block_actions", user: { id: user }, channel: { id: "CRES" },
    container: { type: "message", message_ts: POST_TS, channel_id: "CRES" },
    message: { ts: POST_TS, ...POST }, actions: [button],
  });
  // The private chooser, as Slack would send its presses back.
  const chooserPress = (chooser, actionId, o = {}) => {
    const block = chooser.blocks.find((b) => b.type === "actions");
    const el = block.elements.find((e) => e.action_id === actionId);
    return {
      type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
      container: { type: "message", message_ts: "600.1", channel_id: "CRES", is_ephemeral: true },
      response_url: "https://hooks.slack/actions/c1",
      actions: [{ ...el, block_id: block.block_id, ...o }],
    };
  };
  async function openChooser(h) {
    await h.handleCardAction({ payload: postPress(postButton(1)), client });
    const chooser = ephemerals().at(-1);
    client.chat.postEphemeral.mockClear();
    return chooser;
  }

  it("someone else pressing a line's Cancel is refused privately and nothing is cancelled", async () => {
    const h = make();
    await h.handleCardAction({ payload: postPress(postButton(0), "U7"), client });
    await h.handleCardAction({ payload: postPress(postButton(1), "U7"), client });
    expect(adapters.rms.cancel).not.toHaveBeenCalled();
    expect(adapters.rooms.cancel).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(ephemerals()).toEqual([
      expect.objectContaining({ channel: "CRES", user: "U7", text: "Only <@U9> can cancel this." }),
      expect.objectContaining({ channel: "CRES", user: "U7", text: "Only <@U9> can cancel this." }),
    ]);
  });

  it("a single line's Cancel cancels it and marks only that line of the post", async () => {
    await make().handleCardAction({ payload: postPress(postButton(0)), client });
    expect(adapters.rms.cancel.mock.calls).toEqual([[RMS_REF]]);
    expect(client.conversations.history).toHaveBeenCalledWith({ channel: "CRES", latest: POST_TS, inclusive: true, limit: 1, include_all_metadata: true });
    const [u] = updates();
    expect(u).toMatchObject({ channel: "CRES", ts: POST_TS });
    expect(u.blocks[1].text.text).toBe("• Tech Set 2 · Sat 10/24 · 10:00 AM–12:00 PM · Youth night\n🚫 Cancelled by <@U9>.");
    expect(u.blocks[1].accessory).toBeUndefined();
    expect(u.blocks[0]).toEqual(POST.blocks[0]);
    expect(u.blocks[2]).toEqual(POST.blocks[2]);
    expect(u.metadata).toEqual(POST.metadata);
    expect(livingDigest.refresh).toHaveBeenCalledWith("2026-10-24");
  });

  it("a single line that already ended is refused privately", async () => {
    const ended = { ...RMS_REF, date: "2026-10-19" };
    const button = { ...postButton(0), value: JSON.stringify({ u: "U9", i: 0, r: ended }) };
    await make().handleCardAction({ payload: postPress(button), client });
    expect(adapters.rms.cancel).not.toHaveBeenCalled();
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U9", text: "That booking has already ended." })]);
  });

  it("a single line already cancelled elsewhere says so privately and leaves the post", async () => {
    adapters.rms.cancel.mockResolvedValue({ status: "already", link: "https://rms/item" });
    await make().handleCardAction({ payload: postPress(postButton(0)), client });
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U9", text: "That booking was already cancelled." })]);
  });

  it("still cancels when the post can't be read, and tells the member privately", async () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    client.conversations.history.mockRejectedValue(new Error("ratelimited"));
    await make().handleCardAction({ payload: postPress(postButton(0)), client });
    expect(adapters.rms.cancel).toHaveBeenCalledTimes(1);
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U9", text: "🚫 Booking cancelled by <@U9>." })]);
    spy.mockRestore();
  });

  it("a press on a line already marked cancelled does nothing (a second press or redelivery)", async () => {
    const marked = structuredClone(POST);
    delete marked.blocks[1].accessory;
    client.conversations.history.mockResolvedValue({ messages: [{ ts: POST_TS, ...marked }] });
    await make().handleCardAction({ payload: postPress(postButton(0)), client });
    expect(adapters.rms.cancel).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("a series line's Cancel asks privately: whole series or one of its remaining dates", async () => {
    const chooser = await openChooser(make());
    expect(ledger.seriesFor).toHaveBeenCalledWith("U9", { today: "2026-10-20" });
    const block = chooser.blocks.find((b) => b.type === "actions");
    expect(JSON.parse(block.block_id)).toEqual({ u: "U9", s: SERIES_ID, pt: POST_TS, c: "CRES" });
    expect(block.elements.map((e) => e.action_id)).toEqual([SERIES_ALL_ACTION, SERIES_ONE_ACTION]);
    expect(block.elements[1].options.map((o) => o.value)).toEqual(LIVE_REFS.map((r) => JSON.stringify({ d: r.date })));
    expect(adapters.rooms.cancel).not.toHaveBeenCalled();
  });

  it("a series with nothing left to cancel says so privately", async () => {
    ledger = makeLedger([]);
    await make().handleCardAction({ payload: postPress(postButton(1)), client });
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U9", text: "That series has no dates left to cancel." })]);
  });

  it("Whole series cancels the remaining dates, not the ended one, drops them and marks the post line", async () => {
    const h = make();
    const chooser = await openChooser(h);
    await h.handleCardAction({ payload: chooserPress(chooser, SERIES_ALL_ACTION), client });
    expect(adapters.rooms.cancel.mock.calls).toEqual(LIVE_REFS.map((r) => [r]));
    expect(ledger.dropSeriesRefs).toHaveBeenCalledWith("U9", SERIES_ID, LIVE_REFS.map(refKey));
    expect(ledger.state.series[0].refs).toEqual([ENDED_REF]);
    const [u] = updates();
    expect(u).toMatchObject({ channel: "CRES", ts: POST_TS });
    expect(u.blocks[2].text.text).toBe("• MPR · every Sat 10/24 – 11/7 (4 dates) · 2:00–4:00 PM · MBS\n🚫 Series cancelled by <@U9> (3 dates).");
    expect(u.blocks[2].accessory).toBeUndefined();
    expect(u.blocks[1]).toEqual(POST.blocks[1]);
    // The private summary replaces the chooser.
    const body = JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
    expect(fetchSpy.mock.calls.at(-1)[0]).toBe("https://hooks.slack/actions/c1");
    expect(body).toMatchObject({ replace_original: true, text: "🚫 Cancelled 3 dates of MPR · every Sat until Sat 11/7." });
    // One digest refresh per period: Oct 24, Oct 31 and Nov 7 are three weekends.
    expect(livingDigest.refresh.mock.calls.map((c) => c[0])).toEqual(["2026-10-24", "2026-10-31", "2026-11-07"]);
  });

  it("Whole series reports dates that couldn't be cancelled, and keeps them", async () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    adapters.rooms.cancel.mockImplementation(async (ref) => (ref.date === "2026-10-31"
      ? { status: "changed", link: "https://rooms/row" }
      : { status: "cancelled", link: "https://rooms/item" }));
    const h = make();
    await h.handleCardAction({ payload: chooserPress(await openChooser(h), SERIES_ALL_ACTION), client });
    expect(ledger.state.series[0].refs.map((r) => r.date)).toEqual(["2026-10-20", "2026-10-31"]);
    expect(updates()[0].blocks[2].text.text).toBe("• MPR · every Sat 10/24 – 11/7 (4 dates) · 2:00–4:00 PM · MBS\n🚫 Series cancelled by <@U9> (2 dates). 1 couldn't be cancelled; check https://rooms/row.");
    spy.mockRestore();
  });

  it("over 60 remaining dates: cancels 60, keeps the rest and the line's Cancel, and the note says so far", async () => {
    const many = Array.from({ length: 63 }, (_, i) => roomRef(new Date(Date.UTC(2026, 9, 24 + i)).toISOString().slice(0, 10)));
    ledger = makeLedger([{ ...structuredClone(SERIES), refs: many }]);
    const h = make();
    await h.handleCardAction({ payload: chooserPress(await openChooser(h), SERIES_ALL_ACTION), client });
    expect(adapters.rooms.cancel).toHaveBeenCalledTimes(60);
    expect(ledger.state.series[0].refs).toEqual(many.slice(60));
    const [u] = updates();
    expect(u.blocks[2].text.text).toBe("• MPR · every Sat 10/24 – 11/7 (4 dates) · 2:00–4:00 PM · MBS\n🚫 60 dates cancelled by <@U9> so far; press Cancel again for the rest.");
    expect(u.blocks[2].accessory).toEqual(POST.blocks[2].accessory);
  });

  it("escapes the series' item in the private summary", async () => {
    ledger = makeLedger([{ ...structuredClone(SERIES), item: "<!channel> & co" }]);
    const h = make();
    await h.handleCardAction({ payload: chooserPress(await openChooser(h), SERIES_ALL_ACTION), client });
    expect(JSON.parse(fetchSpy.mock.calls.at(-1)[1].body).text).toBe("🚫 Cancelled 3 dates of &lt;!channel&gt; &amp; co · every Sat until Sat 11/7.");
  });

  it("Just one date cancels only that date, leaves the others and keeps the line's Cancel", async () => {
    const h = make();
    const chooser = await openChooser(h);
    await h.handleCardAction({ payload: chooserPress(chooser, SERIES_ONE_ACTION, { selected_option: { value: JSON.stringify({ d: "2026-10-31" }) } }), client });
    expect(adapters.rooms.cancel.mock.calls).toEqual([[LIVE_REFS[1]]]);
    expect(ledger.dropSeriesRefs).toHaveBeenCalledWith("U9", SERIES_ID, [refKey(LIVE_REFS[1])]);
    expect(ledger.state.series[0].refs.map((r) => r.date)).toEqual(["2026-10-20", "2026-10-24", "2026-11-07"]);
    const [u] = updates();
    expect(u.blocks[2].text.text).toBe("• MPR · every Sat 10/24 – 11/7 (4 dates) · 2:00–4:00 PM · MBS\n🚫 Sat 10/31 cancelled.");
    expect(u.blocks[2].accessory).toEqual(POST.blocks[2].accessory);
    expect(livingDigest.refresh.mock.calls).toEqual([["2026-10-31"]]);
  });

  it("someone else's chooser press is refused", async () => {
    const h = make();
    const chooser = await openChooser(h);
    await h.handleCardAction({ payload: { ...chooserPress(chooser, SERIES_ALL_ACTION), user: { id: "U7" } }, client });
    expect(adapters.rooms.cancel).not.toHaveBeenCalled();
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U7", text: "Only <@U9> can cancel this." })]);
  });

  it("an unconnected member gets the connect prompt; resume finishes the series cancel as them", async () => {
    const connect = makeConnect("none");
    const h = make({ connect });
    const chooser = await openChooser(h);
    await h.handleCardAction({ payload: chooserPress(chooser, SERIES_ALL_ACTION), client });
    expect(adapters.rooms.cancel).not.toHaveBeenCalled();
    const row = connect.authStore.createPending.mock.calls[0][0];
    expect(row).toMatchObject({
      slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES",
      request: { kind: "series-cancel", user: "U9", seriesId: SERIES_ID, which: "all", channel: "CRES", postTs: POST_TS },
    });
    expect(ephemerals()[0]).toMatchObject({ user: "U9", text: "To cancel as you, connect your Google account once. I'll cancel this series as soon as you approve." });
    expect(ephemerals()[0].blocks[1].elements[0]).toMatchObject({ action_id: "reservations_connect_google" });

    client.chat.postEphemeral.mockClear();
    const after = makeConnect("active");
    after.authStore.getPending.mockResolvedValue(row);
    await make({ connect: after }).resume({ pendingId: "P1", client });
    expect(after.authStore.deletePending).toHaveBeenCalledWith("P1");
    expect(adapters.rooms.cancel.mock.calls).toEqual(LIVE_REFS.map((r) => [r, { clients: MEMBER_CLIENTS }]));
    expect(ledger.state.series[0].refs).toEqual([ENDED_REF]);
    expect(updates()[0].blocks[2].text.text).toMatch(/🚫 Series cancelled by <@U9> \(3 dates\)\.$/);
    expect(ephemerals()).toEqual([expect.objectContaining({ channel: "CRES", user: "U9", text: "🚫 Cancelled 3 dates of MPR · every Sat until Sat 11/7." })]);
  });

  it("a revoked grant partway stops, keeps what's left and prompts; resume counts every date", async () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    const connect = makeConnect("active");
    adapters.rooms.cancel.mockImplementation(async (ref) => {
      if (ref.date === "2026-10-31") throw Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });
      return { status: "cancelled", link: "https://rooms/item" };
    });
    const h = make({ connect });
    await h.handleCardAction({ payload: chooserPress(await openChooser(h), SERIES_ALL_ACTION), client });
    expect(adapters.rooms.cancel).toHaveBeenCalledTimes(2);
    expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
    expect(ledger.state.series[0].refs.map((r) => r.date)).toEqual(["2026-10-20", "2026-10-31", "2026-11-07"]);
    expect(client.chat.update).not.toHaveBeenCalled();
    const row = connect.authStore.createPending.mock.calls[0][0];
    expect(row.request).toMatchObject({ kind: "series-cancel", which: "all", done: 1 });
    expect(ephemerals().at(-1).text).toBe("Your Google connection has expired. Connect again and I'll finish cancelling this series as you.");

    adapters.rooms.cancel.mockResolvedValue({ status: "cancelled", link: "https://rooms/item" });
    const after = makeConnect("active");
    after.authStore.getPending.mockResolvedValue(row);
    await make({ connect: after }).resume({ pendingId: "P1", client });
    expect(updates()[0].blocks[2].text.text).toMatch(/🚫 Series cancelled by <@U9> \(3 dates\)\.$/);
    spy.mockRestore();
  });

  it("from \"mine\", a series' Cancel… replaces the list with the chooser", async () => {
    const h = make();
    await h.handleCardAction({ client, payload: {
      type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
      container: { type: "message", message_ts: "300.1", channel_id: "CRES", is_ephemeral: true },
      response_url: "https://hooks.slack/actions/m1",
      actions: [{ action_id: MINE_SERIES_ACTION, value: JSON.stringify({ u: "U9", s: SERIES_ID }) }],
    } });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hooks.slack/actions/m1");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.replace_original).toBe(true);
    const block = body.blocks.find((b) => b.type === "actions");
    expect(JSON.parse(block.block_id)).toEqual({ u: "U9", s: SERIES_ID, pt: POST_TS, c: "CRES" });
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
  });
});
