// tests/services/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsService } from "../../src/services/reservations.js";
import { createRoomMatcher } from "../../src/lib/reservation-rooms.js";

function makeService(weekEvents, tabs = ["6/22-6/26 M-F", "6/27-6/28 S-Su"]) {
  const sheetService = {
    listScheduleTabs: vi.fn().mockResolvedValue(tabs),
    readWeekEvents: vi.fn().mockResolvedValue(weekEvents),
    insertRow: vi.fn().mockResolvedValue(),
  };
  const roomMatcher = createRoomMatcher(["FH MPR", "Childcare Room"], {});
  const service = createReservationsService({
    sheetService,
    calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
    roomMatcher,
    resourceCalendars: { "projector": "cal_projector" },
    now: () => new Date("2026-06-23T12:00:00Z"),
  });
  return { service, sheetService };
}

describe("classifyTarget", () => {
  it("recognizes a room", () => {
    const { service } = makeService([]);
    expect(service.classifyTarget("MPR... FH MPR").kind).toBe("room");
  });
  it("recognizes a resource", () => {
    const { service } = makeService([]);
    expect(service.classifyTarget("projector")).toEqual({ kind: "resource", name: "projector", calendarId: "cal_projector" });
  });
  it("returns unmanaged otherwise", () => {
    const { service } = makeService([]);
    expect(service.classifyTarget("National Mall").kind).toBe("unmanaged");
  });
});

describe("checkRoom", () => {
  it("reports available when no overlap", async () => {
    const { service } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "X" },
    ]);
    const res = await service.checkRoom({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "9:00 PM" });
    expect(res.available).toBe(true);
    expect(res.conflicts).toHaveLength(0);
  });
  it("reports a conflict on overlap", async () => {
    const { service } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 20 * 60, allDay: false, location: "FH MPR", what: "Meeting" },
    ]);
    const res = await service.checkRoom({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:30 PM", endTime: "9:00 PM" });
    expect(res.available).toBe(false);
    expect(res.conflicts[0].what).toBe("Meeting");
  });
});

describe("makeRoomReservation", () => {
  it("rejects without writing when a conflict exists", async () => {
    const { service, sheetService } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 20 * 60, allDay: false, location: "FH MPR", what: "Meeting" },
    ]);
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:30 PM", endTime: "9:00 PM", what: "Practice", who: "College" });
    expect(res.ok).toBe(false);
    expect(sheetService.insertRow).not.toHaveBeenCalled();
  });
  it("inserts a chronologically ordered row when free", async () => {
    const { service, sheetService } = makeService([
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "Morning" },
      { rowIndex: 2, date: { month: 6, day: 24 }, startMin: 20 * 60, endMin: 21 * 60, allDay: false, location: "Childcare Room", what: "Evening" },
    ]);
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice", who: "College" });
    expect(res.ok).toBe(true);
    // 6:00 PM on 6/24 sorts after row 1 (10am) and before row 2 (8pm) -> insert at index 2
    const [tab, rowIndex0, values] = sheetService.insertRow.mock.calls[0];
    expect(tab).toBe("6/22-6/26 M-F");
    expect(rowIndex0).toBe(2);
    expect(values[0]).toBe("6/24 Wed"); // DATE formatted M/D Ddd (2026-06-24 is a Wednesday)
    expect(values[6]).toBe("FH MPR");   // LOCATION
  });
});

describe("listRoom", () => {
  it("returns ISO dateIso and formatted times for matching room events", async () => {
    const weekEvents = [
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 19 * 60, allDay: false, location: "FH MPR", what: "Practice" },
    ];
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue(weekEvents),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const roomMatcher = createRoomMatcher(["FH MPR"], {});
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
      roomMatcher,
      resourceCalendars: {},
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const result = await service.listRoom({ room: "FH MPR", fromIso: "2026-06-24", toIso: "2026-06-24" });
    expect(result).toHaveLength(1);
    expect(result[0].dateIso).toBe("2026-06-24");
    expect(result[0].startTime).toBe("6:00 PM");
    expect(result[0].what).toBe("Practice");
  });
});
