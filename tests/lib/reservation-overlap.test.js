import { describe, it, expect } from "vitest";
import { intervalsOverlap, findRoomConflicts } from "../../src/lib/reservation-overlap.js";

describe("intervalsOverlap", () => {
  it("detects overlap", () => expect(intervalsOverlap(60, 120, 90, 150)).toBe(true));
  it("treats touching ends as non-overlapping", () => expect(intervalsOverlap(60, 120, 120, 180)).toBe(false));
  it("detects nested", () => expect(intervalsOverlap(60, 180, 90, 120)).toBe(true));
  it("rejects disjoint", () => expect(intervalsOverlap(60, 120, 200, 260)).toBe(false));
});

describe("findRoomConflicts", () => {
  const req = { room: "FH MPR", startMin: 18 * 60, endMin: 21 * 60 };
  it("flags an overlapping same-room event", () => {
    const events = [{ room: "FH MPR", startMin: 19 * 60, endMin: 20 * 60, allDay: false }];
    expect(findRoomConflicts(req, events).conflicts).toHaveLength(1);
  });
  it("ignores a different room", () => {
    const events = [{ room: "Childcare Room", startMin: 19 * 60, endMin: 20 * 60, allDay: false }];
    expect(findRoomConflicts(req, events).conflicts).toHaveLength(0);
  });
  it("all-day same-room event always conflicts", () => {
    const events = [{ room: "FH MPR", startMin: 0, endMin: 1439, allDay: true }];
    expect(findRoomConflicts(req, events).conflicts).toHaveLength(1);
  });
  it("counts and skips unparseable-time events", () => {
    const events = [{ room: "FH MPR", startMin: null, endMin: null, allDay: false }];
    const res = findRoomConflicts(req, events);
    expect(res.conflicts).toHaveLength(0);
    expect(res.skipped).toBe(1);
  });
});
