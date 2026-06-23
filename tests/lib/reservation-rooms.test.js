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
