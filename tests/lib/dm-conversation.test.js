// tests/lib/dm-conversation.test.js
import { describe, it, expect } from "vitest";
import { openRequest, isEscape, STALE_MS } from "../../src/lib/dm-conversation.js";
import { REQUEST_EVENT_TYPE, CLOSED_METADATA } from "../../src/lib/reservation-format.js";

const NOW = 1_800_000_000_000;
const ts = (agoMs) => String((NOW - agoMs) / 1000);
const MIN = 60_000;
const marker = (agoMs, text = "book the MPR") => ({ ts: ts(agoMs), text, bot_id: "B1", metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: {} } });
const bot = (agoMs, text) => ({ ts: ts(agoMs), text, bot_id: "B1" });
const member = (agoMs, text) => ({ ts: ts(agoMs), text });
const closed = (agoMs) => ({ ts: ts(agoMs), text: "Booked.", bot_id: "B1", metadata: CLOSED_METADATA });

describe("openRequest", () => {
  it("continues the open request", () => {
    const m = marker(10 * MIN), b = bot(9 * MIN, "I still need: date"), cur = member(MIN, "Saturday");
    const out = openRequest([cur, b, m], { currentTs: cur.ts, nowMs: NOW });
    expect(out).toEqual([m, b, cur]);
  });

  it("closed request is not open", () => {
    const cur = member(MIN, "hi");
    const out = openRequest([cur, closed(5 * MIN), bot(6 * MIN, "x"), marker(10 * MIN)], { currentTs: cur.ts, nowMs: NOW });
    expect(out).toBeNull();
  });

  it("a newer start marker wins", () => {
    const old = marker(50 * MIN, "old"), oldText = member(49 * MIN, "old text");
    const nu = marker(10 * MIN, "new"), cur = member(MIN, "Saturday");
    const out = openRequest([cur, nu, oldText, old], { currentTs: cur.ts, nowMs: NOW });
    expect(out).toEqual([nu, cur]);
  });

  it("stale request is not open", () => {
    const cur = member(0, "hello");
    const stale = [cur, bot(STALE_MS + MIN, "I still need: date"), marker(STALE_MS + 5 * MIN)];
    expect(openRequest(stale, { currentTs: cur.ts, nowMs: NOW })).toBeNull();
    const fresh = [cur, bot(STALE_MS - MIN, "I still need: date"), marker(STALE_MS + 5 * MIN)];
    expect(openRequest(fresh, { currentTs: cur.ts, nowMs: NOW })).toHaveLength(3);
  });

  it("uses the marker ts when it is the newest before the current message", () => {
    const cur = member(0, "hello");
    expect(openRequest([cur, marker(STALE_MS + MIN)], { currentTs: cur.ts, nowMs: NOW })).toBeNull();
    expect(openRequest([cur, marker(STALE_MS - MIN)], { currentTs: cur.ts, nowMs: NOW })).toHaveLength(2);
  });

  it("ignores messages newer than the current one", () => {
    const m = marker(10 * MIN), cur = member(5 * MIN, "Saturday");
    const out = openRequest([closed(MIN), cur, m], { currentTs: cur.ts, nowMs: NOW });
    expect(out).toEqual([m, cur]);
  });

  it("a long gap inside the request makes it stale, even with chatter after", () => {
    // Marker and ask at T, unmarked "hi" 3h later, then the current message.
    const T = 3 * 60 * MIN + MIN;
    const m = marker(T), ask = bot(T - 1000, "I still need: date");
    const hi = member(MIN, "hi"), cur = member(0, "Van Fri 5-7");
    expect(openRequest([cur, hi, ask, m], { currentTs: cur.ts, nowMs: NOW })).toBeNull();
  });

  it("no marker is not open", () => {
    const cur = member(MIN, "hi");
    expect(openRequest([cur, bot(5 * MIN, "hello")], { currentTs: cur.ts, nowMs: NOW })).toBeNull();
  });
});

describe("isEscape", () => {
  it("matches start over / cancel, trimmed and case-insensitive", () => {
    expect(isEscape(" Start Over ")).toBe(true);
    expect(isEscape("CANCEL")).toBe(true);
    expect(isEscape("cancel the MPR booking")).toBe(false);
  });
});
