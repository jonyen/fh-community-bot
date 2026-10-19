// tests/lib/reservation-format.test.js
import { describe, it, expect } from "vitest";
import { reservationLine, buildLivingDigest } from "../../src/lib/reservation-format.js";

const R = (o) => ({ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 960, title: "Youth night", holder: "Alan Chow", holderUserId: null, holderEmail: null, ...o });

describe("reservationLine", () => {
  it("shows time, item, title and holder", () => {
    expect(reservationLine(R())).toBe("• 2:00–4:00 PM · Tech Set 2 · Youth night (Alan Chow)");
  });
  it("mentions a known Slack user and handles all-day and blank titles", () => {
    expect(reservationLine(R({ start: null, end: null, title: "", holderUserId: "U1" }))).toBe("• All day · Tech Set 2 (<@U1>)");
  });
});

describe("buildLivingDigest", () => {
  it("headers the period and lists by day and category", () => {
    const text = buildLivingDigest({ kind: "weekend", from: "2026-10-23", to: "2026-10-25", reservations: [
      { category: "tech", item: "Tech Set 2", date: "2026-10-24", start: 840, end: 960, title: "Youth night", holder: "Deandra" },
    ] });
    expect(text).toMatch(/^\*This weekend: Fri 10\/23 – Sun 10\/25\*/);
    expect(text).toContain("*Sat 10/24*\n_Tech_\n• 2:00–4:00 PM · Tech Set 2 · Youth night (Deandra)");
  });
  it("says so when nothing is booked", () => {
    expect(buildLivingDigest({ kind: "weekday", from: "2026-10-19", to: "2026-10-22", reservations: [] }))
      .toBe("*This week: Mon 10/19 – Thu 10/22*\n\nNothing booked yet.");
  });
  it("stays one message by trimming each day with +N more", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ category: "rooms", item: `Room ${i}`, date: "2026-10-20", start: 600, end: 660, title: "x".repeat(20), holder: "h" }));
    const text = buildLivingDigest({ kind: "weekday", from: "2026-10-19", to: "2026-10-22", reservations: many });
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toMatch(/\+\d+ more/);
  });
});
