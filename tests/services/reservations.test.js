// tests/services/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsService } from "../../src/services/reservations.js";
import { createRoomMatcher } from "../../src/lib/reservation-rooms.js";

function makeService(weekEvents, tabs = ["6/22-6/26 M-F", "6/27-6/28 S-Su"], venueCalendars = {}) {
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
    venueCalendars,
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

  it("inserts after last same-day row using true rowIndex in multi-day sparse tab", async () => {
    const sparseEvents = [
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "AM" },
      { rowIndex: 2, date: { month: 6, day: 24 }, startMin: 13 * 60, endMin: 14 * 60, allDay: false, location: "Childcare Room", what: "PM" },
      { rowIndex: 5, date: { month: 6, day: 25 }, startMin: 9 * 60, endMin: 10 * 60, allDay: false, location: "FH MPR", what: "Next day" },
    ];
    // Book FH MPR on 6/24 at 9:00 PM — latest on 6/24, no later same-day row
    const { service: svc1, sheetService: ss1 } = makeService(sparseEvents);
    const res1 = await svc1.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "9:00 PM", endTime: "10:00 PM", what: "Late", who: "Test" });
    expect(res1.ok).toBe(true);
    const [, rowIndex1] = ss1.insertRow.mock.calls[0];
    // Should insert after last 6/24 row (rowIndex 2) → insertAt = 3, NOT all.length+1 (4) and NOT into the 6/25 block
    expect(rowIndex1).toBe(3);

    // Book FH MPR on 6/25 at 11:00 PM — latest on 6/25 (last day in tab)
    const { service: svc2, sheetService: ss2 } = makeService(sparseEvents);
    const res2 = await svc2.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-25", startTime: "11:00 PM", endTime: "11:59 PM", what: "EndOfDay", who: "Test" });
    expect(res2.ok).toBe(true);
    const [, rowIndex2] = ss2.insertRow.mock.calls[0];
    // Should insert after last 6/25 row (rowIndex 5) → insertAt = 6
    expect(rowIndex2).toBe(6);
  });

  it("mirrors a successful room booking to the venue calendar", async () => {
    const calInsert = vi.fn().mockResolvedValue({ id: "evt1" });
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue([]),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: calInsert },
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars: {},
      venueCalendars: { "FH MPR": "venue_cal_mpr" },
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice", who: "College" });
    expect(res.ok).toBe(true);
    expect(res.mirrored).toBe(true);
    expect(calInsert).toHaveBeenCalledWith("venue_cal_mpr", expect.objectContaining({
      summary: expect.stringContaining("Practice"), timeZone: "America/New_York",
    }));
  });

  it("still succeeds (mirrored:false) when the room has no venue calendar", async () => {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue([]),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars: {},
      venueCalendars: {},
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice" });
    expect(res.ok).toBe(true);
    expect(res.mirrored).toBe(false);
  });

  it("still returns ok when the mirror call throws (sheet is truth)", async () => {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue([]),
      insertRow: vi.fn().mockResolvedValue(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn().mockRejectedValue(new Error("cal down")) },
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars: {},
      venueCalendars: { "FH MPR": "venue_cal_mpr" },
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    const res = await service.makeRoomReservation({ room: "FH MPR", dateIso: "2026-06-24", startTime: "6:00 PM", endTime: "7:00 PM", what: "Practice" });
    expect(res.ok).toBe(true);
    expect(res.mirrored).toBe(false);
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

describe("listReservations", () => {
  function svc(tabs, eventsByTab) {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(tabs),
      readWeekEvents: vi.fn(async (tab) => eventsByTab[tab] || []),
      insertRow: vi.fn(),
    };
    const service = createReservationsService({
      sheetService,
      calendarService: { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn() },
      roomMatcher: createRoomMatcher(["FH MPR", "Childcare Room"], {}),
      resourceCalendars: {},
      now: () => new Date("2026-06-23T12:00:00Z"),
    });
    return { service, sheetService };
  }

  it("lists all rooms in a single-day window, only that day's events", async () => {
    const { service } = svc(["6/22-6/26 M-F"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "AM" },
        { rowIndex: 2, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 19 * 60, allDay: false, location: "Childcare Room", what: "PM" },
        { rowIndex: 3, date: { month: 6, day: 25 }, startMin: 9 * 60, endMin: 10 * 60, allDay: false, location: "FH MPR", what: "NextDay" },
      ],
    });
    const out = await service.listReservations({ fromIso: "2026-06-24", toIso: "2026-06-24" });
    expect(out.map((i) => i.what)).toEqual(["AM", "PM"]); // 6/25 excluded; sorted by start
    expect(out[0]).toMatchObject({ dateIso: "2026-06-24", startTime: "10:00 AM", location: "FH MPR" });
  });

  it("filters to a single room across the window", async () => {
    const { service } = svc(["6/22-6/26 M-F"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "MPR-AM" },
        { rowIndex: 2, date: { month: 6, day: 25 }, startMin: 18 * 60, endMin: 19 * 60, allDay: false, location: "Childcare Room", what: "CC" },
      ],
    });
    const out = await service.listReservations({ room: "FH MPR", fromIso: "2026-06-24", toIso: "2026-06-26" });
    expect(out.map((i) => i.what)).toEqual(["MPR-AM"]);
  });

  it("reads each tab once across a multi-tab window and sorts by date then start", async () => {
    const { service, sheetService } = svc(["6/22-6/26 M-F", "6/27-6/28 S-Su"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 26 }, startMin: 20 * 60, endMin: 21 * 60, allDay: false, location: "FH MPR", what: "Fri-PM" },
        { rowIndex: 2, date: { month: 6, day: 26 }, startMin: 7 * 60, endMin: 8 * 60, allDay: false, location: "FH MPR", what: "Fri-AM" },
      ],
      "6/27-6/28 S-Su": [
        { rowIndex: 1, date: { month: 6, day: 27 }, startMin: 9 * 60, endMin: 10 * 60, allDay: false, location: "Childcare Room", what: "Sat" },
      ],
    });
    const out = await service.listReservations({ fromIso: "2026-06-26", toIso: "2026-06-28" });
    expect(out.map((i) => i.what)).toEqual(["Fri-AM", "Fri-PM", "Sat"]);
    expect(sheetService.readWeekEvents).toHaveBeenCalledTimes(2); // each tab read once (dedup)
  });

  it("returns empty array when nothing falls in the window", async () => {
    const { service } = svc(["6/22-6/26 M-F"], {
      "6/22-6/26 M-F": [
        { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 10 * 60, endMin: 11 * 60, allDay: false, location: "FH MPR", what: "AM" },
      ],
    });
    const out = await service.listReservations({ fromIso: "2026-06-30", toIso: "2026-07-01" });
    expect(out).toEqual([]);
  });
});
