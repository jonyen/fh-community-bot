import { describe, it, expect } from "vitest";
import { normalizeLocation, createRoomMatcher } from "../../src/lib/reservation-rooms.js";

describe("normalizeLocation", () => {
  it("collapses newlines and case", () =>
    expect(normalizeLocation("Staff Suite \nzoom")).toBe("staff suite zoom"));
  it("trims and collapses spaces", () =>
    expect(normalizeLocation("  FH   MPR ")).toBe("fh mpr"));
});

describe("createRoomMatcher", () => {
  const matcher = createRoomMatcher(
    ["FH MPR", "FH Staff Suite", "Childcare Room"],
    { "staff suite": "FH Staff Suite", "mpr": "FH MPR" }
  );
  it("matches an exact canonical name", () => expect(matcher.match("FH MPR")).toBe("FH MPR"));
  it("matches case/space-insensitively", () => expect(matcher.match("childcare room")).toBe("Childcare Room"));
  it("matches an alias", () => expect(matcher.match("Staff Suite")).toBe("FH Staff Suite"));
  it("matches alias inside noisy text", () => expect(matcher.match("Staff Suite \nzoom")).toBe("FH Staff Suite"));
  it("returns null for unmanaged location", () => expect(matcher.match("National Mall")).toBeNull());
});

describe("createRoomMatcher query is a word inside a canonical name", () => {
  // Production scenario: canonical room names from VENUE labels, with NO short
  // aliases defined for them. A user typing "MPR" must still resolve "FH MPR".
  const matcher = createRoomMatcher(
    ["FH MPR", "FH 302: Staff Suite", "FH 230: Childcare Room"],
    {}
  );
  it("matches a single-word query to its canonical room", () =>
    expect(matcher.match("MPR")).toBe("FH MPR"));
  it("matches a multi-word query to a colon-prefixed canonical", () =>
    expect(matcher.match("Staff Suite")).toBe("FH 302: Staff Suite"));
  it("matches 'childcare room' to the numbered venue", () =>
    expect(matcher.match("childcare room")).toBe("FH 230: Childcare Room"));
  it("still returns null for an unrelated query", () =>
    expect(matcher.match("National Mall")).toBeNull());
});

describe("createRoomMatcher.matchAll", () => {
  const matcher = createRoomMatcher(
    ["DMV Tech Equipment-G-Tech Set 1", "DMV Tech Equipment-G-Tech Set 2",
     "DMV Tech Equipment-G-Tech Set 3", "DMV Tech Equipment-G-Tech Set 4",
     "DMV Accessories-Popcorn Machine"],
    {}
  );
  it("returns all candidates for an ambiguous query", () => {
    expect(matcher.matchAll("tech set").sort()).toEqual([
      "DMV Tech Equipment-G-Tech Set 1", "DMV Tech Equipment-G-Tech Set 2",
      "DMV Tech Equipment-G-Tech Set 3", "DMV Tech Equipment-G-Tech Set 4",
    ]);
  });
  it("returns a single candidate when unambiguous", () => {
    expect(matcher.matchAll("popcorn")).toEqual(["DMV Accessories-Popcorn Machine"]);
    expect(matcher.matchAll("popcorn machine")).toEqual(["DMV Accessories-Popcorn Machine"]);
  });
  it("returns the exact match for a full name", () => {
    expect(matcher.matchAll("DMV Tech Equipment-G-Tech Set 2")).toEqual(["DMV Tech Equipment-G-Tech Set 2"]);
  });
  it("returns [] for an unrecognized query", () => {
    expect(matcher.matchAll("spaceship")).toEqual([]);
  });
});
