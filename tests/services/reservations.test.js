// tests/services/reservations.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsService } from "../../src/services/reservations.js";
import { createRoomMatcher } from "../../src/lib/reservation-rooms.js";

function makeService(weekEvents, tabs = ["6/22-6/26 M-F", "6/27-6/28 S-Su"]) {
  const sheetService = {
    listScheduleTabs: vi.fn().mockResolvedValue(tabs),
    readWeekEvents: vi.fn().mockResolvedValue(weekEvents),
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


describe("listRoom", () => {
  it("returns ISO dateIso and formatted times for matching room events", async () => {
    const weekEvents = [
      { rowIndex: 1, date: { month: 6, day: 24 }, startMin: 18 * 60, endMin: 19 * 60, allDay: false, location: "FH MPR", what: "Practice" },
    ];
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(["6/22-6/26 M-F"]),
      readWeekEvents: vi.fn().mockResolvedValue(weekEvents),
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

describe("resourceLastUsed", () => {
  function svc(lastEventImpl) {
    const calendarService = { listEvents: vi.fn(), isBusy: vi.fn(), insertEvent: vi.fn(), lastEvent: vi.fn(lastEventImpl) };
    const resourceCalendars = {
      "DMV Tech Equipment-G-Tech Set 1": "c1",
      "DMV Tech Equipment-G-Tech Set 2": "c2",
      "DMV Tech Equipment-G-Tech Set 3": "c3",
      "DMV Tech Equipment-G-Tech Set 4": "c4",
      "DMV Accessories-Popcorn Machine": "cp",
    };
    const service = createReservationsService({
      sheetService: { listScheduleTabs: vi.fn(), readWeekEvents: vi.fn() },
      calendarService,
      roomMatcher: createRoomMatcher(["FH MPR"], {}),
      resourceCalendars,
      now: () => new Date("2026-06-24T12:00:00Z"),
    });
    return { service, calendarService };
  }

  it("unknown when no resource matches", async () => {
    const { service } = svc();
    expect(await service.resourceLastUsed("spaceship")).toEqual({ status: "unknown", query: "spaceship" });
  });

  it("ambiguous when multiple resources match", async () => {
    const { service } = svc();
    const r = await service.resourceLastUsed("tech set");
    expect(r.status).toBe("ambiguous");
    expect(r.candidates).toHaveLength(4);
  });

  it("ok with last use for a single match", async () => {
    const last = { summary: "Halloween Fest", startIso: "2024-10-31T14:00:00Z", endIso: "2024-10-31T16:00:00Z" };
    const { service, calendarService } = svc(async () => last);
    const r = await service.resourceLastUsed("popcorn machine");
    expect(r).toEqual({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: last });
    expect(calendarService.lastEvent).toHaveBeenCalledWith("cp");
  });

  it("ok with null lastUse when the calendar has no events", async () => {
    const { service } = svc(async () => null);
    const r = await service.resourceLastUsed("popcorn machine");
    expect(r).toEqual({ status: "ok", resourceName: "DMV Accessories-Popcorn Machine", lastUse: null });
  });

  it("error when the calendar read throws", async () => {
    const { service } = svc(async () => { throw new Error("boom"); });
    const r = await service.resourceLastUsed("popcorn machine");
    expect(r).toEqual({ status: "error", resourceName: "DMV Accessories-Popcorn Machine" });
  });
});

describe("listReservations", () => {
  function svc(tabs, eventsByTab) {
    const sheetService = {
      listScheduleTabs: vi.fn().mockResolvedValue(tabs),
      readWeekEvents: vi.fn(async (tab) => eventsByTab[tab] || []),
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
