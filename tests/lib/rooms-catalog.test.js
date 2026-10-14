// tests/lib/rooms-catalog.test.js
import { describe, it, expect } from "vitest";
import { normalizeRoom, splitRooms, roomsConflict, ROOMS, ALL_FH } from "../../src/lib/rooms-catalog.js";

describe("normalizeRoom", () => {
  it("maps aliases and spelling variants to one name", () => {
    expect(normalizeRoom("FH MPR")).toBe("MPR");
    expect(normalizeRoom("mpr")).toBe("MPR");
    expect(normalizeRoom("Maker Space")).toBe("Makerspace");
    expect(normalizeRoom("MakerSpace")).toBe("Makerspace");
    expect(normalizeRoom("120")).toBe("L120");
    expect(normalizeRoom("FH Glass Room")).toBe("Glass Room");
    expect(normalizeRoom("parking lot")).toBe("Parking Lot");
    expect(normalizeRoom("FH A2K Room")).toBe("A2K Room");
    expect(normalizeRoom("Staff Suite ")).toBe("Staff Suite");
    expect(normalizeRoom("All FH")).toBe(ALL_FH);
  });
  it("keeps unknown names as written", () => {
    expect(normalizeRoom("Shenandoah")).toBe("Shenandoah");
  });
});

describe("splitRooms", () => {
  it("splits on newlines and commas", () => {
    expect(splitRooms("FH Glass Room, L120, Youth Room")).toEqual(["Glass Room", "L120", "Youth Room"]);
    expect(splitRooms("Youth Room\nA2K Room")).toEqual(["Youth Room", "A2K Room"]);
    expect(splitRooms("MPR, parking lot")).toEqual(["MPR", "Parking Lot"]);
    expect(splitRooms("")).toEqual([]);
  });
});

describe("roomsConflict", () => {
  it("conflicts on any shared room", () => {
    expect(roomsConflict(["MPR"], ["Parking Lot", "MPR"])).toBe(true);
    expect(roomsConflict(["MPR"], ["L120"])).toBe(false);
  });
  it("All FH conflicts with everything", () => {
    expect(roomsConflict([ALL_FH], ["L120"])).toBe(true);
    expect(roomsConflict(["Youth Room"], [ALL_FH])).toBe(true);
  });
  it("Kitchen is not a bookable room here", () => {
    expect(ROOMS.some((r) => r.name === "Kitchen")).toBe(false);
  });
});
