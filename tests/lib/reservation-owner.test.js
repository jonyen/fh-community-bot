// tests/lib/reservation-owner.test.js
import { describe, it, expect } from "vitest";
import { normalizeName, namesMatch, isMine, refKey } from "../../src/lib/reservation-owner.js";

const M = { userId: "U1", realName: "Jon Yen", displayName: "jy", email: "jon@x.org", phone: "+1 (571) 555-0101" };

describe("reservation-owner", () => {
  it("normalizes accents, parentheses and punctuation", () => {
    expect(normalizeName("  José  Núñez (Youth) ")).toBe("jose nunez");
  });
  it.each([
    ["Jon Yen", true], ["jon yen - youth", true], ["Yen Jon", true], ["Jon A. Yen", true], ["Jon Y", true], ["JY", true],
    ["Jon", false], ["Jonathan Yen", false], ["", false],
  ])("namesMatch(%s)", (sheet, want) => expect(namesMatch(sheet, M)).toBe(want));
  it("matches accented sheet names to plain Slack names", () => {
    expect(namesMatch("José Núñez (Youth)", { ...M, realName: "Jose Nunez", displayName: "" })).toBe(true);
  });
  it("never matches when the member has no names", () => {
    expect(namesMatch("", { ...M, realName: "", displayName: "" })).toBe(false);
    expect(namesMatch("Jon", { ...M, realName: "", displayName: "" })).toBe(false);
  });
  it("isMine by slack id, email, kitchen phone and ledger", () => {
    expect(isMine({ holderUserId: "U1", ref: { backend: "rms", eventId: "e" } }, M, new Set())).toBe(true);
    expect(isMine({ holderEmail: "JON@x.org", ref: { backend: "rms", eventId: "e" } }, M, new Set())).toBe(true);
    expect(isMine({ category: "kitchen", holderName: "Someone", phone: "571-555-0101", ref: { backend: "kitchen", row: 9, date: "2026-10-24" } }, M, new Set())).toBe(true);
    const ref = { backend: "rooms", date: "2026-10-24", start: 600, end: 660, title: "Rally", holder: "jy2" };
    expect(isMine({ holderName: "jy2", ref }, M, new Set([refKey(ref)]))).toBe(true);
    expect(isMine({ holderName: "Pat Doe", ref }, M, new Set())).toBe(false);
  });
  it("does not name-match rms events or phone-match rooms", () => {
    expect(isMine({ category: "rms", holderName: "Jon Yen", ref: { backend: "rms", eventId: "e" } }, M, new Set())).toBe(false);
    expect(isMine({ category: "rooms", holderName: "Pat", phone: "571-555-0101", ref: { backend: "rooms" } }, M, new Set())).toBe(false);
  });
  it("builds stable ref keys", () => {
    expect(refKey({ backend: "rms", eventId: "e1" })).toBe("rms:e1");
    expect(refKey({ backend: "rooms", date: "2026-10-24", start: 600, end: 660, title: "Rally (x)", holder: "José" }))
      .toBe("rooms:2026-10-24:600:660:rally:jose");
    expect(refKey({ backend: "kitchen", row: 9, date: "2026-10-24", name: "Jon Yen" })).toBe("kitchen:9:2026-10-24:jon yen");
  });
});
