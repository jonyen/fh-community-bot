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

  it("insertEvent forwards an optional timeZone on start and end", async () => {
    mockCal.events.insert.mockResolvedValue({ data: { id: "evtTZ" } });
    await service.insertEvent("cal1", {
      summary: "Room", startIso: "2026-06-26T19:00:00", endIso: "2026-06-26T22:00:00",
      description: "", timeZone: "America/New_York",
    });
    const arg = mockCal.events.insert.mock.calls[0][0];
    expect(arg.requestBody.start).toEqual({ dateTime: "2026-06-26T19:00:00", timeZone: "America/New_York" });
    expect(arg.requestBody.end).toEqual({ dateTime: "2026-06-26T22:00:00", timeZone: "America/New_York" });
  });

  it("lastEvent returns the most recent event in the window", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [
      { summary: "Old", start: { dateTime: "2025-01-01T10:00:00Z" }, end: { dateTime: "2025-01-01T11:00:00Z" } },
      { summary: "Recent", start: { dateTime: "2025-08-29T18:00:00Z" }, end: { dateTime: "2025-08-29T20:00:00Z" } },
    ] } });
    const out = await service.lastEvent("cal1");
    expect(out).toEqual({ summary: "Recent", startIso: "2025-08-29T18:00:00Z", endIso: "2025-08-29T20:00:00Z" });
    const arg = mockCal.events.list.mock.calls[0][0];
    expect(arg).toMatchObject({ calendarId: "cal1", singleEvents: true, orderBy: "startTime" });
    expect(typeof arg.timeMin).toBe("string");
    expect(typeof arg.timeMax).toBe("string");
    expect(arg.timeMin < arg.timeMax).toBe(true);
  });

  it("lastEvent returns null when there are no events", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [] } });
    expect(await service.lastEvent("cal1")).toBeNull();
  });

  it("lastEvent handles all-day events (date instead of dateTime)", async () => {
    mockCal.events.list.mockResolvedValue({ data: { items: [
      { summary: "Camp", start: { date: "2025-08-06" }, end: { date: "2025-08-07" } },
    ] } });
    expect(await service.lastEvent("cal1")).toEqual({ summary: "Camp", startIso: "2025-08-06", endIso: "2025-08-07" });
  });

  it("lastEvent paginates and returns the most recent across pages", async () => {
    mockCal.events.list
      .mockResolvedValueOnce({ data: { items: [ { summary: "Old", start: { dateTime: "2025-01-01T10:00:00Z" }, end: { dateTime: "2025-01-01T11:00:00Z" } } ], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { items: [ { summary: "Newest", start: { dateTime: "2025-09-01T10:00:00Z" }, end: { dateTime: "2025-09-01T11:00:00Z" } } ] } });
    const out = await service.lastEvent("cal1");
    expect(out.summary).toBe("Newest");
    expect(mockCal.events.list).toHaveBeenCalledTimes(2);
    expect(mockCal.events.list.mock.calls[1][0]).toMatchObject({ pageToken: "p2" });
  });
});
