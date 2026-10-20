// tests/lib/reservation-mine.test.js
import { describe, it, expect } from "vitest";
import { mineMessage, MINE_CANCEL_ACTION } from "../../src/lib/reservation-mine.js";
import { decodeRef } from "../../src/lib/reservation-card.js";

const RMS_REF = { backend: "rms", eventId: "ev1", organizerEmail: null, organizerSelf: true, resources: ["t2"], date: "2026-10-21", start: 840, end: 960, title: "Youth night" };
const ROOM_REF = { backend: "rooms", date: "2026-10-24", start: 600, end: 720, title: "MBS ", holder: "deandra shim", rooms: ["MPR"] };
const RMS = { item: "Tech Set 2", date: "2026-10-21", start: 840, end: 960, title: "Youth night", ref: RMS_REF, matchedBy: null, openLink: null };
const ROOM = { item: "MPR", date: "2026-10-24", start: 600, end: 720, title: "MBS ", holderName: "deandra shim", ref: ROOM_REF, matchedBy: "rooms", openLink: null };
const LINKS = { rooms: "https://rooms", kitchen: "https://kitchen", calendar: "https://rms" };

const sections = (m) => m.blocks.filter((b) => b.type === "section");
const allText = (m) => sections(m).map((b) => b.text.text).join("\n");

describe("mineMessage", () => {
  it("one section per entry, each with a Cancel button carrying the ref and a confirm naming the booking", () => {
    const m = mineMessage({ user: "U9", entries: [RMS], more: 0, links: LINKS, partial: false });
    const [head, line] = sections(m);
    expect(head.text.text).toBe("📋 Your upcoming bookings:");
    expect(line.text.text).toBe("📅 *Tech Set 2* · Wed 10/21 · 2:00–4:00 PM · Youth night");
    expect(line.accessory).toMatchObject({ type: "button", action_id: MINE_CANCEL_ACTION, text: { type: "plain_text", text: "Cancel" } });
    expect(MINE_CANCEL_ACTION).toBe("reservation_mine_cancel");
    expect(decodeRef(line.accessory.value)).toEqual({ user: "U9", ref: RMS_REF });
    expect(line.accessory.confirm).toMatchObject({
      title: { text: "Cancel this booking?" },
      text: { text: "Tech Set 2 · Wed 10/21 · 2:00–4:00 PM will be released." },
      confirm: { text: "Cancel booking" }, deny: { text: "Keep it" },
    });
    expect(m.text).toBe("Your upcoming bookings");
    expect(allText(m)).not.toContain("more");
  });

  it("a name-matched sheet row says so and its confirm quotes the row as typed", () => {
    const m = mineMessage({ user: "U9", entries: [ROOM], more: 0, links: LINKS, partial: false });
    const line = sections(m)[1];
    expect(line.text.text).toBe("📅 *MPR* · Sat 10/24 · 10:00 AM–12:00 PM · MBS · from the rooms sheet, matched by name");
    expect(line.accessory.confirm.text.text).toBe('"MBS " · deandra shim · Sat 10/24 · 10:00 AM–12:00 PM in the rooms sheet');
  });

  it("a name-matched kitchen row quotes just the name, since the kitchen title is the name", () => {
    const KREF = { backend: "kitchen", row: 7, date: "2026-10-24", start: 600, end: 720, name: "Deandra Shim" };
    const KITCHEN = { item: "Kitchen", date: "2026-10-24", start: 600, end: 720, title: "Deandra Shim", holderName: "Deandra Shim", ref: KREF, matchedBy: "kitchen", openLink: null };
    const line = sections(mineMessage({ user: "U9", entries: [KITCHEN], more: 0, links: LINKS }))[1];
    expect(line.accessory.confirm.text.text).toBe("Deandra Shim · Sat 10/24 · 10:00 AM–12:00 PM in the kitchen sheet");
  });

  it("caps a huge hand-typed title so no section passes Slack's 3,000 characters", () => {
    const big = "x".repeat(5000);
    const m = mineMessage({ user: "U9", entries: [{ ...RMS, title: big }], more: 0, links: LINKS, notice: `🚫 Cancelled ${big}` });
    for (const b of sections(m)) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(sections(m)[2].text.text).toMatch(/^📅 \*Tech Set 2\* · Wed 10\/21 · 2:00–4:00 PM · x+…$/);
    expect(sections(m)[0].text.text.endsWith("…")).toBe(true);
  });

  it("an entry with an open link gets Open in Calendar instead of Cancel", () => {
    const m = mineMessage({ user: "U9", entries: [{ ...RMS, openLink: "https://calendar.google.com/calendar/u/0/r?cid=t2" }], more: 0, links: LINKS });
    const b = sections(m)[1].accessory;
    expect(b).toEqual({ type: "button", action_id: "reservation_mine_open", text: { type: "plain_text", text: "Open in Calendar" }, url: "https://calendar.google.com/calendar/u/0/r?cid=t2" });
  });

  it("an all-day entry with no title reads cleanly", () => {
    const m = mineMessage({ user: "U9", entries: [{ ...RMS, start: null, end: null, title: "" }], more: 0, links: LINKS });
    expect(sections(m)[1].text.text).toBe("📅 *Tech Set 2* · Wed 10/21 · All day");
  });

  it("puts the notice first", () => {
    const m = mineMessage({ user: "U9", entries: [RMS], more: 0, links: LINKS, notice: "🚫 Booking cancelled by <@U9>." });
    expect(sections(m)[0].text.text).toBe("🚫 Booking cancelled by <@U9>.");
    expect(m.text).toBe("🚫 Booking cancelled by <@U9>.\nYour upcoming bookings");
  });

  it("past the cap: …and N more with the links", () => {
    const m = mineMessage({ user: "U9", entries: [RMS], more: 3, links: LINKS });
    expect(sections(m).at(-1).text.text).toBe("…and 3 more. Rooms: https://rooms · Kitchen: https://kitchen · Calendar: https://rms");
  });

  it("nothing found: the empty copy and the links of configured backends only", () => {
    const m = mineMessage({ user: "U9", entries: [], more: 0, links: { rooms: "https://rooms", calendar: "https://rms" } });
    expect(allText(m)).toBe("I don't see any upcoming bookings under your name.\nRooms: https://rooms · Calendar: https://rms");
    expect(m.text).toBe("I don't see any upcoming bookings under your name.");
  });

  it("partial adds Some bookings couldn't be checked.", () => {
    const m = mineMessage({ user: "U9", entries: [RMS], more: 0, links: LINKS, partial: true });
    expect(allText(m)).toContain("⚠️ Some bookings couldn't be checked.");
    const empty = mineMessage({ user: "U9", entries: [], more: 0, links: LINKS, partial: true });
    expect(allText(empty)).toContain("Some bookings couldn't be checked.");
  });

  it("an entry whose value would pass Slack's 2,000 characters gets no button", () => {
    const big = { ...RMS, ref: { ...RMS_REF, title: "x".repeat(2100) } };
    const m = mineMessage({ user: "U9", entries: [big], more: 0, links: LINKS });
    expect(sections(m)[1].accessory).toBeUndefined();
  });

  it("stays under 50 blocks at the cap", () => {
    const m = mineMessage({ user: "U9", entries: Array(20).fill(RMS), more: 5, links: LINKS, partial: true, notice: "🚫 x" });
    expect(m.blocks.length).toBeLessThanOrEqual(50);
  });
});
