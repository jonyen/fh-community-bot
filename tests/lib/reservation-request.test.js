// tests/lib/reservation-request.test.js
import { describe, it, expect } from "vitest";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { normalizeRequest, missingFields } from "../../src/lib/reservation-request.js";

const CAT = buildCatalog({ rooms: true, kitchen: true, rms: [{ label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" }] });

describe("normalizeRequest", () => {
  it("keeps known items, converts times, drops bad values", () => {
    const req = normalizeRequest({
      intent: "book", items: ["tech set 2", "Hologram"], date: "2026-10-17", start: "14:00", end: "16:00",
      title: "Youth night", ministry: "AYM", appliances: { airFryer: true, bogus: true, largeRiceCooker: 2 },
    }, CAT);
    expect(req.intent).toBe("book");
    expect(req.items.map((i) => i.label)).toEqual(["Tech Set 2"]);
    expect(req.unmatched).toEqual(["Hologram"]);
    expect([req.date, req.start, req.end]).toEqual(["2026-10-17", 840, 960]);
    expect(req.appliances).toEqual({ airFryer: true, largeRiceCooker: 2 });
  });
  it("lists an unknown name once when the model gives it twice", () => {
    const req = normalizeRequest({ intent: "book", items: ["Jackery"], unmatched: ["jackery"] }, CAT);
    expect(req.unmatched).toEqual(["Jackery"]);
  });
  it("normalizeRequest keeps intent mine", () => {
    expect(normalizeRequest({ intent: "mine" }, CAT).intent).toBe("mine");
  });
  it("keeps the browse intent and its search words", () => {
    const r = normalizeRequest({ intent: "browse", search: "  speakers  " }, CAT);
    expect(r).toMatchObject({ intent: "browse", search: "speakers" });
  });
  it("cuts a long search to 60 characters and nulls a blank one", () => {
    expect(normalizeRequest({ intent: "browse", search: "x".repeat(80) }, CAT).search).toHaveLength(60);
    expect(normalizeRequest({ intent: "browse", search: " " }, CAT).search).toBeNull();
  });
  it("treats an unknown intent as other", () => {
    expect(normalizeRequest({ intent: "chitchat" }, CAT).intent).toBe("other");
    expect(normalizeRequest(null, CAT).intent).toBe("other");
  });
  it("drops a time range whose end is not after its start", () => {
    const req = normalizeRequest({ intent: "book", items: ["MPR"], date: "2026-10-17", start: "16:00", end: "14:00", title: "x" }, CAT);
    expect([req.start, req.end]).toEqual([null, null]);
    expect(missingFields(req)).toEqual(["start and end time"]);
  });
  it("keeps only ambiguity options that exist", () => {
    const req = normalizeRequest({ intent: "book", ambiguous: [{ phrase: "the speaker", options: ["Tech Set 2", "Tech Set 9"] }] }, CAT);
    expect(req.ambiguous).toEqual([{ phrase: "the speaker", options: [CAT.find((c) => c.label === "Tech Set 2")] }]);
  });
  it("rejects malformed dates", () => {
    expect(normalizeRequest({ intent: "book", date: "next sat" }, CAT).date).toBeNull();
  });
});

describe("find intent", () => {
  it("keeps the intent and checks items against the catalog", () => {
    const req = normalizeRequest({ intent: "find", items: ["Tech Set 2", "Nope"] }, CAT);
    expect(req.intent).toBe("find");
    expect(req.items.map((i) => i.label)).toEqual(["Tech Set 2"]);
    expect(req.unmatched).toEqual(["Nope"]);
  });
});

describe("missingFields", () => {
  it("lists everything a booking still needs", () => {
    expect(missingFields(normalizeRequest({ intent: "book" }, CAT))).toEqual([
      "what to book", "date", "start and end time", "what it's for",
    ]);
  });
  it("is empty for a complete booking", () => {
    const req = normalizeRequest({ intent: "book", items: ["MPR"], date: "2026-10-17", start: "14:00", end: "16:00", title: "x" }, CAT);
    expect(missingFields(req)).toEqual([]);
  });
});
