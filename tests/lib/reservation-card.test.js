// tests/lib/reservation-card.test.js
import { describe, it, expect } from "vitest";
import { encodeCard, decodeCard, cardMessage, closedMessage, openBookValue, BOOK_ACTION, EDIT_ACTION, CARD_EVENT_TYPE } from "../../src/lib/reservation-card.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
const KITCHEN = CATALOG.find((e) => e.label === "Kitchen");
const REQ = { intent: "book", items: [SET2], ambiguous: [], unmatched: [], date: "2026-10-17", toDate: null, start: 840, end: 960, title: "Youth night", ministry: null, appliances: {} };

const actionsOf = (msg) => msg.blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements);
const textOf = (msg) => msg.blocks.filter((b) => b.type === "section").map((b) => b.text.text).join("\n");

describe("encodeCard / decodeCard", () => {
  it("round trips the request and the requester", () => {
    const back = decodeCard(encodeCard({ user: "U9", req: { ...REQ, ministry: "Youth" } }), CATALOG);
    expect(back.user).toBe("U9");
    expect(back.req).toMatchObject({ intent: "book", items: [SET2], date: "2026-10-17", start: 840, end: 960, title: "Youth night", ministry: "Youth", appliances: {}, ambiguous: [], unmatched: [] });
  });

  it("keeps missing fields missing", () => {
    const back = decodeCard(encodeCard({ user: "U9", req: { ...REQ, date: null, start: null, end: null, title: null } }), CATALOG);
    expect(back.req).toMatchObject({ date: null, start: null, end: null, title: null });
  });

  it("trims a long title so the value stays small", () => {
    const value = encodeCard({ user: "U9", req: { ...REQ, title: "x".repeat(1000) } });
    expect(decodeCard(value, CATALOG).req.title).toHaveLength(150);
  });

  it("fits Slack's 2,000-character button value with several rooms and kitchen appliances", () => {
    const rooms = CATALOG.filter((e) => e.category === "rooms").slice(0, 6);
    const appliances = { island: true, whiteCounter: true, brownCounter: true, freezer: 2, fridge: 3, toasterOven: true, airFryer: true, microwave: true, largeRiceCooker: 1, smallRiceCooker: 2, instapot: 1 };
    const value = encodeCard({ user: "U9", req: { ...REQ, items: [...rooms, KITCHEN], appliances, title: "y".repeat(400), ministry: "z".repeat(400) } });
    expect(value.length).toBeLessThan(2000);
  });

  it("drops items that are no longer in the catalog and rejects garbage", () => {
    const value = JSON.stringify({ u: "U9", i: ["Tech Set 2", "Gone Item"] });
    expect(decodeCard(value, CATALOG).req.items).toEqual([SET2]);
    expect(decodeCard(value, CATALOG).lost).toEqual(["Gone Item"]);
    expect(decodeCard("not json", CATALOG)).toBeNull();
    expect(decodeCard(JSON.stringify({ i: [] }), CATALOG)).toBeNull();
  });
});

describe("cardMessage", () => {
  it("a free slot shows the request, Free, and Book and Edit", () => {
    const msg = cardMessage({ user: "U9", req: REQ, assessment: { state: "free" } });
    expect(msg.text).toBe("📅 Tech Set 2 · Sat 10/17 · 2:00–4:00 PM · Youth night");
    expect(textOf(msg)).toBe("📅 *Tech Set 2* · Sat 10/17 · 2:00–4:00 PM · Youth night\n✅ Free");
    const [book, edit] = actionsOf(msg);
    expect(book).toMatchObject({ action_id: BOOK_ACTION, style: "primary", text: { text: "Book" } });
    expect(edit).toMatchObject({ action_id: EDIT_ACTION, text: { text: "Edit" } });
    expect(book.value).toBe(edit.value);
    expect(decodeCard(book.value, CATALOG).user).toBe("U9");
    expect(msg.metadata).toEqual({ event_type: CARD_EVENT_TYPE, event_payload: { user: "U9" } });
  });

  it("a taken slot names the holders and only offers Edit", () => {
    const conflicts = [{ item: "Tech Set 2", date: "2026-10-17", start: 840, end: 930, title: "Fall rally", holder: "Alan", holderUserId: "UALAN" }];
    const msg = cardMessage({ user: "U9", req: REQ, assessment: { state: "taken", conflicts } });
    expect(textOf(msg)).toContain("❌ Taken:\n• 2:00–3:30 PM · Tech Set 2 · Fall rally (<@UALAN>)\nCheck with them, or press Edit to pick another time.");
    expect(actionsOf(msg).map((a) => a.action_id)).toEqual([EDIT_ACTION]);
  });

  it("missing details are listed with placeholders in the summary", () => {
    const req = { ...REQ, date: null, start: null, end: null, title: null };
    const msg = cardMessage({ user: "U9", req, assessment: { state: "missing", missing: ["date", "start and end time", "what it's for"] } });
    expect(textOf(msg)).toBe("📅 *Tech Set 2* · _day?_ · _time?_ · _what for?_\nMissing: date, start and end time, what it's for. Press Edit to fill it in.");
    expect(actionsOf(msg).map((a) => a.action_id)).toEqual([EDIT_ACTION]);
  });

  it("an ambiguous item asks which one", () => {
    const req = { ...REQ, items: [] };
    const ambiguous = [{ phrase: "a speaker", options: [SET2, CATALOG[0]] }];
    const msg = cardMessage({ user: "U9", req, assessment: { state: "ambiguous", ambiguous } });
    expect(textOf(msg)).toContain(`Which one did you mean by "a speaker": Tech Set 2, ${CATALOG[0].label}? Press Edit to pick.`);
    expect(textOf(msg)).toMatch(/^📅 \*_what\?_\*/);
  });

  it("past dates and mixed kinds explain themselves", () => {
    expect(textOf(cardMessage({ user: "U9", req: REQ, assessment: { state: "past" } }))).toContain("That date has passed. Press Edit to change it.");
    expect(textOf(cardMessage({ user: "U9", req: REQ, assessment: { state: "mixed" } }))).toContain("Rooms, the kitchen and equipment are booked separately. Press Edit to pick one kind.");
  });
});

describe("closedMessage and openBookValue", () => {
  it("a closed card has no buttons and is marked closed", () => {
    const msg = closedMessage("✅ done");
    expect(msg).toEqual({ text: "✅ done", blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ done" } }], metadata: CLOSED_METADATA });
    expect(openBookValue(msg)).toBeNull();
  });

  it("reads the Book value off an open card, and null when only Edit is left", () => {
    const free = cardMessage({ user: "U9", req: REQ, assessment: { state: "free" } });
    expect(openBookValue(free)).toBe(actionsOf(free)[0].value);
    expect(openBookValue(cardMessage({ user: "U9", req: REQ, assessment: { state: "past" } }))).toBeNull();
    expect(openBookValue(undefined)).toBeNull();
  });
});
