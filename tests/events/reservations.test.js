// tests/events/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationHandler } from "../../src/events/reservations.js";

describe("ReservationHandler.handleMention", () => {
  let reservationsService, groqService, say, handler;
  beforeEach(() => {
    reservationsService = {
      classifyTarget: vi.fn(),
      checkRoom: vi.fn(),
      makeRoomReservation: vi.fn(),
      listRoom: vi.fn(),
    };
    groqService = { parseReservationRequest: vi.fn() };
    say = vi.fn();
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-23T12:00:00Z") });
  });

  it("replies with availability for a check intent", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "check", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.checkRoom.mockResolvedValue({ available: true, conflicts: [], skipped: 0 });
    await handler.handleMention({ event: { text: "is the MPR free friday 7-10pm?", channel: "C1", ts: "1.1" }, say });
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: "1.1", username: "OneStop (beta)", text: expect.stringContaining("available"),
    }));
  });

  it("replies with the read-only sheet message on a reserve intent (no booking)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listRoom.mockResolvedValue([]);
    await handler.handleMention({ event: { text: "book MPR friday 7-10pm", channel: "C1", ts: "2.2" }, say });
    expect(reservationsService.makeRoomReservation).not.toHaveBeenCalled();
    const arg = say.mock.calls[0][0];
    expect(arg.text.toLowerCase()).toMatch(/don't reserve them over slack|edit the sheet/i);
  });

  it("asks for clarification when Groq cannot parse", async () => {
    groqService.parseReservationRequest.mockResolvedValue(null);
    await handler.handleMention({ event: { text: "uhh do the thing", channel: "C1", ts: "3.3" }, say });
    expect(say.mock.calls[0][0].text.toLowerCase()).toContain("didn't catch");
  });
});

describe("ReservationHandler.handleSlash /list", () => {
  let reservationsService, groqService, client, handler;
  beforeEach(() => {
    reservationsService = {
      classifyTarget: vi.fn(),
      listReservations: vi.fn(),
    };
    groqService = { parseReservationRequest: vi.fn() };
    client = { chat: { postEphemeral: vi.fn().mockResolvedValue({}) } };
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-23T12:00:00Z") });
  });
  const envelope = (text) => ({ command: "/list", text, channel_id: "C1", user_id: "U1" });

  it("lists all rooms for an explicit date, ephemeral, as OneStop (beta)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "1:00 PM", endTime: "2:00 PM", location: "FH MPR", what: "Worktime" },
    ]);
    await handler.handleSlash({ envelope: envelope("all reservations tomorrow"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-24", toIso: "2026-06-24" });
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "C1", user: "U1", username: "OneStop (beta)" });
    expect(arg.text).toContain("FH MPR");
    expect(arg.text).toContain("Worktime");
  });

  it("renders results as a monospace table grouped by day", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: null });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "1:00 PM", endTime: "2:00 PM", location: "FH MPR", what: "Worktime" },
      { dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "9:00 PM", location: "Childcare Room", what: "Dinner" },
      { dateIso: "2026-06-25", startTime: "6:00 PM", endTime: "7:30 PM", location: "GW", what: "Outreach" },
    ]);
    await handler.handleSlash({ envelope: envelope("everything this week"), client });
    const text = client.chat.postEphemeral.mock.calls[0][0].text;
    expect(text).toContain("```"); // code block for monospace alignment
    expect(text).toContain("Wed 6/24");
    expect(text).toContain("Thu 6/25");
    // header row per day group
    expect(text).toMatch(/TIME\s+ROOM\s+EVENT/);
    // aligned columns: time, room, what (padding between is flexible)
    expect(text).toMatch(/1:00 PM–2:00 PM\s+FH MPR\s+Worktime/);
    expect(text).toMatch(/6:00 PM–9:00 PM\s+Childcare Room\s+Dinner/);
    // "FH MPR" is padded (to the width of "Childcare Room") so the WHAT column aligns
    expect(text).toMatch(/FH MPR {2,}Worktime/);
    // blank line between day groups
    expect(text).toMatch(/Dinner\n\nThu 6\/25/);
  });

  it("collapses embedded newlines/tabs in cell values so rows stay aligned", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "11:30 AM", endTime: "12:30 PM", location: "Staff Suite \nzoom", what: "Management\tMeeting" },
    ]);
    await handler.handleSlash({ envelope: envelope("today"), client });
    const text = client.chat.postEphemeral.mock.calls[0][0].text;
    // the room cell's newline is collapsed to a single space — one row, not two
    expect(text).toContain("Staff Suite zoom");
    expect(text).not.toMatch(/Staff Suite \nzoom/);
    expect(text).toContain("Management Meeting");
    // exactly three lines inside the code block: date, header, one data row
    const block = text.match(/```\n([\s\S]*?)\n```/)[1];
    expect(block.split("\n").filter((l) => l.trim()).length).toBe(3);
  });

  it("drops placeholder rows (what is '-') and omits '-' fields in the table", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "12:00 AM", endTime: "11:59 PM", location: "-", what: "E-Sabbath" },
      { dateIso: "2026-06-24", startTime: "1:00 PM", endTime: "2:00 PM", location: "-", what: "-" }, // placeholder → dropped
    ]);
    await handler.handleSlash({ envelope: envelope("tomorrow"), client });
    const text = client.chat.postEphemeral.mock.calls[0][0].text;
    expect(text).toContain("12:00 AM–11:59 PM"); // the real (E-Sabbath) row is kept
    expect(text).toContain("E-Sabbath");
    expect(text).not.toContain("1:00 PM"); // the placeholder ("-") row is dropped
    expect(text).not.toMatch(/ - (?:\s|$)/); // no lone "-" placeholder field rendered
  });

  it("replies 'no reservations' when every row is a placeholder", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "1:00 PM", endTime: "2:00 PM", location: "-", what: "-" },
    ]);
    await handler.handleSlash({ envelope: envelope("tomorrow"), client });
    expect(client.chat.postEphemeral.mock.calls[0][0].text.toLowerCase()).toContain("no reservations");
  });

  it("shows 'time TBD' for an event with no start/end time", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "", endTime: "", location: "Various", what: "Bros LG" },
    ]);
    await handler.handleSlash({ envelope: envelope("tomorrow"), client });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/time TBD\s+Various\s+Bros LG/);
  });

  it("defaults to a 7-day window when no date is given", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: "MPR", date: null });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleSlash({ envelope: envelope("reservations for MPR"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: "FH MPR", fromIso: "2026-06-23", toIso: "2026-06-30" });
    expect(client.chat.postEphemeral.mock.calls[0][0].text.toLowerCase()).toContain("no reservations");
  });

  it("lists all rooms and notes when the room phrase is unrecognized", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: "the spaceship", date: "2026-06-24" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "unmanaged", name: "the spaceship" });
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleSlash({ envelope: envelope("reservations for the spaceship tomorrow"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-24", toIso: "2026-06-24" });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain("couldn't match");
  });

  it("treats a null parse as 'list everything in the default window'", async () => {
    groqService.parseReservationRequest.mockResolvedValue(null);
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleSlash({ envelope: envelope("???"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-23", toIso: "2026-06-30" });
  });
});

describe("ReservationHandler /reserve (read-only)", () => {
  let reservationsService, groqService, client, handler;
  beforeEach(() => {
    reservationsService = { classifyTarget: vi.fn(), makeRoomReservation: vi.fn(), listRoom: vi.fn() };
    groqService = { parseReservationRequest: vi.fn() };
    client = { chat: { postEphemeral: vi.fn().mockResolvedValue({}), postMessage: vi.fn().mockResolvedValue({}) } };
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-23T12:00:00Z") });
  });
  const env = (text) => ({ command: "/reserve", text, channel_id: "C1", user_id: "U1" });

  it("replies with the read-only sheet message and does NOT call makeRoomReservation", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listRoom.mockResolvedValue([]);
    await handler.handleSlash({ envelope: env("reserve MPR friday 7-10pm for practice"), client });
    expect(reservationsService.makeRoomReservation).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "C1", user: "U1", username: "OneStop (beta)" });
    expect(arg.text).toMatch(/don't reserve them over slack|edit the sheet/i);
    expect(arg.text).toContain("FH MPR");
  });

  it("appends the day's schedule when a date is parsed and listRoom returns items", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listRoom.mockResolvedValue([
      { dateIso: "2026-06-26", startTime: "1:00 PM", endTime: "3:00 PM", what: "Meeting" },
    ]);
    await handler.handleSlash({ envelope: env("reserve MPR friday 7-10pm for practice"), client });
    expect(reservationsService.makeRoomReservation).not.toHaveBeenCalled();
    expect(reservationsService.listRoom).toHaveBeenCalledWith({ room: "FH MPR", fromIso: "2026-06-26", toIso: "2026-06-26" });
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg.text).toMatch(/don't reserve them over slack|edit the sheet/i);
    expect(arg.text).toContain("Currently booked for FH MPR on 2026-06-26");
    expect(arg.text).toContain("Meeting");
  });

  it("appends 'nothing booked' when a date is parsed but listRoom returns no items", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listRoom.mockResolvedValue([]);
    await handler.handleSlash({ envelope: env("reserve MPR friday 7-10pm for practice"), client });
    expect(reservationsService.makeRoomReservation).not.toHaveBeenCalled();
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg.text).toContain("Nothing is booked for FH MPR on 2026-06-26");
  });
});

describe("ReservationHandler.handleChannelMessage", () => {
  let reservationsService, groqService, client, handler;
  beforeEach(() => {
    reservationsService = {
      classifyTarget: vi.fn(),
      checkRoom: vi.fn(),
      makeRoomReservation: vi.fn(),
      listRoom: vi.fn(),
      listReservations: vi.fn(),
    };
    groqService = { parseReservationRequest: vi.fn(), chooseCandidates: vi.fn().mockResolvedValue([]) };
    client = {
      chat: { postMessage: vi.fn().mockResolvedValue({}), postEphemeral: vi.fn() },
      conversations: { replies: vi.fn() },
    };
    handler = createReservationHandler({ reservationsService, groqService, now: () => new Date("2026-06-24T12:00:00Z") });
  });
  const msg = (over = {}) => ({ type: "message", channel: "Cres", user: "U1", ts: "100.1", text: "", ...over });

  it("stays silent on non-reservation chatter (intent none)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "none" });
    await handler.handleChannelMessage({ event: msg({ text: "that was a fun service" }), client });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("never calls the LLM or replies for obvious chatter", async () => {
    await handler.handleChannelMessage({ event: msg({ text: "thanks!" }), client });
    expect(groqService.parseReservationRequest).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("ignores bot messages", async () => {
    await handler.handleChannelMessage({ event: msg({ bot_id: "B1", text: "reserve MPR" }), client });
    expect(groqService.parseReservationRequest).not.toHaveBeenCalled();
  });

  it("asks a threaded follow-up when a reservation is missing slots", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: null, startTime: null, endTime: null });
    await handler.handleChannelMessage({ event: msg({ text: "can I book the MPR?" }), client });
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "Cres", thread_ts: "100.1", username: "OneStop (beta)" });
    expect(arg.text.toLowerCase()).toContain("what date");
    expect(arg.text.toLowerCase()).toContain("what time");
  });

  it("replies read-only on a complete reserve request (no booking, no broadcast)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listRoom.mockResolvedValue([]);
    await handler.handleChannelMessage({ event: msg({ text: "book FH MPR friday 7-10pm for practice" }), client });
    expect(reservationsService.makeRoomReservation).not.toHaveBeenCalled();
    const posts = client.chat.postMessage.mock.calls.map((c) => c[0]);
    // Only one reply, and it contains the read-only message (no booking announcement, no @mention)
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/don't reserve them over slack|edit the sheet/i);
  });

  it("combines a threaded reply with the original request and replies read-only", async () => {
    client.conversations.replies.mockResolvedValue({ messages: [
      { user: "U1", text: "can I book the MPR friday?" },
      { user: "U1", text: "7 to 10 pm for practice" },
    ] });
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listRoom.mockResolvedValue([]);
    await handler.handleChannelMessage({ event: msg({ thread_ts: "100.1", text: "7 to 10 pm for practice" }), client });
    expect(client.conversations.replies).toHaveBeenCalledWith({ channel: "Cres", ts: "100.1" });
    const combined = groqService.parseReservationRequest.mock.calls[0][0];
    expect(combined).toContain("can I book the MPR friday?");
    expect(combined).toContain("7 to 10 pm for practice");
    expect(reservationsService.makeRoomReservation).not.toHaveBeenCalled();
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text).toMatch(/don't reserve them over slack|edit the sheet/i);
  });

  it("answers a history request with the last-used event", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "popcorn machine" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({
      status: "ok", resourceName: "DMV Accessories-Popcorn Machine",
      lastUse: { summary: "Halloween Fest", startIso: "2024-10-31T14:00:00Z", endIso: "2024-10-31T16:00:00Z" },
    });
    await handler.handleChannelMessage({ event: msg({ text: "when was the popcorn machine last used" }), client });
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "Cres", thread_ts: "100.1", username: "OneStop (beta)" });
    expect(arg.text).toContain("Popcorn Machine");
    expect(arg.text).toContain("last used");
    expect(arg.text).toContain("Halloween Fest");
  });

  const askThread = (replyText) => ({ messages: [
    { user: "U1", text: "who used the tech set last" },
    { bot_id: "B1", text: "Which one did you mean: Tech Set 1, Tech Set 2, Tech Set 3, Tech Set 4?" },
    { user: "U1", text: replyText },
  ] });

  it("resolves a single disambiguation choice via the LLM and answers it", async () => {
    client.conversations.replies.mockResolvedValue(askThread("1"));
    groqService.chooseCandidates.mockResolvedValue(["Tech Set 1"]);
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({
      status: "ok", resourceName: "DMV Tech Equipment-G-Tech Set 1",
      lastUse: { summary: "GU Speed Friending", startIso: "2025-08-29T18:00:00Z", endIso: "2025-08-29T20:00:00Z" },
    });
    await handler.handleChannelMessage({ event: msg({ thread_ts: "100.1", text: "1" }), client });
    expect(groqService.chooseCandidates).toHaveBeenCalledWith(
      ["Tech Set 1", "Tech Set 2", "Tech Set 3", "Tech Set 4"], "1");
    expect(reservationsService.resourceLastUsed).toHaveBeenCalledWith("Tech Set 1");
    expect(groqService.parseReservationRequest).not.toHaveBeenCalled();
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg.text).toContain("Tech Set 1");
    expect(arg.text).toContain("GU Speed Friending");
  });

  it("answers every option when the user asks for all of them", async () => {
    client.conversations.replies.mockResolvedValue(askThread("all of them"));
    groqService.chooseCandidates.mockResolvedValue(["Tech Set 1", "Tech Set 2"]);
    reservationsService.resourceLastUsed = vi.fn(async (label) => ({
      status: "ok", resourceName: `DMV Tech Equipment-G-${label}`,
      lastUse: { summary: `${label} event`, startIso: "2025-08-29T18:00:00Z", endIso: "2025-08-29T20:00:00Z" },
    }));
    await handler.handleChannelMessage({ event: msg({ thread_ts: "100.1", text: "all of them" }), client });
    expect(reservationsService.resourceLastUsed).toHaveBeenCalledTimes(2);
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text).toContain("Tech Set 1");
    expect(text).toContain("Tech Set 2");
    expect(text.split("\n").length).toBe(2);
  });

  it("falls through to normal parse when the LLM can't resolve the choice", async () => {
    client.conversations.replies.mockResolvedValue(askThread("hmm not sure"));
    groqService.chooseCandidates.mockResolvedValue([]);
    groqService.parseReservationRequest.mockResolvedValue({ intent: "none" });
    await handler.handleChannelMessage({ event: msg({ thread_ts: "100.1", text: "hmm not sure" }), client });
    expect(groqService.parseReservationRequest).toHaveBeenCalled(); // fell through
  });

  it("asks which resource when the history query is ambiguous", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "tech set" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({
      status: "ambiguous",
      candidates: ["DMV Tech Equipment-G-Tech Set 1", "DMV Tech Equipment-G-Tech Set 2"],
    });
    await handler.handleChannelMessage({ event: msg({ text: "who used the tech set last" }), client });
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text.toLowerCase()).toContain("which");
    expect(text).toContain("Tech Set 1");
    expect(text).toContain("Tech Set 2");
  });

  it("says it doesn't track an unknown resource", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "spaceship" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({ status: "unknown", query: "spaceship" });
    await handler.handleChannelMessage({ event: msg({ text: "who used the spaceship last" }), client });
    expect(client.chat.postMessage.mock.calls[0][0].text.toLowerCase()).toContain("don't track");
  });

  it("reports no recorded usage when the resource has no events", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "popcorn machine" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: null });
    await handler.handleChannelMessage({ event: msg({ text: "when was the popcorn machine last used" }), client });
    expect(client.chat.postMessage.mock.calls[0][0].text.toLowerCase()).toContain("no recorded usage");
  });

  it("omits the title separator when the last-used event has no title", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "history", target: "popcorn machine" });
    reservationsService.resourceLastUsed = vi.fn().mockResolvedValue({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: { summary: "", startIso: "2024-10-31T14:00:00Z", endIso: "2024-10-31T16:00:00Z" } });
    await handler.handleChannelMessage({ event: msg({ text: "when was the popcorn machine last used" }), client });
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text).toContain("Popcorn Machine was last used");
    expect(text).not.toContain("— .");
    expect(text).not.toMatch(/—\s*\.$/);
  });
});

describe("ReservationHandler onestop info", () => {
  let reservationsService, groqService, onestopInfoService, client, handler;
  beforeEach(() => {
    reservationsService = { classifyTarget: vi.fn(), checkRoom: vi.fn(), makeRoomReservation: vi.fn(), listReservations: vi.fn(), resourceLastUsed: vi.fn() };
    groqService = { parseReservationRequest: vi.fn(), chooseCandidates: vi.fn().mockResolvedValue([]), answerInfoQuestion: vi.fn() };
    onestopInfoService = { corpus: vi.fn() };
    client = { chat: { postMessage: vi.fn().mockResolvedValue({}) }, conversations: { replies: vi.fn() }, users: { info: vi.fn() } };
    handler = createReservationHandler({ reservationsService, groqService, onestopInfoService, now: () => new Date("2026-06-24T12:00:00Z") });
  });
  const msg = (over = {}) => ({ type: "message", channel: "Cres", user: "U1", ts: "1.1", text: "", ...over });

  it("answers an info question from the corpus", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "info", target: null, date: null, startTime: null, endTime: null });
    onestopInfoService.corpus.mockResolvedValue("### BULLETIN\nFH Door code | 0326");
    groqService.answerInfoQuestion.mockResolvedValue("The FH door code is 0326.");
    await handler.handleChannelMessage({ event: msg({ text: "what's the door code?" }), client });
    expect(onestopInfoService.corpus).toHaveBeenCalled();
    expect(groqService.answerInfoQuestion).toHaveBeenCalledWith("what's the door code?", "### BULLETIN\nFH Door code | 0326");
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({ username: "OneStop (beta)", text: "The FH door code is 0326." });
  });

  it("replies gracefully when the corpus fetch fails", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "info", target: null });
    onestopInfoService.corpus.mockRejectedValue(new Error("sheets down"));
    await handler.handleChannelMessage({ event: msg({ text: "door code?" }), client });
    expect(client.chat.postMessage.mock.calls[0][0].text.toLowerCase()).toContain("can't reach onestop");
  });

  it("does not call the info service for a reservation intent", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: "FH MPR", date: "2026-06-27" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.listReservations.mockResolvedValue([]);
    await handler.handleChannelMessage({ event: msg({ text: "what's booked in the MPR saturday" }), client });
    expect(onestopInfoService.corpus).not.toHaveBeenCalled();
  });
});
