import { describe, it, expect } from "vitest";
import { matchesReservationIntent } from "../../src/lib/reservation-triggers.js";

describe("matchesReservationIntent", () => {
  it("matches reserve/book verbs", () => {
    expect(matchesReservationIntent("can I reserve the MPR friday?")).toBe(true);
    expect(matchesReservationIntent("book the staff suite 6-9pm")).toBe(true);
  });
  it("matches availability questions", () => {
    expect(matchesReservationIntent("is the MPR free saturday?")).toBe(true);
    expect(matchesReservationIntent("when is the makerspace being used next week")).toBe(true);
  });
  it("ignores maintenance reports", () => {
    expect(matchesReservationIntent("the sink in the bathroom is leaking")).toBe(false);
  });
});
