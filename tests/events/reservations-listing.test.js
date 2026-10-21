// tests/events/reservations-listing.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { createListingFlow } from "../../src/events/reservations-listing.js";
import { buildCatalog, catalogPromptText, categoryCounts } from "../../src/lib/reservation-catalog.js";
import {
  LIST_SEARCH_ACTION, LIST_CATEGORY_ACTION, LIST_PAGE_ACTION, LIST_ADD_ACTION, LIST_EDIT_ACTION, TRAY_RESERVE_ACTION, TRAY_CLEAR_ACTION,
} from "../../src/lib/reservation-listing.js";
import { FORM_DATE_ACTION, FORM_SAVE_ACTION, FORM_REMOVE_ACTION, FORM_BACK_ACTION, FORM_REPEAT_ACTION } from "../../src/lib/reservation-line-form.js";
import { log } from "../../src/lib/logger.js";

const SETS = Array.from({ length: 9 }, (_, i) => ({ label: `Tech Set ${i + 1}`, category: "tech", backend: "rms", calendarId: `t${i + 1}` }));
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: SETS });
const NOW = new Date("2026-10-20T16:00:00Z"); // Tue 10/20, noon in New York
const URL = "https://hooks.slack/actions/r1";

function makeAdapter(backend) {
  return {
    backend, link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    checkDates: vi.fn(async ({ dates }) => Object.fromEntries(dates.map((d) => [d, { conflicts: [], unavailable: null }]))),
    book: vi.fn(), cancel: vi.fn(),
  };
}

function makeClient() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }), postEphemeral: vi.fn().mockResolvedValue({ ok: true }), update: vi.fn() },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    users: { info: vi.fn(), lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")) },
  };
}

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

const line = (id, o = {}) => ({
  id, item: "Tech Set 1", date: "2026-10-24", start: 600, end: 720, title: "Youth night", appliances: {},
  repeat: null, onlyDates: null, progress: {}, ...o,
});
const trayRow = (o = {}) => ({ version: 3, lines: [], view: { q: "", c: "all", p: 0 }, editing: null, running: null, ...o });
const press = (action, values = {}) => ({
  type: "block_actions", user: { id: "U9" }, channel: { id: "CRES" },
  container: { type: "message", message_ts: "300.1", channel_id: "CRES", is_ephemeral: true },
  response_url: URL, actions: [action], state: { values },
});
const sections = (m) => m.blocks.filter((b) => b.type === "section").map((b) => b.text.text);
const elements = (m) => m.blocks.flatMap((b) => [...(b.elements || []), ...(b.accessory ? [b.accessory] : []), ...(b.element ? [b.element] : [])]);

describe("listing flow", () => {
  let llm, adapters, client, trayStore, fetchSpy, h;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue({ intent: "browse", search: null }), matchItems: vi.fn().mockResolvedValue(null) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    trayStore = makeTrayStore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
    h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW, trayStore });
    return () => fetchSpy.mockRestore();
  });
  const ask = (text = "list items to reserve") =>
    h.handleMessage({ event: { type: "message", channel: "CRES", user: "U9", text, ts: "200.1" }, client });
  const act = (action, values) => h.handleCardAction({ payload: press(action, values), client });
  const sent = () => JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
  const stored = () => trayStore.rows.get("U9");

  describe("posting the card", () => {
    it('"list items to reserve" posts a private listing as Reservations, not in a thread, and saves the view', async () => {
      await ask();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      const m = client.chat.postEphemeral.mock.calls[0][0];
      expect(m).toMatchObject({ channel: "CRES", user: "U9", username: "Reservations", icon_emoji: ":calendar:" });
      expect(m.thread_ts).toBeUndefined();
      expect(sections(m)[0]).toBe(`📋 Things you can reserve · ${CATALOG.length} items`);
      expect(stored().view).toEqual({ q: "", c: "all", p: 0 });
      expect(stored().version).toBe(1);
    });

    it("keeps an existing tray's lines and starts the view from the asked search", async () => {
      trayStore.rows.set("U9", trayRow({ lines: [line("L1")], view: { q: "old", c: "rooms", p: 2 } }));
      llm.parseReservationRequest.mockResolvedValue({ intent: "browse", search: "room" });
      await ask("list rooms to reserve");
      expect(stored().view).toEqual({ q: "room", c: "all", p: 0 });
      expect(stored().lines.map((l) => l.id)).toEqual(["L1"]);
      expect(sections(client.chat.postEphemeral.mock.calls[0][0])[0]).toMatch(/^📋 \d+ items match "room"$/);
    });

    it("without a tray table, answers with the category counts and how to book", async () => {
      h = createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => NOW });
      await ask();
      const m = client.chat.postEphemeral.mock.calls[0][0];
      expect(m).toMatchObject({ channel: "CRES", user: "U9", username: "Reservations" });
      expect(m.text).toBe(`${categoryCounts(CATALOG)}\nTo book, post the item, day, time and what it's for.`);
      expect(m.blocks).toBeUndefined();
    });
  });

  describe("search", () => {
    it("asks the model when nothing matches literally, keeps only catalog items, and caches it for paging", async () => {
      llm.matchItems.mockResolvedValue([...SETS.map((s) => s.label), "Bluetooth Speaker"]);
      trayStore.rows.set("U9", trayRow());
      await act({ action_id: LIST_SEARCH_ACTION, value: "speaker" });
      expect(llm.matchItems).toHaveBeenCalledTimes(1);
      expect(llm.matchItems).toHaveBeenCalledWith("speaker", { catalogText: catalogPromptText(CATALOG) });
      let m = sent();
      expect(m.replace_original).toBe(true);
      expect(sections(m)[0]).toBe('📋 9 items match "speaker"');
      expect(JSON.stringify(m)).toContain("I searched for that for you.");
      expect(JSON.stringify(m)).not.toContain("Bluetooth Speaker");
      expect(stored().view).toEqual({ q: "speaker", c: "all", p: 0 });

      await act({ action_id: LIST_PAGE_ACTION, value: "1" });
      m = sent();
      expect(llm.matchItems).toHaveBeenCalledTimes(1);
      expect(sections(m)).toContain("*Tech Set 9* · Tech");
      expect(stored().view.p).toBe(1);
    });

    it("shows nothing matches when the model has no answer, and asks again next time", async () => {
      trayStore.rows.set("U9", trayRow());
      await act({ action_id: LIST_SEARCH_ACTION, value: "speaker" });
      expect(sections(sent()).some((t) => t.startsWith('Nothing matches "speaker".'))).toBe(true);
      expect(sections(sent()).join("\n")).toContain(categoryCounts(CATALOG));
      await act({ action_id: LIST_SEARCH_ACTION, value: "speaker" });
      expect(llm.matchItems).toHaveBeenCalledTimes(2);
    });

    it("treats a model failure as nothing matches and does not cache it", async () => {
      llm.matchItems.mockRejectedValueOnce(new Error("overloaded")).mockResolvedValueOnce(["Tech Set 1"]);
      trayStore.rows.set("U9", trayRow());
      await act({ action_id: LIST_SEARCH_ACTION, value: "Speaker" });
      expect(sections(sent()).some((t) => t.startsWith('Nothing matches "Speaker".'))).toBe(true);
      await act({ action_id: LIST_SEARCH_ACTION, value: "speaker" });
      expect(sections(sent())[0]).toBe('📋 1 items match "speaker"');
      expect(llm.matchItems).toHaveBeenCalledTimes(2);
    });

    it("does not ask the model when the search matches literally or is empty", async () => {
      trayStore.rows.set("U9", trayRow());
      await act({ action_id: LIST_SEARCH_ACTION, value: "tech" });
      expect(sections(sent())[0]).toBe('📋 9 items match "tech"');
      await act({ action_id: LIST_SEARCH_ACTION, value: "" });
      expect(llm.matchItems).not.toHaveBeenCalled();
    });

    it("cuts the search to 60 characters", async () => {
      trayStore.rows.set("U9", trayRow());
      await act({ action_id: LIST_SEARCH_ACTION, value: "x".repeat(80) });
      expect(stored().view.q).toBe("x".repeat(60));
    });

    it("a category change keeps the typed search and goes to the first page", async () => {
      trayStore.rows.set("U9", trayRow({ view: { q: "", c: "all", p: 1 } }));
      await act(
        { action_id: LIST_CATEGORY_ACTION, selected_option: { value: "tech" } },
        { list_search: { [LIST_SEARCH_ACTION]: { type: "plain_text_input", value: "set 1" } } },
      );
      expect(stored().view).toEqual({ q: "set 1", c: "tech", p: 0 });
      expect(sections(sent())[0]).toBe('📋 1 items match "set 1"');
    });
  });

  describe("the tray", () => {
    const L1 = line("L1", { repeat: { days: [6], until: "2026-11-07" } });
    beforeEach(() => {
      trayStore.rows.set("U9", trayRow({ lines: [L1], view: { q: "tech", c: "all", p: 1 } }));
      adapters.rms.checkDates.mockImplementation(async ({ dates }) => Object.fromEntries(dates.map((d) => [d, {
        conflicts: d === "2026-10-31" ? [{ item: "Tech Set 2", date: d, start: 600, end: 700, holder: "Alan <Chow>", holderEmail: null }] : [],
        unavailable: null,
      }])));
    });

    it("Add opens the form pre-filled from the last line; picking a date checks once; Save returns to the same page and search", async () => {
      await act({ action_id: LIST_ADD_ACTION, value: "Tech Set 2" });
      let m = sent();
      const date = elements(m).find((e) => e.action_id === FORM_DATE_ACTION);
      expect(date.initial_date).toBe("2026-10-24");
      expect(elements(m).find((e) => e.action_id === "title").initial_value).toBe("Youth night");
      expect(elements(m).some((e) => e.action_id === FORM_REMOVE_ACTION)).toBe(false);
      expect(stored().editing).toMatchObject({ item: "Tech Set 2", date: "2026-10-24", title: "Youth night" });

      adapters.rms.checkDates.mockClear();
      const values = { form_when: { [FORM_DATE_ACTION]: { type: "datepicker", selected_date: "2026-10-31" } }, title: { title: { type: "plain_text_input", value: "Youth night" } } };
      await act({ action_id: FORM_DATE_ACTION, selected_date: "2026-10-31" }, values);
      expect(adapters.rms.checkDates).toHaveBeenCalledTimes(1);
      expect(adapters.rms.checkDates).toHaveBeenCalledWith({
        dates: ["2026-10-31", "2026-11-07"], start: 600, end: 720, items: [CATALOG.find((e) => e.label === "Tech Set 2")],
      });
      m = sent();
      expect(sections(m).join("\n")).toContain("⚠️ 1 of 2 dates taken: Sat 10/31 (Alan &lt;Chow&gt;)");
      expect(stored().editing.date).toBe("2026-10-31");

      await act({ action_id: FORM_SAVE_ACTION, value: FORM_SAVE_ACTION }, values);
      m = sent();
      expect(sections(m)[0]).toBe('📋 9 items match "tech"');
      expect(JSON.stringify(m)).toContain("Page 2 of 2");
      expect(sections(m)).toContain("*Your tray (2)*");
      expect(stored().lines.map((l) => l.item)).toEqual(["Tech Set 1", "Tech Set 2"]);
      expect(stored().lines[1].date).toBe("2026-10-31");
      expect(stored().editing).toBeNull();
      expect(stored().view).toEqual({ q: "tech", c: "all", p: 1 });
    });

    it("shows each tray line's check in the listing", async () => {
      await act({ action_id: LIST_PAGE_ACTION, value: "0" });
      const row = sections(sent()).find((t) => t.startsWith("Tech Set 1 ·"));
      expect(row).toContain(" · ⚠️ 1 of 3 dates taken: Sat 10/31 (Alan &lt;Chow&gt;)");
    });

    it("Back discards the draft", async () => {
      await act({ action_id: LIST_ADD_ACTION, value: "Tech Set 2" });
      await act({ action_id: FORM_BACK_ACTION, value: FORM_BACK_ACTION });
      expect(stored().lines.map((l) => l.id)).toEqual(["L1"]);
      expect(stored().editing).toBeNull();
      expect(sections(sent())[0]).toBe('📋 9 items match "tech"');
    });

    it("Edit opens the line with Remove, and Remove drops it", async () => {
      await act({ action_id: LIST_EDIT_ACTION, value: "L1" });
      expect(elements(sent()).some((e) => e.action_id === FORM_REMOVE_ACTION)).toBe(true);
      await act({ action_id: FORM_REMOVE_ACTION, value: "L1" });
      expect(stored().lines).toEqual([]);
      expect(stored().editing).toBeNull();
      expect(JSON.stringify(sent())).not.toContain("Your tray");
    });

    it("Save of an edited line replaces it in place", async () => {
      await act({ action_id: LIST_EDIT_ACTION, value: "L1" });
      await act({ action_id: FORM_SAVE_ACTION }, { title: { title: { type: "plain_text_input", value: "Fall rally" } } });
      expect(stored().lines).toHaveLength(1);
      expect(stored().lines[0]).toMatchObject({ id: "L1", title: "Fall rally" });
    });

    it("switching to Just once re-renders the form without the repeat", async () => {
      await act({ action_id: LIST_EDIT_ACTION, value: "L1" });
      await act({ action_id: FORM_REPEAT_ACTION }, { form_repeat: { [FORM_REPEAT_ACTION]: { type: "radio_buttons", selected_option: { value: "none" } } } });
      expect(stored().editing.repeat).toBeNull();
      expect(sent().blocks.some((b) => b.block_id === "form_days")).toBe(false);
    });

    it("an 11th Add says the tray is full", async () => {
      trayStore.rows.set("U9", trayRow({ lines: Array.from({ length: 10 }, (_, i) => line(`L${i}`)) }));
      await act({ action_id: LIST_ADD_ACTION, value: "Tech Set 2" });
      expect(sections(sent())[0]).toBe("Your tray is full (10 lines). Reserve or remove some first.");
      expect(stored().editing).toBeNull();
    });

    it("Clear empties the tray", async () => {
      await act({ action_id: TRAY_CLEAR_ACTION, value: "all" });
      expect(stored().lines).toEqual([]);
      expect(sections(sent())[0]).toBe("Tray cleared.");
    });

  });

  it("a press on an expired tray shows a fresh listing with the expiry notice", async () => {
    await act({ action_id: LIST_PAGE_ACTION, value: "1" });
    expect(sections(sent())[0]).toBe("Your tray expired after a day without changes, so it was cleared.");
    expect(stored()).toMatchObject({ lines: [], view: { q: "", c: "all", p: 0 } });
  });

  it("re-applies a press once after losing a race, then gives up with a notice", async () => {
    trayStore.rows.set("U9", trayRow());
    trayStore.putTray.mockResolvedValueOnce(false);
    await act({ action_id: LIST_SEARCH_ACTION, value: "tech" });
    expect(trayStore.getTray).toHaveBeenCalledTimes(2);
    expect(stored().view.q).toBe("tech");

    trayStore.putTray.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await act({ action_id: LIST_SEARCH_ACTION, value: "room" });
    expect(sections(sent())[0]).toBe("Something changed. Please try again.");
    expect(stored().view.q).toBe("tech");
  });

  it("logs a warning when the response_url refuses the reply", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });
    trayStore.rows.set("U9", trayRow());
    await act({ action_id: LIST_PAGE_ACTION, value: "1" });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 404 }));
    warn.mockRestore();
  });
});

describe("lineCheck", () => {
  let adapters, client, flow;
  const KITCHEN = CATALOG.find((e) => e.label === "Kitchen");
  const result = (map) => adapters.rms.checkDates.mockImplementation(async ({ dates }) =>
    Object.fromEntries(dates.map((d) => [d, map[d] || { conflicts: [], unavailable: null }])));
  beforeEach(() => {
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
    const withMentions = (c, rs) => Promise.all(rs.map(async (r) => (r.holderEmail === "alan@x" ? { ...r, holderUserId: "U5" } : r)));
    flow = createListingFlow({ catalog: CATALOG, adapters, llm: {}, catalogText: "", trayStore: makeTrayStore(), now: () => NOW, withMentions });
  });
  const weekly = (o = {}) => line("L", { repeat: { days: [6], until: "2026-11-07" }, ...o });

  it("is empty when the line can't be checked yet", async () => {
    expect(await flow.lineCheck(line("L", { date: null }), client)).toBe("");
    expect(await flow.lineCheck(line("L", { start: null }), client)).toBe("");
    expect(await flow.lineCheck(line("L", { item: "Gone" }), client)).toBe("");
    expect(await flow.lineCheck(weekly({ repeat: { days: [], until: "2026-11-07" } }), client)).toBe("");
    expect(adapters.rms.checkDates).not.toHaveBeenCalled();
  });

  it("says free for one date and all free for several", async () => {
    expect(await flow.lineCheck(line("L"), client)).toBe("✅ free");
    expect(await flow.lineCheck(weekly(), client)).toBe("✅ all 3 dates free");
  });

  it("names the holder of a taken date, with a mention when it can", async () => {
    result({ "2026-10-24": { conflicts: [{ holder: "Alan Chow", holderEmail: "alan@x" }], unavailable: null } });
    expect(await flow.lineCheck(line("L"), client)).toBe("❌ taken by <@U5>");
  });

  it("lists at most 5 taken dates", async () => {
    const taken = {};
    for (const d of ["2026-10-24", "2026-10-31", "2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"]) taken[d] = { conflicts: [{ holder: "Joe & Co" }], unavailable: null };
    result(taken);
    const text = await flow.lineCheck(weekly({ repeat: { days: [6], until: "2026-12-05" } }), client);
    expect(text).toBe("⚠️ 6 of 7 dates taken: Sat 10/24 (Joe &amp; Co), Sat 10/31 (Joe &amp; Co), Sat 11/7 (Joe &amp; Co), Sat 11/14 (Joe &amp; Co), Sat 11/21 (Joe &amp; Co), …");
  });

  it("gives the backend's reason when a date can't be booked", async () => {
    adapters.kitchen.checkDates.mockResolvedValue({ "2026-10-24": { conflicts: [], unavailable: "The kitchen sheet is not open yet for that date." } });
    expect(await flow.lineCheck(line("L", { item: KITCHEN.label }), client)).toBe("⚠️ The kitchen sheet is not open yet for that date.");
  });

  it("is empty, with a warning, when the check fails", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    adapters.rms.checkDates.mockRejectedValue(new Error("boom"));
    expect(await flow.lineCheck(line("L"), client)).toBe("");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
