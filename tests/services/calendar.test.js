// tests/services/calendar.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCalendarService } from "../../src/services/calendar.js";

describe("CalendarService", () => {
  let mockCal;
  let service;
  beforeEach(() => {
    mockCal = {
      events: { list: vi.fn(), insert: vi.fn() },
      freebusy: { query: vi.fn() },
    };
    service = createCalendarService(mockCal);
  });

  it("listEvents maps the API response", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [
      { summary: "Practice", start: { dateTime: "2026-06-24T18:00:00Z" }, end: { dateTime: "2026-06-24T20:00:00Z" } },
    ] } });
    const out = await service.listEvents("cal1", "2026-06-24T00:00:00Z", "2026-06-25T00:00:00Z");
    expect(out).toEqual([{ summary: "Practice", startIso: "2026-06-24T18:00:00Z", endIso: "2026-06-24T20:00:00Z" }]);
  });

  it("isBusy true when freebusy reports a busy block", async () => {
    mockCal.freebusy.query.mockResolvedValue({ data: { calendars: { cal1: { busy: [{ start: "x", end: "y" }] } } } });
    expect(await service.isBusy("cal1", "a", "b")).toBe(true);
  });

  it("isBusy false when no busy blocks", async () => {
    mockCal.freebusy.query.mockResolvedValue({ data: { calendars: { cal1: { busy: [] } } } });
    expect(await service.isBusy("cal1", "a", "b")).toBe(false);
  });

  it("insertEvent returns the new id", async () => {
    mockCal.events.insert.mockResolvedValue({ data: { id: "evt123" } });
    const res = await service.insertEvent("cal1", {
      summary: "Team", startIso: "2026-06-24T18:00:00Z", endIso: "2026-06-24T19:00:00Z", description: "d",
    });
    expect(res).toEqual({ id: "evt123" });
    expect(mockCal.events.insert).toHaveBeenCalledWith(expect.objectContaining({ calendarId: "cal1" }));
  });
});
