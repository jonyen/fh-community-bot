// tests/lib/reservation-modal.test.js
import { describe, it, expect } from "vitest";
import { buildEditModal, readEditModal, modalErrors, itemOptions, MODAL_CALLBACK, ITEM_ACTION } from "../../src/lib/reservation-modal.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const SET3 = { label: "Tech Set 3", category: "tech", backend: "rms", calendarId: "t3" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2, SET3] });
const KITCHEN = CATALOG.find((e) => e.label === "Kitchen");
const REQ = { intent: "book", items: [SET2], ambiguous: [], unmatched: [], date: "2026-10-17", toDate: null, start: 840, end: 960, title: "Youth night", ministry: "Youth", appliances: {} };
const WHERE = { user: "U9", channel: "CRES", threadTs: "100.1", cardTs: "100.2" };

const block = (view, id) => view.blocks.find((b) => b.block_id === id);

// What Slack sends back on submit: view.state.values keyed by block and action.
function submitted(view, { items = ["Tech Set 2"], date = "2026-10-18", start = "18:00", end = "20:00", title = "Prayer night", bools = [], counts = {} } = {}) {
  const values = {
    items: { [ITEM_ACTION]: { selected_options: items.map((l) => ({ value: l, text: { type: "plain_text", text: l } })) } },
    date: { date: { selected_date: date } },
    start: { start: { selected_time: start } },
    end: { end: { selected_time: end } },
    title: { title: { value: title } },
  };
  if (block(view, "appliances")) values.appliances = { appliances: { selected_options: bools.map((k) => ({ value: k })) } };
  for (const [k, v] of Object.entries(counts)) values[`count_${k}`] = { [`count_${k}`]: { value: v } };
  return { ...view, state: { values } };
}

describe("buildEditModal", () => {
  it("pre-fills every field from the request", () => {
    const view = buildEditModal({ ...WHERE, req: REQ });
    expect(view).toMatchObject({ type: "modal", callback_id: MODAL_CALLBACK, submit: { text: "Update" } });
    expect(block(view, "items").element).toMatchObject({ type: "multi_external_select", action_id: ITEM_ACTION, initial_options: [{ text: { type: "plain_text", text: "Tech Set 2" }, value: "Tech Set 2" }] });
    expect(block(view, "date").element.initial_date).toBe("2026-10-17");
    expect(block(view, "start").element.initial_time).toBe("14:00");
    expect(block(view, "end").element.initial_time).toBe("16:00");
    expect(block(view, "title").element.initial_value).toBe("Youth night");
    expect(block(view, "appliances")).toBeUndefined();
  });

  it("leaves unknown fields empty", () => {
    const view = buildEditModal({ ...WHERE, req: { ...REQ, items: [], date: null, start: null, end: null, title: null } });
    expect(block(view, "items").element.initial_options).toBeUndefined();
    expect(block(view, "date").element.initial_date).toBeUndefined();
    expect(block(view, "start").element.initial_time).toBeUndefined();
    expect(block(view, "title").element.initial_value).toBeUndefined();
  });

  it("shows kitchen appliances, pre-filled, only for a kitchen request", () => {
    const view = buildEditModal({ ...WHERE, req: { ...REQ, items: [KITCHEN], appliances: { island: true, fridge: 2 } } });
    expect(block(view, "appliances").optional).toBe(true);
    expect(block(view, "appliances").element.initial_options.map((o) => o.value)).toEqual(["island"]);
    expect(block(view, "count_fridge").element.initial_value).toBe("2");
  });
});

describe("readEditModal", () => {
  it("reads the request and where its card is", () => {
    const view = submitted(buildEditModal({ ...WHERE, req: REQ }));
    expect(readEditModal(view, CATALOG)).toEqual({
      ...WHERE,
      req: { intent: "book", items: [SET2], ambiguous: [], unmatched: [], date: "2026-10-18", toDate: null, start: 1080, end: 1200, title: "Prayer night", ministry: "Youth", appliances: {} },
    });
  });

  it("reads kitchen appliances", () => {
    const view = submitted(buildEditModal({ ...WHERE, req: { ...REQ, items: [KITCHEN] } }), { items: ["Kitchen"], bools: ["island", "microwave"], counts: { fridge: "2", freezer: "" } });
    expect(readEditModal(view, CATALOG).req.appliances).toEqual({ island: true, microwave: true, fridge: 2 });
  });
});

describe("modalErrors", () => {
  const view = buildEditModal({ ...WHERE, req: REQ });
  it("is null for a valid submission", () => {
    expect(modalErrors(submitted(view))).toBeNull();
  });
  it("rejects an end that isn't after the start", () => {
    expect(modalErrors(submitted(view, { start: "18:00", end: "17:00" }))).toEqual({ end: "End must be after start." });
    expect(modalErrors(submitted(view, { start: "18:00", end: "18:00" }))).toEqual({ end: "End must be after start." });
  });
  it("reads an end of 00:00 after a later start as midnight", () => {
    expect(modalErrors(submitted(view, { start: "20:00", end: "00:00" }))).toBeNull();
    expect(readEditModal(submitted(view, { start: "20:00", end: "00:00" }), CATALOG).req).toMatchObject({ start: 1200, end: 1440 });
    expect(block(buildEditModal({ ...WHERE, req: { ...REQ, start: 1200, end: 1440 } }), "end").element.initial_time).toBe("00:00");
  });
  it("rejects no items", () => {
    expect(modalErrors(submitted(view, { items: [] }))).toEqual({ items: "Pick what to book." });
  });
});

describe("itemOptions", () => {
  it("matches labels case-insensitively", () => {
    expect(itemOptions(CATALOG, "tech").map((o) => o.value)).toEqual(["Tech Set 2", "Tech Set 3"]);
    expect(itemOptions(CATALOG, "SET 3")).toEqual([{ text: { type: "plain_text", text: "Tech Set 3" }, value: "Tech Set 3" }]);
  });
  it("matches category names too", () => {
    expect(itemOptions(CATALOG, "kitch").map((o) => o.value)).toContain("Kitchen");
    expect(itemOptions(CATALOG, "rooms").length).toBe(CATALOG.filter((e) => e.category === "rooms").length);
  });
  it("caps at 100 options", () => {
    const big = Array.from({ length: 150 }, (_, i) => ({ label: `Ball ${i}`, category: "sports", backend: "rms" }));
    expect(itemOptions(big, "ball")).toHaveLength(100);
  });
});
