// tests/services/reservations/rms.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRmsAdapter } from "../../../src/services/reservations/rms.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "set2@resource.calendar.google.com" };
const POOL = { label: "Kiddie Pool", category: "accessories", backend: "rms", calendarId: "pool@resource.calendar.google.com" };

function ev(summary, startIso, endIso, extra = {}) {
  return { summary, start: { dateTime: startIso }, end: { dateTime: endIso }, status: "confirmed", ...extra };
}

function makeCalendar() {
  return {
    events: {
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
      insert: vi.fn().mockResolvedValue({ data: { id: "E1" } }),
      get: vi.fn().mockResolvedValue({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "accepted" }] } }),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("rms adapter", () => {
  let cal;
  let adapter;
  beforeEach(() => {
    cal = makeCalendar();
    adapter = createRmsAdapter({ calendarClient: cal, catalog: [SET2, POOL], sleep: async () => {} });
  });

  it("lists every catalog calendar over the NY window", async () => {
    cal.events.list.mockImplementation(async ({ calendarId }) => ({
      data: { items: calendarId === SET2.calendarId ? [ev("Youth night — Deandra", "2026-10-17T14:00:00-04:00", "2026-10-17T16:00:00-04:00", { organizer: { email: "alan@acts2.network", displayName: "Alan Chow" } })] : [] },
    }));
    const { reservations, errors } = await adapter.listReservations({ from: "2026-10-12", to: "2026-10-18" });
    expect(errors).toEqual([]);
    expect(cal.events.list).toHaveBeenCalledWith({
      calendarId: SET2.calendarId, timeMin: "2026-10-12T00:00:00-04:00", timeMax: "2026-10-19T00:00:00-04:00",
      singleEvents: true, orderBy: "startTime", maxResults: 250,
    });
    expect(reservations).toEqual([{
      category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 960,
      title: "Youth night — Deandra", holder: "Alan Chow", holderUserId: null, holderEmail: "alan@acts2.network",
    }]);
  });

  it("reads the requester back out of bot-made events", async () => {
    cal.events.list.mockResolvedValueOnce({
      data: { items: [ev("Rally — Jina", "2026-10-17T14:00:00-04:00", "2026-10-17T15:00:00-04:00", {
        organizer: { email: "bot@x", self: true },
        description: "Requested by: Jina Kim\nSlack: <@U123>\nhttps://slack/p1",
      })] },
    });
    const { reservations } = await adapter.listReservations({ from: "2026-10-17", to: "2026-10-17", items: [SET2] });
    expect(reservations[0]).toMatchObject({ holder: "Jina Kim", holderUserId: "U123" });
  });

  it("reports one failed calendar without failing the rest", async () => {
    cal.events.list.mockImplementation(async ({ calendarId }) => {
      if (calendarId === POOL.calendarId) throw new Error("403 forbidden");
      return { data: { items: [] } };
    });
    const { reservations, errors } = await adapter.listReservations({ from: "2026-10-12", to: "2026-10-18" });
    expect(reservations).toEqual([]);
    expect(errors).toEqual(["Kiddie Pool: 403 forbidden"]);
  });

  it("throws when every calendar fails", async () => {
    cal.events.list.mockRejectedValue(new Error("invalid_grant"));
    await expect(adapter.listReservations({ from: "2026-10-12", to: "2026-10-18" })).rejects.toThrow(/invalid_grant/);
  });

  it("finds an overlapping event and skips cancelled and all-day-free ones", async () => {
    cal.events.list.mockResolvedValue({ data: { items: [
      ev("A", "2026-10-17T13:00:00-04:00", "2026-10-17T14:30:00-04:00"),
      ev("B", "2026-10-17T16:00:00-04:00", "2026-10-17T17:00:00-04:00"),
      ev("C", "2026-10-17T14:00:00-04:00", "2026-10-17T15:00:00-04:00", { status: "cancelled" }),
    ] } });
    const hits = await adapter.findConflicts({ date: "2026-10-17", start: 840, end: 960, items: [SET2] });
    expect(hits.map((h) => h.title)).toEqual(["A"]);
  });

  it("books by inviting the resource and returns booked once accepted", async () => {
    const res = await adapter.book({
      date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night",
      requesterName: "Deandra Shim", requesterUserId: "U9", permalink: "https://slack/p",
    });
    expect(res).toEqual({ status: "booked", link: "https://calendar.google.com/calendar/u/0/r?cid=set2%40resource.calendar.google.com" });
    expect(cal.events.insert).toHaveBeenCalledWith({
      calendarId: "primary",
      // A resource only processes the invite when it is actually sent
      // (live test 2026-10-14: "none" stayed needsAction, "all" accepted in ~6 s).
      sendUpdates: "all",
      requestBody: {
        summary: "Youth night — Deandra Shim",
        description: "Requested by: Deandra Shim\nSlack: <@U9>\nhttps://slack/p",
        start: { dateTime: "2026-10-17T14:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-10-17T16:00:00", timeZone: "America/New_York" },
        attendees: [{ email: SET2.calendarId, resource: true }],
      },
    });
  });

  it("keeps waiting for a slow resource to accept", async () => {
    const pending = { data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "needsAction" }] } };
    const accepted = { data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "accepted" }] } };
    cal.events.get
      .mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(accepted);
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" });
    expect(res.status).toBe("booked");
    expect(cal.events.get).toHaveBeenCalledTimes(5);
  });

  it("reports a decline that arrives after several seconds", async () => {
    const pending = { data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "needsAction" }] } };
    cal.events.get
      .mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "declined" }] } });
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" });
    expect(res.status).toBe("unavailable");
  });

  it("deletes the event and reports unavailable when a resource declines", async () => {
    cal.events.get.mockResolvedValue({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "declined" }] } });
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/declined/i);
    expect(cal.events.delete).toHaveBeenCalledWith({ calendarId: "primary", eventId: "E1", sendUpdates: "none" });
  });

  it("does not write when booking is disabled", async () => {
    const off = createRmsAdapter({ calendarClient: cal, catalog: [SET2], bookingEnabled: false, sleep: async () => {} });
    const res = await off.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/Google Calendar/);
    expect(cal.events.insert).not.toHaveBeenCalled();
  });
});
