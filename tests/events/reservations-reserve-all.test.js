// tests/events/reservations-reserve-all.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { TRAY_RESERVE_ACTION } from "../../src/lib/reservation-listing.js";
import { COMBINED_EVENT_TYPE } from "../../src/lib/reservation-combined.js";
import { log } from "../../src/lib/logger.js";
import { createRmsAdapter } from "../../src/services/reservations/rms.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
const NOW = new Date("2026-10-20T16:00:00Z"); // Tue 10/20, noon in New York
const URL = "https://hooks.slack/actions/r1";
const MEMBER_CLIENTS = { sheetsClient: { kind: "member-sheets" }, calendarClient: { kind: "member-cal" } };
const POST_TS = "500.1";

const free = (dates) => Object.fromEntries(dates.map((d) => [d, { conflicts: [], unavailable: null }]));

function makeAdapter(backend) {
  return {
    backend, link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    checkDates: vi.fn(async ({ dates }) => free(dates)),
    bookMany: vi.fn(async (bookings) => bookings.map((b) => ({
      status: "booked", link: `https://${backend}/x`, ref: { backend, date: b.date, id: `${backend}-${b.date}` },
    }))),
    book: vi.fn(), cancel: vi.fn(),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: POST_TS }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn(),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555", email: "deandra@acts2.network" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

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

function makeLedger() {
  return { recordBooking: vi.fn().mockResolvedValue(), recordSeries: vi.fn().mockResolvedValue(), bookingsFor: vi.fn().mockResolvedValue([]) };
}

function makeConnect(status = "active") {
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
    consentUrl: vi.fn(({ state }) => `https://accounts.google.com/auth?state=${state}`),
  };
}

const line = (id, o = {}) => ({
  id, item: "Tech Set 2", date: "2026-10-24", start: 600, end: 720, title: "Youth night", appliances: {},
  repeat: null, onlyDates: null, progress: {}, ...o,
});
const mprRepeat = (o = {}) => line("L1", { item: "MPR", start: 840, end: 960, title: "MBS", repeat: { days: [6], until: "2026-11-14" }, ...o });
const trayRow = (o = {}) => ({ version: 3, lines: [], view: { q: "", c: "all", p: 0 }, editing: null, running: null, ...o });
const press = (actionTs = "1700000000.123") => ({
  type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
  container: { type: "message", message_ts: "300.1", channel_id: "CRES", is_ephemeral: true },
  response_url: URL, actions: [{ action_id: TRAY_RESERVE_ACTION, value: "all", action_ts: actionTs }], state: { values: {} },
});
const sections = (m) => m.blocks.filter((b) => b.type === "section").map((b) => b.text.text);
const RUN = "1700000000.123";

describe("Reserve all", () => {
  let adapters, client, trayStore, ledger, livingDigest, connect, fetchSpy;
  beforeEach(() => {
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    trayStore = makeTrayStore();
    ledger = makeLedger();
    livingDigest = { refresh: vi.fn().mockResolvedValue(true) };
    connect = makeConnect("active");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
    return () => fetchSpy.mockRestore();
  });
  const handler = (o = {}) => createReservationsHandler({
    llm: { parseReservationRequest: vi.fn(), matchItems: vi.fn().mockResolvedValue(null) },
    adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, connect, livingDigest, ledger, trayStore, ...o,
  });
  const reserve = (h = handler(), actionTs) => h.handleCardAction({ payload: press(actionTs), client });
  const sent = () => JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
  const stored = () => trayStore.rows.get("U9");
  const publicPosts = () => client.chat.postMessage.mock.calls.map((c) => c[0]);
  const ephemerals = () => client.chat.postEphemeral.mock.calls.map((c) => c[0]);

  it("books a mixed tray once per backend, posts one combined message, records the ledger and keeps only the taken date", async () => {
    trayStore.rows.set("U9", trayRow({
      lines: [
        mprRepeat(),
        line("L2"),
        line("L3", { item: "Kitchen", date: "2026-10-22", start: 1020, end: 1140, title: "Dinner", appliances: { oven: true } }),
      ],
    }));
    adapters.rooms.checkDates.mockImplementation(async ({ dates }) => ({
      ...free(dates),
      "2026-10-31": { conflicts: [{ holder: "Alan", title: "Fall rally", date: "2026-10-31", start: 840, end: 960 }], unavailable: null },
    }));
    await reserve();

    for (const a of Object.values(adapters)) expect(a.bookMany).toHaveBeenCalledTimes(1);
    const rooms = adapters.rooms.bookMany.mock.calls[0];
    expect(rooms[0].map((b) => b.date)).toEqual(["2026-10-24", "2026-11-07", "2026-11-14"]);
    expect(rooms[0][0]).toMatchObject({
      start: 840, end: 960, title: "MBS", items: [CATALOG.find((e) => e.label === "MPR")],
      requesterName: "Deandra", requesterUserId: "U9", phone: "555",
    });
    expect(rooms[1]).toEqual({ clients: MEMBER_CLIENTS });
    expect(adapters.rms.bookMany.mock.calls[0][0]).toEqual([expect.objectContaining({ date: "2026-10-24", items: [SET2] })]);
    expect(adapters.kitchen.bookMany.mock.calls[0][0]).toEqual([expect.objectContaining({ date: "2026-10-22", appliances: { oven: true } })]);

    expect(publicPosts()).toHaveLength(1);
    const post = publicPosts()[0];
    expect(post).toMatchObject({ channel: "CRES", username: "Reservations (beta)" });
    expect(post.thread_ts).toBeUndefined();
    expect(post.metadata.event_type).toBe(COMBINED_EVENT_TYPE);
    const text = sections(post).join("\n");
    expect(text).toContain("MPR · every Sat 10/24 – 11/14 (3 dates) · 2:00–4:00 PM · MBS");
    expect(text).toContain("Tech Set 2 · Sat 10/24 · 10:00 AM–12:00 PM · Youth night");
    expect(text).toContain("Kitchen · Thu 10/22 · 5:00–7:00 PM · Dinner");
    expect(text).toContain("Not booked");
    expect(text).toContain("MPR · Sat 10/31 · 2:00–4:00 PM (Alan · Fall rally)");

    expect(ledger.recordSeries).toHaveBeenCalledTimes(1);
    expect(ledger.recordSeries).toHaveBeenCalledWith("U9", expect.objectContaining({
      id: `L1-${RUN}`, item: "MPR", start: 840, end: 960, title: "MBS", repeat: { days: [6], until: "2026-11-14" },
      channel: "CRES", postTs: POST_TS, refs: ["2026-10-24", "2026-11-07", "2026-11-14"].map((d) => ({ backend: "rooms", date: d, id: `rooms-${d}` })),
    }), { today: "2026-10-20" });
    expect(ledger.recordBooking).toHaveBeenCalledTimes(2);
    expect(ledger.recordBooking).toHaveBeenCalledWith("U9", { backend: "rms", date: "2026-10-24", id: "rms-2026-10-24" }, { today: "2026-10-20" });
    expect(ledger.recordBooking).toHaveBeenCalledWith("U9", { backend: "kitchen", date: "2026-10-22", id: "kitchen-2026-10-22" }, { today: "2026-10-20" });

    // Periods: Mon 10/19 (kitchen), weekends of 10/23, 11/6 and 11/13.
    expect(livingDigest.refresh).toHaveBeenCalledTimes(4);

    const tray = stored();
    expect(tray.running).toBeNull();
    expect(tray.lines).toHaveLength(1);
    expect(tray.lines[0]).toMatchObject({ id: "L1", onlyDates: ["2026-10-31"], progress: {} });

    const card = sent();
    expect(card.replace_original).toBe(true);
    expect(sections(card)[0]).toContain("✅ Reserved 5 bookings. It's posted in the channel.");
    expect(sections(card)[0]).toContain("MPR · Sat 10/31 · 2:00–4:00 PM (Alan · Fall rally)");
    // Something was booked, so the card closes: the result, no buttons.
    expect(card.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: expect.stringContaining("✅ Reserved 5 bookings.") } }]);
  });

  it("posts nothing publicly when nothing is free", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    adapters.rms.checkDates.mockResolvedValue({ "2026-10-24": { conflicts: [{ holder: "Alan", title: "Rally" }], unavailable: null } });
    await reserve();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(sections(sent())[0]).toContain("Nothing could be booked.");
    // Nothing booked: the listing stays open so the tray can be fixed.
    expect(sent().blocks.length).toBeGreaterThan(1);
    expect(livingDigest.refresh).not.toHaveBeenCalled();
    expect(stored().lines.map((l) => l.id)).toEqual(["L2"]);
    expect(stored().running).toBeNull();
  });

  it("refuses an incomplete tray, naming the line, and books nothing", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2", { title: null }), line("L3", { item: "MPR" })] }));
    await reserve();
    expect(sections(sent())[0]).toBe("Can't reserve yet:\n• Tech Set 2: Add what it's for.");
    for (const a of Object.values(adapters)) expect(a.bookMany).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(stored().running).toBeNull();
  });

  it("skips a line whose item left the catalog and books the rest", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2", { item: "Old Bus" }), line("L3", { item: "MPR" })] }));
    await reserve();
    expect(adapters.rooms.bookMany).toHaveBeenCalledTimes(1);
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("MPR · Sat 10/24");
    expect(text).toContain("Old Bus can no longer be booked.");
    expect(stored().lines.map((l) => l.id)).toEqual(["L2"]);
  });

  it("a second press while the first is running says it's already reserving", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")], running: { runId: "other", at: NOW.getTime() - 60_000 } }));
    await reserve();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(ephemerals().at(-1)).toMatchObject({ channel: "CRES", user: "U9", text: "Already reserving your tray. One moment." });
    expect(stored().running.runId).toBe("other");
  });

  it("takes over a run that started more than 15 minutes ago", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")], running: { runId: "other", at: NOW.getTime() - 16 * 60_000 } }));
    await reserve();
    expect(adapters.rms.bookMany).toHaveBeenCalledTimes(1);
  });

  it("a redelivered run with the same runId skips done dates, reports started ones and takes them out of the tray", async () => {
    trayStore.rows.set("U9", trayRow({
      running: { runId: RUN, at: NOW.getTime() - 60_000 },
      lines: [mprRepeat({
        progress: { "2026-10-24": "done", "2026-10-31": "started" },
        claims: { "2026-10-24": RUN, "2026-10-31": RUN },
        booked: { "2026-10-24": { backend: "rooms", date: "2026-10-24", id: "rooms-2026-10-24" } },
      })],
    }));
    await reserve();
    expect(adapters.rooms.bookMany).toHaveBeenCalledTimes(1);
    expect(adapters.rooms.bookMany.mock.calls[0][0].map((b) => b.date)).toEqual(["2026-11-07", "2026-11-14"]);
    const text = sections(publicPosts()[0]).join("\n");
    // The crashed run's booking is posted by whichever run finishes.
    expect(text).toContain("MPR · every Sat 10/24 – 11/14 (3 dates)");
    expect(text).toContain("MPR · Sat 10/31 · may already be booked, please check before booking again");
    expect(ledger.recordSeries.mock.calls[0][1].refs.map((r) => r.date)).toEqual(["2026-10-24", "2026-11-07", "2026-11-14"]);
    // Ruling P2: a date that may already be booked is never tried again.
    expect(stored().lines).toEqual([]);
    expect(stored().running).toBeNull();
  });

  it("marks dates started before writing and done after", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    adapters.rms.bookMany.mockImplementation(async (bookings) => {
      expect(trayStore.rows.get("U9").lines[0].progress).toEqual({ "2026-10-24": "started" });
      return bookings.map((b) => ({ status: "booked", link: "x", ref: { backend: "rms", date: b.date } }));
    });
    const puts = [];
    trayStore.putTray.mockImplementation(async (u, tray, { expectVersion }) => {
      puts.push(structuredClone(tray));
      if ((trayStore.rows.get(u)?.version ?? 0) !== expectVersion) return false;
      trayStore.rows.set(u, structuredClone({ ...tray, version: expectVersion + 1 }));
      return true;
    });
    await reserve();
    expect(puts.some((t) => t.lines[0]?.progress?.["2026-10-24"] === "done")).toBe(true);
  });

  it("stops without writing when another run took the tray before a write", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    let calls = 0;
    const real = trayStore.putTray.getMockImplementation();
    trayStore.putTray.mockImplementation(async (u, tray, opts) => {
      calls++;
      // After this run claims the tray, another run takes it over.
      if (calls === 2) trayStore.rows.set(u, { ...trayStore.rows.get(u), version: 99, running: { runId: "other", at: NOW.getTime() } });
      return real(u, tray, opts);
    });
    await reserve();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    // Take the run, one claim that loses; no needless save after.
    expect(trayStore.putTray).toHaveBeenCalledTimes(2);
  });

  it("two overlapping runs post and record every booking exactly once and write nothing twice", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2"), line("L3", { item: "MPR" })] }));
    let entered;
    const inBook = new Promise((r) => { entered = r; });
    let open;
    const gate = new Promise((r) => { open = r; });
    adapters.rms.bookMany.mockImplementation(async (bookings) => {
      entered();
      await gate;
      return bookings.map((b) => ({ status: "booked", link: "x", ref: { backend: "rms", date: b.date, id: "rms-A" } }));
    });
    const h = handler();
    const runA = reserve(h, "A");
    await inBook;
    // A is still writing, but its hold on the tray looks stale; B takes over.
    trayStore.rows.get("U9").running.at = NOW.getTime() - 16 * 60_000;
    await reserve(h, "B");
    open();
    await runA;

    expect(adapters.rms.bookMany).toHaveBeenCalledTimes(1);
    expect(adapters.rooms.bookMany).toHaveBeenCalledTimes(1);
    const posted = publicPosts().map((p) => sections(p).filter((t) => t.startsWith("• ")).join("\n"));
    expect(posted).toHaveLength(2);
    expect(posted.filter((t) => t.includes("Tech Set 2 · Sat 10/24"))).toHaveLength(1);
    expect(posted.filter((t) => t.includes("MPR · Sat 10/24"))).toHaveLength(1);
    expect(ledger.recordBooking).toHaveBeenCalledTimes(2);
    expect(ledger.recordBooking.mock.calls.map((c) => c[1].backend).sort()).toEqual(["rms", "rooms"]);
    expect(stored().lines).toEqual([]);
    expect(stored().running).toBeNull();
    expect(stored().posts ?? null).toBeNull();
  });

  it("a store error before the second backend stops there: what was booked is posted, the rest reported", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L3", { item: "MPR" }), line("L2")] }));
    const real = trayStore.putTray.getMockImplementation();
    let calls = 0;
    trayStore.putTray.mockImplementation(async (u, tray, opts) => {
      calls++;
      // 1 take the run, 2 claim rooms, 3 rooms done, 4 claim rms.
      if (calls === 4) throw new Error("ddb down");
      return real(u, tray, opts);
    });
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    await expect(reserve()).resolves.toBeUndefined();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("MPR · Sat 10/24");
    expect(text).toContain("Tech Set 2 · Sat 10/24 · not booked, please press Reserve all again");
    expect(ledger.recordBooking).toHaveBeenCalledTimes(1);
    expect(stored().lines.map((l) => l.id)).toEqual(["L2"]);
    expect(stored().lines[0].progress).toEqual({});
    expect(stored().running).toBeNull();
    errSpy.mockRestore();
  });

  it("losing every race to the member's own edits stops booking, posts what's done and lets go of the tray", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L3", { item: "MPR" }), line("L2")] }));
    const real = trayStore.putTray.getMockImplementation();
    let calls = 0;
    trayStore.putTray.mockImplementation(async (u, tray, opts) => {
      calls++;
      // Each claim for rms meets a page turn on the listing card.
      if (calls >= 4 && calls <= 6) trayStore.rows.get(u).version += 1;
      return real(u, tray, opts);
    });
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    await reserve();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(sections(publicPosts()[0]).join("\n")).toContain("MPR · Sat 10/24");
    expect(sections(sent())[0]).toContain("Tech Set 2 · Sat 10/24 · not booked, please press Reserve all again");
    expect(stored().running).toBeNull();
    expect(stored().lines.map((l) => l.id)).toEqual(["L2"]);
    errSpy.mockRestore();
  });

  it("a line edited while reserving is not written and is reported", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    const real = trayStore.putTray.getMockImplementation();
    let calls = 0;
    trayStore.putTray.mockImplementation(async (u, tray, opts) => {
      calls++;
      if (calls === 2) {
        const row = trayStore.rows.get(u);
        row.lines[0].title = "Changed";
        row.version += 1;
      }
      return real(u, tray, opts);
    });
    await reserve();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(sections(sent())[0]).toContain("Tech Set 2 · Sat 10/24 · changed while reserving");
    expect(stored().lines[0].title).toBe("Changed");
    expect(stored().running).toBeNull();
  });

  it.each([
    ["the member's profile", (c) => c.users.info.mockRejectedValue(new Error("users down")), "users down"],
    ["the member's Google account", (c, k) => k.memberGoogle.clientsFor.mockRejectedValue(new Error("kms down")), "kms down"],
  ])("can't read %s: tells the member privately and lets go of the tray", async (_, breakIt, message) => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    breakIt(client, connect);
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    await expect(reserve()).resolves.toBeUndefined();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(ephemerals().at(-1)).toMatchObject({ channel: "CRES", user: "U9", text: `⚠️ I couldn't reserve your tray (${message}). Please try again.` });
    expect(stored().running).toBeNull();
    errSpy.mockRestore();
  });

  it("when the final tray save fails, a redelivery neither posts again nor records twice", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    const real = trayStore.putTray.getMockImplementation();
    let failFinish = true;
    trayStore.putTray.mockImplementation(async (u, tray, opts) => {
      if (failFinish && tray.running === null) throw new Error("ddb down");
      return real(u, tray, opts);
    });
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    await reserve();
    expect(publicPosts()).toHaveLength(1);
    expect(ledger.recordBooking).toHaveBeenCalledTimes(1);
    expect(stored().posts[RUN]).toMatchObject({ ts: POST_TS, ledger: true });
    failFinish = false;
    await reserve();
    expect(publicPosts()).toHaveLength(1);
    expect(ledger.recordBooking).toHaveBeenCalledTimes(1);
    expect(adapters.rms.bookMany).toHaveBeenCalledTimes(1);
    expect(stored().lines).toEqual([]);
    expect(stored().running).toBeNull();
    expect(stored().posts).toBeNull();
    errSpy.mockRestore();
  });

  it.each([
    [false, 1],
    [true, 0],
  ])("a redelivery after a crash past the post (ledger written: %s) posts nothing and records only what's missing", async (ledgerDone, writes) => {
    const ref = { backend: "rms", date: "2026-10-24", id: "rms-2026-10-24" };
    trayStore.rows.set("U9", trayRow({
      running: { runId: RUN, at: NOW.getTime() - 60_000 },
      lines: [line("L2", { progress: { "2026-10-24": "done" }, claims: { "2026-10-24": RUN }, booked: { "2026-10-24": ref } })],
      posts: { [RUN]: { ts: POST_TS, ledger: ledgerDone, entries: [{ lineId: "L2", item: "Tech Set 2", start: 600, end: 720, title: "Youth night", repeat: null, refs: [["2026-10-24", ref]] }] } },
    }));
    await reserve();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(ledger.recordBooking).toHaveBeenCalledTimes(writes);
    expect(stored().lines).toEqual([]);
    expect(stored().posts).toBeNull();
    expect(stored().running).toBeNull();
    expect(sections(sent())[0]).toContain("✅ Reserved 1 booking.");
  });

  it("a press with no action_ts runs under its trigger_id", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    const payload = press();
    delete payload.actions[0].action_ts;
    payload.trigger_id = "trig.1";
    await handler().handleCardAction({ payload, client });
    expect(trayStore.putTray.mock.calls[0][1].running.runId).toBe("trig.1");
    expect(adapters.rms.bookMany).toHaveBeenCalledTimes(1);
  });

  it("a calendar failure after the event was made is maybe booked: reported, taken out, never booked again", async () => {
    const cal = {
      events: {
        list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        insert: vi.fn().mockResolvedValue({ data: { id: "E1" } }),
        get: vi.fn().mockRejectedValue(Object.assign(new Error("Rate Limit Exceeded"), { code: 403 })),
        delete: vi.fn(),
      },
    };
    adapters.rms = createRmsAdapter({ calendarClient: cal, catalog: [SET2], sleep: async () => {} });
    connect.memberGoogle.clientsFor.mockResolvedValue({ status: "active", clients: { calendarClient: cal, sheetsClient: {} } });
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    await reserve();
    expect(cal.events.insert).toHaveBeenCalledTimes(1);
    expect(sections(sent())[0]).toContain("Tech Set 2 · Sat 10/24 · couldn't save (the calendar event was made but its answer couldn't be read (Rate Limit Exceeded)), may already be booked, please check before booking again");
    expect(stored().lines).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith("calendar booking failed after its event was made", expect.objectContaining({ eventId: "E1" }));
    await reserve(handler(), "second press");
    expect(cal.events.insert).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("a dead run's leftovers go to the next press: its done dates are posted once, its started ones dropped", async () => {
    const ref = { backend: "rooms", date: "2026-10-24", id: "rooms-2026-10-24-dead" };
    trayStore.rows.set("U9", trayRow({
      running: { runId: "dead", at: NOW.getTime() - 20 * 60_000 },
      lines: [
        mprRepeat({
          progress: { "2026-10-24": "done", "2026-10-31": "started" },
          claims: { "2026-10-24": "dead", "2026-10-31": "dead" },
          booked: { "2026-10-24": ref },
        }),
        line("L2"),
      ],
    }));
    await reserve();
    expect(adapters.rooms.bookMany.mock.calls[0][0].map((b) => b.date)).toEqual(["2026-11-07", "2026-11-14"]);
    expect(adapters.rms.bookMany).toHaveBeenCalledTimes(1);
    expect(publicPosts()).toHaveLength(1);
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("MPR · every Sat 10/24 – 11/14 (3 dates)");
    expect(text).toContain("Tech Set 2 · Sat 10/24");
    expect(text).toContain("MPR · Sat 10/31 · may already be booked, please check before booking again");
    expect(ledger.recordSeries.mock.calls[0][1].refs).toContainEqual(ref);
    expect(stored().lines).toEqual([]);
    expect(stored().running).toBeNull();

    await reserve(handler(), "again");
    expect(publicPosts()).toHaveLength(1);
    expect(ledger.recordSeries).toHaveBeenCalledTimes(1);
  });

  it("a dead run's posted but unrecorded bookings are recorded once and tidied, never posted again", async () => {
    const ref = { backend: "rms", date: "2026-10-24", id: "rms-dead" };
    trayStore.rows.set("U9", trayRow({
      running: null,
      lines: [
        line("L2", { progress: { "2026-10-24": "done" }, claims: { "2026-10-24": "dead" }, booked: { "2026-10-24": ref } }),
        line("L3", { item: "MPR" }),
      ],
      posts: { dead: { ts: "400.1", ledger: false, entries: [{ lineId: "L2", item: "Tech Set 2", start: 600, end: 720, title: "Youth night", repeat: null, refs: [["2026-10-24", ref]] }] } },
    }));
    await reserve();
    expect(adapters.rms.bookMany).not.toHaveBeenCalled();
    expect(ledger.recordBooking).toHaveBeenCalledWith("U9", ref, { today: "2026-10-20" });
    expect(ledger.recordBooking).toHaveBeenCalledTimes(2); // the dead run's, and this run's MPR
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("MPR · Sat 10/24");
    expect(text).not.toContain("Tech Set 2");
    expect(stored().lines).toEqual([]);
    expect(stored().posts).toBeNull();
  });

  describe("a dead run's redelivery", () => {
    const deadRef = { backend: "rms", date: "2026-10-24", id: "rms-by-A" };
    const deadTray = () => trayRow({
      running: { runId: "A", at: NOW.getTime() - 16 * 60_000 },
      lines: [
        line("L2", { progress: { "2026-10-24": "done" }, claims: { "2026-10-24": "A" }, booked: { "2026-10-24": deadRef } }),
        line("L3", { item: "MPR" }),
      ],
    });

    it("arriving while the run that took over is busy, posts and records nothing", async () => {
      trayStore.rows.set("U9", deadTray());
      let entered;
      const inBook = new Promise((r) => { entered = r; });
      let open;
      const gate = new Promise((r) => { open = r; });
      adapters.rooms.bookMany.mockImplementation(async (bookings) => {
        entered();
        await gate;
        return bookings.map((b) => ({ status: "booked", link: "x", ref: { backend: "rooms", date: b.date, id: "rooms-by-L" } }));
      });
      const h = handler();
      const runL = reserve(h, "L");
      await inBook;
      // The take-over already moved A's claims to L and remembered A as ended.
      expect(stored().lines[0].claims).toEqual({ "2026-10-24": "L" });
      expect(stored().ended).toHaveProperty("A");
      const before = { posts: publicPosts().length, eph: ephemerals().length, fetches: fetchSpy.mock.calls.length };
      await reserve(h, "A");
      expect(publicPosts()).toHaveLength(before.posts);
      expect(ephemerals()).toHaveLength(before.eph);
      expect(fetchSpy.mock.calls).toHaveLength(before.fetches);
      open();
      await runL;

      expect(publicPosts()).toHaveLength(1);
      const text = sections(publicPosts()[0]).join("\n");
      expect(text).toContain("Tech Set 2 · Sat 10/24");
      expect(text).toContain("MPR · Sat 10/24");
      expect(ledger.recordBooking).toHaveBeenCalledTimes(2);
      expect(ledger.recordBooking.mock.calls.map((c) => c[1].id).sort()).toEqual(["rms-by-A", "rooms-by-L"]);
      expect(adapters.rms.bookMany).not.toHaveBeenCalled();
      expect(stored().lines).toEqual([]);
    });

    it("arriving after the take-over finished and the member added a line, books and posts nothing", async () => {
      trayStore.rows.set("U9", deadTray());
      const h = handler();
      await reserve(h, "L");
      expect(publicPosts()).toHaveLength(1);
      const row = trayStore.rows.get("U9");
      row.lines.push(line("L4", { item: "Kitchen", date: "2026-10-22", start: 1020, end: 1140, title: "Dinner" }));
      row.version += 1;
      const puts = trayStore.putTray.mock.calls.length;
      await reserve(h, "A");
      // And a redelivery of the finished run L itself.
      await reserve(h, "L");
      expect(adapters.kitchen.bookMany).not.toHaveBeenCalled();
      expect(publicPosts()).toHaveLength(1);
      expect(ledger.recordBooking).toHaveBeenCalledTimes(2);
      expect(trayStore.putTray.mock.calls).toHaveLength(puts);
      expect(stored().lines.map((l) => l.id)).toEqual(["L4"]);
    });
  });

  it("a dead run's leftovers on dates since passed are finished, not refused, and the rest books", async () => {
    const ref = { backend: "rms", date: "2026-10-18", id: "rms-past" };
    trayStore.rows.set("U9", trayRow({
      running: null,
      lines: [
        line("L1", { date: "2026-10-18", progress: { "2026-10-18": "done" }, claims: { "2026-10-18": "dead" }, booked: { "2026-10-18": ref } }),
        line("L2", { item: "Kitchen", date: "2026-10-17", progress: { "2026-10-17": "started" }, claims: { "2026-10-17": "dead" } }),
        line("L3", { item: "MPR" }),
      ],
    }));
    await reserve();
    expect(sections(sent())[0]).not.toContain("Can't reserve yet");
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("Tech Set 2 · Sun 10/18");
    expect(text).toContain("MPR · Sat 10/24");
    expect(text).toContain("Kitchen · Sat 10/17 · may already be booked, please check before booking again");
    expect(ledger.recordBooking).toHaveBeenCalledWith("U9", ref, { today: "2026-10-20" });
    expect(stored().lines).toEqual([]);
  });

  it("a dead run's leftovers are finished even when another line still can't be reserved", async () => {
    const ref = { backend: "rms", date: "2026-10-24", id: "rms-dead" };
    trayStore.rows.set("U9", trayRow({
      running: null,
      lines: [
        line("L1", { progress: { "2026-10-24": "done" }, claims: { "2026-10-24": "dead" }, booked: { "2026-10-24": ref } }),
        line("L3", { item: "MPR", title: null }),
      ],
    }));
    await reserve();
    expect(adapters.rooms.bookMany).not.toHaveBeenCalled();
    expect(sections(publicPosts()[0]).join("\n")).toContain("Tech Set 2 · Sat 10/24");
    const head = sections(sent())[0];
    expect(head).toContain("✅ Reserved 1 booking. It's posted in the channel.");
    expect(head).toContain("Can't reserve yet:\n• MPR: Add what it's for.");
    expect(stored().lines.map((l) => l.id)).toEqual(["L3"]);
    expect(stored().running).toBeNull();
  });

  it("when the public post fails, the private result doesn't claim it was posted", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    client.chat.postMessage.mockRejectedValue(new Error("slack down"));
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    await reserve();
    const head = sections(sent())[0];
    expect(head).toContain("✅ Reserved 1 booking, but I couldn't post them in the channel.");
    expect(head).not.toContain("It's posted");
    errSpy.mockRestore();
  });

  describe("connecting Google", () => {
    it("asks a member who isn't connected to connect, books nothing, and keeps the tray", async () => {
      connect = makeConnect("none");
      trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
      await reserve();
      expect(adapters.rms.bookMany).not.toHaveBeenCalled();
      expect(connect.authStore.createPending).toHaveBeenCalledWith(expect.objectContaining({
        slackUserId: "U9", request: { kind: "tray", user: "U9", channel: "CRES" }, channel: "CRES",
      }));
      const prompt = ephemerals().at(-1);
      expect(prompt).toMatchObject({ channel: "CRES", user: "U9" });
      expect(prompt.thread_ts).toBeUndefined();
      expect(prompt.text).toBe("To book as you, connect your acts2.network Google account once. I'll reserve your tray as soon as you approve.");
      expect(stored().lines.map((l) => l.id)).toEqual(["L2"]);
      expect(stored().running).toBeNull();
    });

    it("after connecting, resume books, posts publicly and replies privately", async () => {
      trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
      connect.authStore.getPending.mockResolvedValue({ slackUserId: "U9", request: { kind: "tray", user: "U9", channel: "CRES" }, channel: "CRES", threadTs: null });
      await handler().resume({ pendingId: "P1", client });
      expect(connect.authStore.deletePending).toHaveBeenCalledWith("P1");
      expect(adapters.rms.bookMany).toHaveBeenCalledTimes(1);
      expect(publicPosts()).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const reply = ephemerals().at(-1);
      expect(reply).toMatchObject({ channel: "CRES", user: "U9" });
      expect(sections(reply)[0]).toContain("✅ Reserved 1 booking. It's posted in the channel.");
      expect(stored().running).toBeNull();
      expect(stored().lines).toEqual([]);
    });

    it("a resume that fails before booking tells the member privately, never throws", async () => {
      connect.authStore.getPending.mockResolvedValue({ slackUserId: "U9", request: { kind: "tray", user: "U9", channel: "CRES" }, channel: "CRES" });
      trayStore.getTray.mockRejectedValue(new Error("ddb down"));
      const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
      await expect(handler().resume({ pendingId: "P1", client })).resolves.toBeUndefined();
      expect(ephemerals().at(-1)).toMatchObject({ channel: "CRES", user: "U9" });
      // The run itself catches a failure to load the tray (nothing is booked yet).
      expect(ephemerals().at(-1).text).toBe("⚠️ Something went wrong. Please try again.");
      errSpy.mockRestore();
    });

    it("a revoked grant partway posts what was booked, marks the member revoked and prompts", async () => {
      trayStore.rows.set("U9", trayRow({ lines: [line("L3", { item: "MPR" }), line("L2")] }));
      adapters.rms.bookMany.mockResolvedValue([{ status: "error", error: "invalid_grant" }]);
      await reserve();
      expect(adapters.rooms.bookMany).toHaveBeenCalledTimes(1);
      expect(publicPosts()).toHaveLength(1);
      expect(sections(publicPosts()[0]).join("\n")).toContain("MPR · Sat 10/24");
      expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
      expect(connect.memberGoogle.forget).toHaveBeenCalledWith("U9");
      expect(connect.authStore.createPending).toHaveBeenCalledWith(expect.objectContaining({ request: { kind: "tray", user: "U9", channel: "CRES" } }));
      expect(ephemerals().at(-1).text).toMatch(/Connect again/);
      expect(stored().lines.map((l) => l.id)).toEqual(["L2"]);
      expect(stored().lines[0].progress).toEqual({});
    });

    it("stops booking further backends once the grant is revoked", async () => {
      trayStore.rows.set("U9", trayRow({ lines: [line("L3", { item: "MPR" }), line("L2")] }));
      adapters.rooms.bookMany.mockResolvedValue([{ status: "error", error: Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }) }]);
      await reserve();
      expect(adapters.rms.bookMany).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(stored().lines.map((l) => l.id)).toEqual(["L3", "L2"]);
    });
  });

  it("forbidden on rooms skips the rooms dates with the access text; the kitchen still books", async () => {
    trayStore.rows.set("U9", trayRow({
      lines: [
        mprRepeat({ repeat: { days: [6], until: "2026-10-31" } }),
        line("L3", { item: "Kitchen", date: "2026-10-22", start: 1020, end: 1140, title: "Dinner" }),
      ],
    }));
    const denied = Object.assign(new Error("The caller does not have permission"), { code: 403 });
    adapters.rooms.bookMany.mockImplementation(async (bookings) => bookings.map(() => ({ status: "error", error: denied })));
    await reserve();
    expect(adapters.kitchen.bookMany).toHaveBeenCalledTimes(1);
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("Kitchen · Thu 10/22");
    expect(text).toContain("You don't have edit access to the room request sheet.");
    // Refused before writing, so the dates stay bookable.
    expect(stored().lines.map((l) => l.id)).toEqual(["L1"]);
    expect(stored().lines[0]).toMatchObject({ progress: {}, claims: {} });
    expect(connect.authStore.markRevoked).not.toHaveBeenCalled();
  });

  it("a write error may have written: reported as maybe booked and taken out of the tray", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    adapters.rms.bookMany.mockResolvedValue([{ status: "error", error: new Error("boom") }]);
    await reserve();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(sections(sent())[0]).toContain("Tech Set 2 · Sat 10/24 · couldn't save (boom), may already be booked, please check before booking again");
    expect(stored().lines).toEqual([]);
  });

  it("the public post names a write error without its raw text", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2"), line("L3", { item: "MPR" })] }));
    adapters.rms.bookMany.mockResolvedValue([{ status: "error", error: new Error("socket hang up") }]);
    await reserve();
    const text = sections(publicPosts()[0]).join("\n");
    expect(text).toContain("Tech Set 2 · Sat 10/24 · couldn't be saved, may already be booked, please check before booking again");
    expect(text).not.toContain("socket hang up");
  });

  it("an unavailable result is skipped with its reason", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L3", { item: "Kitchen", date: "2026-10-22" })] }));
    adapters.kitchen.checkDates.mockResolvedValue({ "2026-10-22": { conflicts: [], unavailable: "The kitchen sheet is not open yet for that date." } });
    await reserve();
    expect(adapters.kitchen.bookMany).not.toHaveBeenCalled();
    expect(sections(sent())[0]).toContain("Kitchen · Thu 10/22 · The kitchen sheet is not open yet for that date.");
  });

  it("an expired response_url falls back to postEphemeral without throwing", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });
    await expect(reserve()).resolves.toBeUndefined();
    const reply = ephemerals().at(-1);
    expect(reply).toMatchObject({ channel: "CRES", user: "U9" });
    expect(reply.thread_ts).toBeUndefined();
    expect(sections(reply)[0]).toContain("✅ Reserved 1 booking.");
  });

  it("failures after a write are logged, never thrown", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    client.chat.postMessage.mockRejectedValue(new Error("slack down"));
    ledger.recordBooking.mockRejectedValue(new Error("ddb down"));
    livingDigest.refresh.mockRejectedValue(new Error("digest down"));
    fetchSpy.mockRejectedValue(new Error("net"));
    client.chat.postEphemeral.mockRejectedValue(new Error("slack down"));
    await expect(reserve()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    expect(stored().lines).toEqual([]);
    errSpy.mockRestore();
  });

  it("logs a warning when a booked ref is too big for its Cancel button", async () => {
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    adapters.rms.bookMany.mockResolvedValue([{ status: "booked", link: "x", ref: { backend: "rms", date: "2026-10-24", pad: "x".repeat(2100) } }]);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await reserve();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cancel/i), expect.anything());
    warn.mockRestore();
  });

  it("books as the bot when connect isn't configured", async () => {
    connect = null;
    trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
    await reserve(handler({ connect: null }));
    expect(adapters.rms.bookMany).toHaveBeenCalledWith([expect.objectContaining({ date: "2026-10-24" })], {});
    expect(publicPosts()).toHaveLength(1);
  });

  describe("final review fixes", () => {
    it("a repeat left over from a partial run can be reserved the next day, though its first date has passed", async () => {
      // MPR every Tue from today (2 PM, still ahead) to 11/3; 10/27 is taken.
      trayStore.rows.set("U9", trayRow({ lines: [mprRepeat({ date: "2026-10-20", repeat: { days: [2], until: "2026-11-03" } })] }));
      adapters.rooms.checkDates.mockImplementation(async ({ dates }) => ({
        ...free(dates),
        ...(dates.includes("2026-10-27") ? { "2026-10-27": { conflicts: [{ holder: "Alan", title: "Rally" }], unavailable: null } } : {}),
      }));
      await reserve();
      expect(adapters.rooms.bookMany.mock.calls[0][0].map((b) => b.date)).toEqual(["2026-10-20", "2026-11-03"]);
      expect(stored().lines[0]).toMatchObject({ date: "2026-10-27", onlyDates: ["2026-10-27"] });

      // The next day 10/27 is free again.
      adapters.rooms.checkDates.mockImplementation(async ({ dates }) => free(dates));
      await reserve(handler({ now: () => new Date("2026-10-21T16:00:00Z") }), "next day");
      expect(sections(sent())[0]).not.toContain("Can't reserve yet");
      expect(adapters.rooms.bookMany).toHaveBeenCalledTimes(2);
      expect(adapters.rooms.bookMany.mock.calls[1][0].map((b) => b.date)).toEqual(["2026-10-27"]);
      expect(stored().lines).toEqual([]);
    });

    it("skips a later line that would book the same thing at an overlapping time as an earlier one", async () => {
      const k = (id, o) => line(id, { item: "Kitchen", date: "2026-10-22", start: 1020, end: 1140, title: "Dinner", ...o });
      trayStore.rows.set("U9", trayRow({
        lines: [
          line("M1", { item: "MPR", start: 840, end: 960 }),
          line("M2", { item: "MPR", start: 900, end: 1000 }),
          line("Y1", { item: "Youth Room", start: 840, end: 960 }),
          line("M3", { item: "MPR", start: 960, end: 1020 }),
          k("K1"), k("K2", { start: 1080, end: 1200 }),
          line("T1"), line("T2", { start: 700, end: 800 }),
        ],
      }));
      await reserve();
      expect(adapters.rooms.bookMany.mock.calls[0][0].map((b) => [b.items[0].label, b.start])).toEqual([["MPR", 840], ["Youth Room", 840], ["MPR", 960]]);
      expect(adapters.kitchen.bookMany.mock.calls[0][0].map((b) => b.start)).toEqual([1020]);
      expect(adapters.rms.bookMany.mock.calls[0][0].map((b) => b.start)).toEqual([600]);
      const notice = sections(sent())[0];
      expect(notice).toContain("MPR · Sat 10/24 · overlaps another line in your tray");
      expect(notice).toContain("Kitchen · Thu 10/22 · overlaps another line in your tray");
      expect(notice).toContain("Tech Set 2 · Sat 10/24 · overlaps another line in your tray");
      expect(stored().lines.map((l) => l.id)).toEqual(["M2", "K2", "T2"]);
    });

    it("a tray that can't be read is told privately, never thrown, and nothing is booked", async () => {
      const err = vi.spyOn(log, "error").mockImplementation(() => {});
      trayStore.getTray.mockRejectedValue(new Error("ddb down"));
      await expect(reserve()).resolves.toBeUndefined();
      expect(ephemerals().at(-1)).toMatchObject({ channel: "CRES", user: "U9", text: "⚠️ Something went wrong. Please try again." });
      for (const a of Object.values(adapters)) expect(a.bookMany).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it("a tray write that fails before booking is told privately, never thrown, and nothing is booked", async () => {
      const err = vi.spyOn(log, "error").mockImplementation(() => {});
      trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
      trayStore.putTray.mockRejectedValue(new Error("ddb down"));
      await expect(reserve()).resolves.toBeUndefined();
      expect(ephemerals().at(-1)).toMatchObject({ text: "⚠️ Something went wrong. Please try again." });
      for (const a of Object.values(adapters)) expect(a.bookMany).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it("with RMS booking off on the bot's calendar, a connected member still books; without connect it is skipped", async () => {
      const cal = {
        events: {
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
          insert: vi.fn().mockResolvedValue({ data: { id: "E1" } }),
          get: vi.fn().mockResolvedValue({ data: { attendees: [{ email: "t2", resource: true, responseStatus: "accepted" }] } }),
          delete: vi.fn(),
        },
      };
      adapters.rms = createRmsAdapter({ calendarClient: cal, catalog: [SET2], bookingEnabled: false, sleep: async () => {} });
      connect.memberGoogle.clientsFor.mockResolvedValue({ status: "active", clients: { calendarClient: cal, sheetsClient: {} } });
      trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
      await reserve();
      expect(cal.events.insert).toHaveBeenCalledTimes(1);

      trayStore.rows.set("U9", trayRow({ lines: [line("L2")] }));
      await reserve(handler({ connect: null }), "bot account");
      expect(cal.events.insert).toHaveBeenCalledTimes(1);
      expect(sections(sent())[0]).toContain("Tech Set 2 · Sat 10/24 · You haven't connected your Google account yet. Connect it to book this as you, or book it yourself in Google Calendar (RMS).");
    });
  });
});
