import { describe, it, expect } from "vitest";
import { isIgnorableChatter, missingSlots, followUpText, disambiguationCandidates, pickCandidate } from "../../src/lib/reservation-intent.js";

describe("isIgnorableChatter", () => {
  it("ignores greetings, acks, and empties", () => {
    for (const t of ["", "  ", "hi", "hello", "thanks", "ty", "lol", "ok", "👍"]) {
      expect(isIgnorableChatter(t)).toBe(true);
    }
  });
  it("does not ignore real requests", () => {
    expect(isIgnorableChatter("is the MPR free friday 7-10pm?")).toBe(false);
    expect(isIgnorableChatter("reserve the childcare room saturday")).toBe(false);
  });
  it("does NOT ignore a bare number (a disambiguation reply)", () => {
    for (const t of ["1", "2", "#3", "4"]) expect(isIgnorableChatter(t)).toBe(false);
  });
});

describe("disambiguationCandidates", () => {
  it("parses candidate labels from a 'which one' ask", () => {
    expect(disambiguationCandidates("Which one did you mean: Tech Set 1, Tech Set 2, Tech Set 3, Tech Set 4?"))
      .toEqual(["Tech Set 1", "Tech Set 2", "Tech Set 3", "Tech Set 4"]);
  });
  it("returns [] for unrelated text", () => {
    expect(disambiguationCandidates("Reservations for all rooms:")).toEqual([]);
  });
});

describe("pickCandidate", () => {
  const labels = ["Tech Set 1", "Tech Set 2", "Tech Set 3", "Tech Set 4"];
  it("maps a 1-based number to a label", () => {
    expect(pickCandidate(labels, "1")).toBe("Tech Set 1");
    expect(pickCandidate(labels, "#3")).toBe("Tech Set 3");
    expect(pickCandidate(labels, "4")).toBe("Tech Set 4");
  });
  it("returns null for an out-of-range number", () => {
    expect(pickCandidate(labels, "5")).toBeNull();
    expect(pickCandidate(labels, "0")).toBeNull();
  });
  it("maps a name to a label", () => {
    expect(pickCandidate(labels, "tech set 2")).toBe("Tech Set 2");
  });
  it("returns null when the reply matches no/multiple labels", () => {
    expect(pickCandidate(labels, "popcorn")).toBeNull();
    expect(pickCandidate(labels, "tech set")).toBeNull(); // matches all 4
    expect(pickCandidate(labels, "")).toBeNull();
  });
});

describe("missingSlots", () => {
  it("reserve needs room, date, time", () => {
    expect(missingSlots({ intent: "reserve", target: null, date: null, startTime: null, endTime: null }))
      .toEqual(["room", "date", "time"]);
  });
  it("reports only what's missing", () => {
    expect(missingSlots({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: null }))
      .toEqual(["time"]);
  });
  it("check has the same requirements", () => {
    expect(missingSlots({ intent: "check", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM" }))
      .toEqual([]);
  });
  it("list and none require nothing", () => {
    expect(missingSlots({ intent: "list" })).toEqual([]);
    expect(missingSlots({ intent: "none" })).toEqual([]);
    expect(missingSlots(null)).toEqual([]);
  });
});

describe("followUpText", () => {
  it("asks for a single missing field", () => {
    expect(followUpText(["room"]).toLowerCase()).toContain("which room");
  });
  it("joins multiple asks naturally", () => {
    const t = followUpText(["room", "date", "time"]).toLowerCase();
    expect(t).toContain("which room");
    expect(t).toContain("what date");
    expect(t).toContain("what time");
  });
});
