// tests/lib/reservation-line-form.test.js
import { describe, it, expect } from "vitest";
import {
  lineFormMessage, readLineForm, FORM_SAVE_ACTION, FORM_REMOVE_ACTION, FORM_BACK_ACTION, FORM_DAYS_ACTION,
  FORM_DATE_ACTION, FORM_START_ACTION, FORM_END_ACTION, FORM_REPEAT_ACTION, FORM_UNTIL_ACTION, FORM_ACTIONS,
} from "../../src/lib/reservation-line-form.js";

const ENTRY = { label: "MPR", category: "rooms", backend: "rooms" };
const KITCHEN = { label: "Kitchen", category: "kitchen", backend: "kitchen" };
const LINE = { id: "a1", item: "MPR", date: "2026-10-24", start: 600, end: 720, title: "Youth night", appliances: {}, repeat: null, onlyDates: null, progress: {} };
const form = (o = {}) => lineFormMessage({ line: LINE, entry: ENTRY, check: null, problems: [], ...o });
const els = (m) => m.blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements);
const byId = (m, id) => els(m).find((e) => e.action_id === id);

describe("lineFormMessage", () => {
  it("shows the header, the pickers pre-set from the line, and the title", () => {
    const m = form();
    expect(m.blocks[0].text.text).toBe("📅 *MPR* · Rooms");
    expect(m.blocks.find((b) => b.block_id === "form_when").elements.map((e) => e.action_id)).toEqual([FORM_DATE_ACTION, FORM_START_ACTION, FORM_END_ACTION]);
    expect(byId(m, FORM_DATE_ACTION).initial_date).toBe("2026-10-24");
    expect(byId(m, FORM_START_ACTION).initial_time).toBe("10:00");
    expect(byId(m, FORM_END_ACTION).initial_time).toBe("12:00");
    expect(m.blocks.find((b) => b.block_id === "title")).toMatchObject({ type: "input", optional: true, element: { action_id: "title", initial_value: "Youth night" } });
    expect(byId(m, FORM_REPEAT_ACTION).initial_option.value).toBe("none");
    expect(byId(m, FORM_DAYS_ACTION)).toBeUndefined();
  });

  it("weekly repeat shows the day checkboxes with Sat and Sun selected, and the until picker", () => {
    const m = form({ line: { ...LINE, repeat: { days: [6, 0], until: "2026-12-20" } } });
    expect(byId(m, FORM_REPEAT_ACTION).initial_option.value).toBe("weekly");
    const days = byId(m, FORM_DAYS_ACTION);
    expect(days.options).toHaveLength(7);
    expect(days.initial_options.map((o) => o.text.text)).toEqual(["Sat", "Sun"]);
    expect(byId(m, FORM_UNTIL_ACTION).initial_date).toBe("2026-12-20");
  });

  it("offers Remove only for a line already in the tray", () => {
    expect(byId(form(), FORM_REMOVE_ACTION)).toBeUndefined();
    expect(byId(form({ inTray: true }), FORM_REMOVE_ACTION)).toBeDefined();
    expect(byId(form(), FORM_SAVE_ACTION).style).toBe("primary");
    expect(byId(form(), FORM_BACK_ACTION).text.text).toBe("◀ Back to list");
    expect(FORM_ACTIONS.has(FORM_SAVE_ACTION)).toBe(true);
  });

  it("shows kitchen appliances only for the kitchen", () => {
    expect(form().blocks.some((b) => b.block_id === "appliances")).toBe(false);
    expect(form({ entry: KITCHEN, line: { ...LINE, item: "Kitchen" } }).blocks.some((b) => b.block_id === "appliances")).toBe(true);
  });

  it("shows the check and the problems", () => {
    const m = form({ check: "❌ Taken", problems: ["Pick a date.", "Add what it's for."] });
    const text = m.blocks.filter((b) => b.type === "section").map((b) => b.text.text).join("\n");
    expect(text).toContain("❌ Taken");
    expect(text).toContain("Pick a date.\nAdd what it's for.");
  });
});

describe("readLineForm", () => {
  const state = (o) => ({ form_when: { [FORM_DATE_ACTION]: { selected_date: "2026-10-25" }, [FORM_START_ACTION]: { selected_time: "20:00" }, [FORM_END_ACTION]: { selected_time: "00:00" } }, ...o });

  it("reads date and times, with a 00:00 end after a later start as 1440", () => {
    const l = readLineForm(state(), LINE);
    expect(l).toMatchObject({ id: "a1", item: "MPR", date: "2026-10-25", start: 1200, end: 1440, title: "Youth night" });
  });

  it("reads title, repeat, days and until", () => {
    const l = readLineForm(state({
      title: { title: { value: "  Retreat " } },
      form_repeat: { [FORM_REPEAT_ACTION]: { selected_option: { value: "weekly" } } },
      form_days: { [FORM_DAYS_ACTION]: { selected_options: [{ value: "6" }, { value: "0" }] } },
      form_until: { [FORM_UNTIL_ACTION]: { selected_date: "2026-12-20" } },
    }), LINE);
    expect(l.title).toBe("Retreat");
    expect(l.repeat).toEqual({ days: [6, 0], until: "2026-12-20" });
    expect(readLineForm({ form_repeat: { [FORM_REPEAT_ACTION]: { selected_option: { value: "none" } } } }, { ...LINE, repeat: { days: [1], until: "2026-11-01" } }).repeat).toBeNull();
  });

  it("keeps fields the state does not carry", () => {
    expect(readLineForm({}, LINE)).toEqual(LINE);
  });

  it("reads kitchen appliances", () => {
    const l = readLineForm({ appliances: { appliances: { selected_options: [{ value: "island" }] } }, count_fridge: { count_fridge: { value: "2" } } }, LINE);
    expect(l.appliances).toEqual({ island: true, fridge: 2 });
  });
});
