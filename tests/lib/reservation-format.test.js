// tests/lib/reservation-format.test.js
import { describe, it, expect } from "vitest";
import { reservationLine, buildDigest } from "../../src/lib/reservation-format.js";

const R = (o) => ({ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 960, title: "Youth night", holder: "Alan Chow", holderUserId: null, holderEmail: null, ...o });

describe("reservationLine", () => {
  it("shows time, item, title and holder", () => {
    expect(reservationLine(R())).toBe("• 2:00–4:00 PM · Tech Set 2 · Youth night (Alan Chow)");
  });
  it("mentions a known Slack user and handles all-day and blank titles", () => {
    expect(reservationLine(R({ start: null, end: null, title: "", holderUserId: "U1" }))).toBe("• All day · Tech Set 2 (<@U1>)");
  });
});

describe("buildDigest", () => {
  it("groups by day then category in time order, skipping empty days", () => {
    const [msg] = buildDigest({
      from: "2026-10-12", to: "2026-10-18",
      reservations: [
        R({ date: "2026-10-17", start: 900, title: "Later" }),
        R({ date: "2026-10-17", start: 600, end: 660, title: "Earlier" }),
        R({ category: "rooms", item: "MPR", date: "2026-10-13", start: 1140, end: 1320, title: "Equipping", holder: "John" }),
      ],
    });
    expect(msg).toBe([
      "*Reservations this week: Mon 10/12 – Sun 10/18*",
      "",
      "*Tue 10/13*",
      "_Rooms_",
      "• 7:00–10:00 PM · MPR · Equipping (John)",
      "",
      "*Sat 10/17*",
      "_Tech_",
      "• 10:00–11:00 AM · Tech Set 2 · Earlier (Alan Chow)",
      "• 3:00–4:00 PM · Tech Set 2 · Later (Alan Chow)",
    ].join("\n"));
  });
  it("says so when the week is empty", () => {
    expect(buildDigest({ from: "2026-10-12", to: "2026-10-18", reservations: [] })).toEqual([
      "*Reservations this week: Mon 10/12 – Sun 10/18*\n\nNo reservations this week.",
    ]);
  });
  it("splits a long week at day boundaries", () => {
    const many = Array.from({ length: 40 }, (_, i) => R({ date: i < 20 ? "2026-10-13" : "2026-10-14", title: `Event ${i}` }));
    const parts = buildDigest({ from: "2026-10-12", to: "2026-10-18", reservations: many, maxChars: 1200 });
    expect(parts.length).toBe(2);
    expect(parts[1].startsWith("*Wed 10/14*")).toBe(true);
  });
});
