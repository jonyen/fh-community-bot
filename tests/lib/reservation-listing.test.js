// tests/lib/reservation-listing.test.js
import { describe, it, expect } from "vitest";
import {
  listingMessage, filterCatalog, PAGE_SIZE, LISTING_ACTIONS,
  LIST_ADD_ACTION, LIST_EDIT_ACTION, LIST_PAGE_ACTION, LIST_SEARCH_ACTION, TRAY_RESERVE_ACTION, TRAY_CLEAR_ACTION, LIST_CLOSE_ACTION,
} from "../../src/lib/reservation-listing.js";

const CATALOG = [
  { label: "MPR", category: "rooms", backend: "rooms" },
  { label: "Youth Room", category: "rooms", backend: "rooms" },
  { label: "Kitchen", category: "kitchen", backend: "kitchen" },
  ...Array.from({ length: 21 }, (_, i) => ({ label: `Tech Set ${i + 1}`, category: "tech", backend: "rms" })),
];
const items = (n) => CATALOG.slice(0, n);
const view = (o = {}) => ({ q: "", c: "all", p: 0, ...o });
const line = (i, o = {}) => ({ id: `L${i}`, item: `Tech Set ${i}`, date: "2026-10-24", start: 600, end: 720, title: "Youth night", appliances: {}, repeat: null, onlyDates: null, progress: {}, ...o });
const msg = (o = {}) => listingMessage({ items: items(8), total: 24, view: view(), categories: ["rooms", "kitchen", "tech"], tray: [], lineStatus: {}, ...o });
const sections = (m) => m.blocks.filter((b) => b.type === "section");
const buttons = (m) => m.blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements);

describe("listingMessage", () => {
  it("has the search box, the category select and a header with the total", () => {
    const m = msg();
    expect(sections(m)[0].text.text).toBe("📋 Things you can reserve · 24 items");
    const search = m.blocks.find((b) => b.block_id === "list_search");
    expect(search).toMatchObject({ type: "input", dispatch_action: true, element: { action_id: LIST_SEARCH_ACTION, max_length: 60, dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] } } });
    const select = buttons(m).find((e) => e.type === "static_select");
    expect(select.options.map((o) => o.text.text)).toEqual(["All categories", "Rooms", "Kitchen", "Tech"]);
    expect(LISTING_ACTIONS.has(LIST_SEARCH_ACTION)).toBe(true);
  });

  it("page 2 of 3 has 8 items, Prev and Next", () => {
    const m = msg({ view: view({ p: 1 }), total: 24 });
    expect(sections(m).filter((b) => b.accessory?.action_id === LIST_ADD_ACTION)).toHaveLength(PAGE_SIZE);
    const nav = buttons(m).filter((e) => e.action_id === LIST_PAGE_ACTION);
    expect(nav.map((e) => [e.text.text, e.value])).toEqual([["◀ Prev", "0"], ["Next ▶", "2"]]);
    expect(JSON.stringify(m.blocks)).toContain("Page 2 of 3");
  });

  it("the last page has no Next and the first no Prev", () => {
    const last = buttons(msg({ view: view({ p: 2 }) })).filter((e) => e.action_id === LIST_PAGE_ACTION);
    expect(last.map((e) => e.text.text)).toEqual(["◀ Prev"]);
    const first = buttons(msg()).filter((e) => e.action_id === LIST_PAGE_ACTION);
    expect(first.map((e) => e.text.text)).toEqual(["Next ▶"]);
  });

  it("ends every page with Close, even when nothing matches", () => {
    const close = (m) => buttons(m).filter((e) => e.action_id === LIST_CLOSE_ACTION);
    expect(close(msg()).map((e) => e.text.text)).toEqual(["Close"]);
    expect(close(msg({ view: view({ p: 1 }) }))).toHaveLength(1);
    expect(close(msg({ items: [], total: 0, view: view({ q: "zzz" }), catalog: CATALOG }))).toHaveLength(1);
    expect(LISTING_ACTIONS.has(LIST_CLOSE_ACTION)).toBe(true);
  });

  it("an added item shows Added with its line id; others offer + Add with the label", () => {
    const m = msg({ tray: [line(1, { item: "MPR", id: "abc" })] });
    const [mpr, youth] = sections(m).filter((b) => b.accessory);
    expect(mpr.text.text).toBe("*MPR* · Rooms");
    expect(mpr.accessory).toMatchObject({ action_id: LIST_EDIT_ACTION, value: "abc", text: { text: "✓ Added" } });
    expect(youth.accessory).toMatchObject({ action_id: LIST_ADD_ACTION, value: "Youth Room", text: { text: "+ Add" } });
  });

  it("escapes the search in the header and cuts it to 60", () => {
    const m = msg({ view: view({ q: "<!channel> *x*" }), total: 2 });
    expect(sections(m)[0].text.text).toBe('📋 2 items match "&lt;!channel&gt; *x*"');
    const long = msg({ view: view({ q: "a".repeat(70) }), total: 2 });
    expect(sections(long)[0].text.text).toContain(`"${"a".repeat(60)}"`);
    expect(sections(long)[0].text.text).not.toContain("a".repeat(61));
    expect(long.blocks.find((b) => b.block_id === "list_search").element.initial_value).toBe("a".repeat(60));
  });

  it("escapes the search in the fallback text too", () => {
    expect(msg({ view: view({ q: "<!channel>" }), total: 1 }).text).toBe('1 items match "&lt;!channel&gt;"');
  });

  it("names the category when it is empty and nothing was searched", () => {
    const m = msg({ items: [], total: 0, view: view({ c: "tech" }), catalog: CATALOG.slice(0, 3) });
    const t = sections(m).map((b) => b.text.text).join("\n");
    expect(t).toContain("Nothing to reserve in Tech.");
    expect(t).not.toContain('Nothing matches ""');
  });

  it("says nothing matches, with what exists", () => {
    const m = msg({ items: [], total: 0, view: view({ q: "zzz" }), catalog: CATALOG });
    expect(sections(m).map((b) => b.text.text).join("\n")).toContain('Nothing matches "zzz" in any of the reservation lists.');
    expect(sections(m).map((b) => b.text.text).join("\n")).toContain("Rooms (2) · Kitchen (1) · Tech (21)");
  });

  it("shows no tray when it is empty, and the tray with status, Edit, Reserve all and Clear when not", () => {
    expect(JSON.stringify(msg().blocks)).not.toContain("Your tray");
    const m = msg({ tray: [line(1), line(2)], lineStatus: { L1: "✅ Free", L2: "❌ Taken" } });
    const texts = sections(m).map((b) => b.text.text);
    expect(texts).toContain("*Your tray (2)*");
    expect(texts.some((t) => t.startsWith("Tech Set 1 · Sat 10/24") && t.endsWith(" · ✅ Free"))).toBe(true);
    const edits = sections(m).filter((b) => b.accessory?.text?.text === "Edit");
    expect(edits.map((b) => [b.accessory.action_id, b.accessory.value])).toEqual([[LIST_EDIT_ACTION, "L1"], [LIST_EDIT_ACTION, "L2"]]);
    const all = buttons(m).find((e) => e.action_id === TRAY_RESERVE_ACTION);
    expect(all).toMatchObject({ text: { text: "Reserve all" }, style: "primary" });
    expect(buttons(m).find((e) => e.action_id === TRAY_CLEAR_ACTION).confirm).toBeTruthy();
  });

  it("escapes tray titles and puts a notice first", () => {
    const m = msg({ tray: [line(1, { title: "<!here>" })], notice: "Saved." });
    expect(sections(m)[0].text.text).toBe("Saved.");
    expect(JSON.stringify(m.blocks)).toContain("&lt;!here&gt;");
  });

  it("stays within 50 blocks with 8 items and a 10-line tray", () => {
    const tray = Array.from({ length: 10 }, (_, i) => line(i + 1));
    const m = msg({ tray, notice: "x", view: view({ p: 1 }) });
    expect(m.blocks.length).toBeLessThanOrEqual(50);
    expect(typeof m.text).toBe("string");
  });
});

describe("filterCatalog", () => {
  it("matches a room by alias, case-insensitively", () => {
    expect(filterCatalog(CATALOG, { q: "Multipurpose Room", c: "all" }).map((e) => e.label)).toEqual(["MPR"]);
  });
  it("matches by category name and narrows by category id", () => {
    expect(filterCatalog(CATALOG, { q: "tech", c: "all" })).toHaveLength(21);
    expect(filterCatalog(CATALOG, { q: "", c: "rooms" }).map((e) => e.label)).toEqual(["MPR", "Youth Room"]);
    expect(filterCatalog(CATALOG, { q: "set 2", c: "tech" }).map((e) => e.label)).toContain("Tech Set 2");
    expect(filterCatalog(CATALOG, { q: "", c: "all" })).toHaveLength(24);
  });
});
