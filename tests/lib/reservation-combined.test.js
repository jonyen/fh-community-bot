// tests/lib/reservation-combined.test.js
import { describe, it, expect } from "vitest";
import {
  combinedMessage, markLineCancelled, seriesChooser,
  POST_CANCEL_ACTION, SERIES_ALL_ACTION, SERIES_ONE_ACTION, COMBINED_EVENT_TYPE,
} from "../../src/lib/reservation-combined.js";

const ref = (date) => ({ backend: "rooms", date, id: "e1" });
const booked = [
  { summary: "Tech Set 2 · every Tue until 11/10", seriesId: "s1", count: 4 },
  { summary: "Kitchen · Sat 11/7 · 9–11am", ref: ref("2026-11-07"), count: 1 },
];
const buttons = (m) => m.blocks.filter((b) => b.accessory).map((b) => b.accessory);

describe("combinedMessage", () => {
  const m = combinedMessage({ user: "U1", booked, skipped: [] });

  it("opens with the mention and lists each line with its own Cancel", () => {
    expect(m.blocks[0].text.text).toBe("✅ <@U1> reserved:");
    expect(m.blocks[1].text.text).toBe("• Tech Set 2 · every Tue until 11/10");
    const [series, single] = buttons(m);
    expect(series.action_id).toBe(POST_CANCEL_ACTION);
    expect(series.style).toBe("danger");
    expect(JSON.parse(series.value)).toEqual({ u: "U1", i: 0, s: "s1" });
    expect(series.confirm).toBeUndefined();
    expect(JSON.parse(single.value)).toEqual({ u: "U1", i: 1, r: ref("2026-11-07") });
    expect(single.confirm.text.text).toContain("Kitchen");
    expect(single.confirm.confirm.text).toBe("Cancel booking");
    expect(single.confirm.deny.text).toBe("Keep it");
    expect(m.metadata).toEqual({ event_type: COMBINED_EVENT_TYPE, event_payload: { user: "U1" } });
  });

  it("renders skips under the warning header, chunked under 3,000 chars", () => {
    const skipped = Array.from({ length: 40 }, (_, i) => ({ text: `Room ${i} ${"x".repeat(150)}` }));
    const s = combinedMessage({ user: "U1", booked, skipped });
    const at = s.blocks.findIndex((b) => b.text?.text.startsWith("⚠️ Not booked, already claimed or unavailable:"));
    expect(at).toBeGreaterThan(0);
    const sections = s.blocks.slice(at);
    expect(sections.length).toBeGreaterThan(1);
    for (const b of sections) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(sections.map((b) => b.text.text).join("\n").match(/• Room/g)).toHaveLength(40);
    expect(s.blocks.length).toBeLessThanOrEqual(50);
  });

  it("escapes member text but not the mention", () => {
    const e = combinedMessage({ user: "U1", booked: [{ summary: "A <b> & c", seriesId: "s" , count: 2 }], skipped: [{ text: "<!channel>" }] });
    expect(e.blocks[0].text.text).toContain("<@U1>");
    expect(e.blocks[1].text.text).toBe("• A &lt;b&gt; &amp; c");
    expect(JSON.stringify(e.blocks)).toContain("&lt;!channel&gt;");
  });

  it("escapes the fallback text so a title cannot broadcast", () => {
    const e = combinedMessage({ user: "U1", booked: [{ summary: "<!channel> & x", seriesId: "s", count: 2 }], skipped: [] });
    expect(e.text).toContain("&lt;!channel&gt; &amp; x");
    expect(e.text).not.toContain("<!channel>");
  });

  it("caps skips at 40 lines then says how many more", () => {
    const skipped = Array.from({ length: 60 }, (_, i) => ({ text: `Room ${i}` }));
    const s = combinedMessage({ user: "U1", booked, skipped });
    const all = s.blocks.map((b) => b.text.text).join("\n");
    expect(all.match(/• Room/g)).toHaveLength(40);
    expect(all).toContain("…and 20 more.");
  });

  it("drops the Cancel when the value is too big", () => {
    const big = { backend: "rooms", date: "2026-11-07", pad: "x".repeat(2100) };
    const b = combinedMessage({ user: "U1", booked: [{ summary: "Big", ref: big, count: 1 }], skipped: [] });
    expect(b.blocks[1].accessory).toBeUndefined();
  });
});

describe("markLineCancelled", () => {
  it("changes only that section", () => {
    const m = combinedMessage({ user: "U1", booked, skipped: [{ text: "Room" }] });
    const out = markLineCancelled(m, 1, "❌ Cancelled");
    expect(out.blocks[2].text.text).toBe("• Kitchen · Sat 11/7 · 9–11am\n❌ Cancelled");
    expect(out.blocks[2].accessory).toBeUndefined();
    expect(out.blocks[1]).toEqual(m.blocks[1]);
    expect(out.blocks[0]).toEqual(m.blocks[0]);
    expect(out.blocks[3]).toEqual(m.blocks[3]);
    expect(out.metadata).toEqual(m.metadata);
    expect(m.blocks[2].accessory).toBeDefined();
  });
});

describe("seriesChooser", () => {
  const series = {
    id: "s1", item: "Tech Set 2", start: 540, end: 660, title: "T", repeat: { days: [2], until: "2026-11-10" },
    refs: ["2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"].map(ref),
  };
  const c = seriesChooser({ user: "U1", series, postTs: "1.2", channel: "C1", today: "2026-10-20" });
  const actions = c.blocks.find((b) => b.type === "actions");

  it("offers whole series and remaining dates only", () => {
    expect(c.blocks[0].text.text).toContain("Cancel *Tech Set 2* · every Tue");
    const all = actions.elements.find((e) => e.action_id === SERIES_ALL_ACTION);
    expect(all.style).toBe("danger");
    expect(all.confirm.text.text).toBe("Cancel every remaining date?");
    expect(JSON.parse(all.value)).toEqual({ u: "U1", s: "s1", pt: "1.2", c: "C1" });
    const sel = actions.elements.find((e) => e.action_id === SERIES_ONE_ACTION);
    expect(sel.placeholder.text).toBe("Just one date");
    expect(sel.confirm).toBeTruthy();
    expect(sel.options.map((o) => JSON.parse(o.value).d)).toEqual(["2026-10-20", "2026-10-27", "2026-11-03"]);
    expect(JSON.parse(actions.block_id)).toEqual({ u: "U1", s: "s1", pt: "1.2", c: "C1" });
    expect(actions.block_id.length).toBeLessThanOrEqual(255);
  });

  it("throws when the block_id would pass 255 chars", () => {
    expect(() => seriesChooser({ user: "U1", series, postTs: "1.2", channel: "C".repeat(300), today: "2026-10-20" })).toThrow(/block_id/);
  });

  it("caps options at 100", () => {
    const refs = Array.from({ length: 150 }, (_, i) => ref(`2027-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`));
    const big = seriesChooser({ user: "U1", series: { ...series, refs }, postTs: "1.2", channel: "C1", today: "2026-10-20" });
    expect(big.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === SERIES_ONE_ACTION).options).toHaveLength(100);
  });
});
