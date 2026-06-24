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
      thread_ts: "1.1", username: "Reservations (beta)", text: expect.stringContaining("available"),
    }));
  });

  it("rejects a reserve intent with a conflict and does not claim success", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM", endTime: "10:00 PM", what: "Practice" });
    reservationsService.classifyTarget.mockReturnValue({ kind: "room", name: "FH MPR" });
    reservationsService.makeRoomReservation.mockResolvedValue({ ok: false, reason: "conflict", conflicts: [{ what: "Meeting", startMin: 1140, endMin: 1200 }] });
    await handler.handleMention({ event: { text: "book MPR friday 7-10pm", channel: "C1", ts: "2.2" }, say });
    const arg = say.mock.calls[0][0];
    expect(arg.text.toLowerCase()).toContain("conflict");
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

  it("lists all rooms for an explicit date, ephemeral, as Reservations (beta)", async () => {
    groqService.parseReservationRequest.mockResolvedValue({ intent: "list", target: null, date: "2026-06-24" });
    reservationsService.listReservations.mockResolvedValue([
      { dateIso: "2026-06-24", startTime: "1:00 PM", endTime: "2:00 PM", location: "FH MPR", what: "Worktime" },
    ]);
    await handler.handleSlash({ envelope: envelope("all reservations tomorrow"), client });
    expect(reservationsService.listReservations).toHaveBeenCalledWith({ room: null, fromIso: "2026-06-24", toIso: "2026-06-24" });
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: "C1", user: "U1", username: "Reservations (beta)" });
    expect(arg.text).toContain("FH MPR");
    expect(arg.text).toContain("Worktime");
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
