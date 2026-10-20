// tests/services/reservations/rms.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRmsAdapter } from "../../../src/services/reservations/rms.js";
import { nyLocal } from "../../../src/lib/reservation-time.js";

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
      patch: vi.fn().mockResolvedValue({}),
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
      data: { items: calendarId === SET2.calendarId ? [ev("Youth night — Deandra", "2026-10-17T14:00:00-04:00", "2026-10-17T16:00:00-04:00", { id: "EV1", organizer: { email: "alan@acts2.network", displayName: "Alan Chow" } })] : [] },
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
      ref: {
        backend: "rms", eventId: "EV1", organizerEmail: "alan@acts2.network", organizerSelf: false,
        resources: [SET2.calendarId], date: "2026-10-17", start: 840, end: 960, title: "Youth night — Deandra",
      },
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
      requesterName: "Deandra Shim", requesterUserId: "U9",
    });
    expect(res).toEqual({
      status: "booked",
      link: "https://calendar.google.com/calendar/u/0/r?cid=set2%40resource.calendar.google.com",
      ref: {
        backend: "rms", eventId: "E1", organizerEmail: null, organizerSelf: true,
        resources: [SET2.calendarId], date: "2026-10-17", start: 840, end: 960, title: "Youth night — Deandra Shim",
      },
    });
    expect(cal.events.insert).toHaveBeenCalledWith({
      calendarId: "primary",
      // A resource only processes the invite when it is actually sent
      // (live test 2026-10-14: "none" stayed needsAction, "all" accepted in ~6 s).
      sendUpdates: "all",
      requestBody: {
        summary: "Youth night — Deandra Shim",
        description: "Requested by: Deandra Shim\nSlack: <@U9>",
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
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9" });
    expect(res.status).toBe("booked");
    expect(cal.events.get).toHaveBeenCalledTimes(5);
  });

  it("reports a decline that arrives after several seconds", async () => {
    const pending = { data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "needsAction" }] } };
    cal.events.get
      .mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "declined" }] } });
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9" });
    expect(res.status).toBe("unavailable");
  });

  it("deletes the event and reports unavailable when a resource declines", async () => {
    cal.events.get.mockResolvedValue({ data: { attendees: [{ email: SET2.calendarId, resource: true, responseStatus: "declined" }] } });
    const res = await adapter.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9" });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/declined/i);
    expect(cal.events.delete).toHaveBeenCalledWith({ calendarId: "primary", eventId: "E1", sendUpdates: "none" });
  });

  it("does not write when booking is disabled", async () => {
    const off = createRmsAdapter({ calendarClient: cal, catalog: [SET2], bookingEnabled: false, sleep: async () => {} });
    const res = await off.book({ date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9" });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/Google Calendar/);
    expect(cal.events.insert).not.toHaveBeenCalled();
  });

  it("books on the member's calendar when given, even with bot booking disabled", async () => {
    const memberCal = makeCalendar();
    const off = createRmsAdapter({ calendarClient: cal, catalog: [SET2], bookingEnabled: false, sleep: async () => {} });
    const res = await off.book(
      { date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9" },
      { clients: { calendarClient: memberCal } }
    );
    expect(res.status).toBe("booked");
    expect(memberCal.events.insert).toHaveBeenCalledTimes(1);
    expect(memberCal.events.get).toHaveBeenCalled();
    expect(cal.events.insert).not.toHaveBeenCalled();
  });

  describe("cancel", () => {
    const LINK = "https://calendar.google.com/calendar/u/0/r?cid=set2%40resource.calendar.google.com";
    const ref = (extra = {}) => ({
      backend: "rms", eventId: "E1", organizerEmail: null, organizerSelf: true,
      resources: [SET2.calendarId], date: "2026-10-17", start: 840, end: 960, title: "T", ...extra,
    });
    const got = (extra = {}) => ({
      data: {
        status: "confirmed",
        start: { dateTime: nyLocal("2026-10-17", 840), timeZone: "America/New_York" },
        end: { dateTime: nyLocal("2026-10-17", 960), timeZone: "America/New_York" },
        organizer: { email: "bot@x", self: true },
        description: "Requested by: Jon Yen\nSlack: <@U1>",
        attendees: [{ email: SET2.calendarId, resource: true }],
        ...extra,
      },
    });

    it("deletes a bot event with only resource attendees", async () => {
      cal.events.get.mockResolvedValue(got());
      const res = await adapter.cancel(ref());
      expect(res).toEqual({ status: "cancelled", link: LINK });
      expect(cal.events.delete).toHaveBeenCalledWith({ calendarId: "primary", eventId: "E1", sendUpdates: "all" });
      expect(cal.events.patch).not.toHaveBeenCalled();
    });

    it("uses the configured bot calendar id", async () => {
      const a = createRmsAdapter({ calendarClient: cal, catalog: [SET2], botCalendarId: "bot@x", sleep: async () => {} });
      cal.events.get.mockResolvedValue(got());
      await a.cancel(ref());
      expect(cal.events.get).toHaveBeenCalledWith({ calendarId: "bot@x", eventId: "E1" });
      expect(cal.events.delete).toHaveBeenCalledWith({ calendarId: "bot@x", eventId: "E1", sendUpdates: "all" });
    });

    it("ignores the organizer and self attendees when deciding whether people are invited", async () => {
      cal.events.get.mockResolvedValue(got({ attendees: [
        { email: SET2.calendarId, resource: true }, { email: "bot@x" }, { email: "me@x", self: true },
      ] }));
      await adapter.cancel(ref());
      expect(cal.events.delete).toHaveBeenCalledTimes(1);
    });

    it("removes only the booked resources when people are invited", async () => {
      cal.events.get.mockResolvedValue(got({ attendees: [{ email: SET2.calendarId, resource: true }, { email: "pat@x.org" }] }));
      const res = await adapter.cancel(ref());
      expect(res.status).toBe("cancelled");
      expect(cal.events.patch).toHaveBeenCalledWith({
        calendarId: "primary", eventId: "E1", sendUpdates: "all",
        requestBody: { attendees: [{ email: "pat@x.org" }] },
      });
      expect(cal.events.delete).not.toHaveBeenCalled();
    });

    it("removes only the booked resources from a member-made event with no guests and no bot marker", async () => {
      const memberCal = makeCalendar();
      memberCal.events.get.mockResolvedValue(got({ organizer: { email: "me@x", self: true }, description: "Team practice" }));
      const res = await adapter.cancel(ref({ organizerSelf: false, organizerEmail: "me@x" }), { clients: { calendarClient: memberCal } });
      expect(res.status).toBe("cancelled");
      expect(memberCal.events.patch).toHaveBeenCalledWith({
        calendarId: "primary", eventId: "E1", sendUpdates: "all", requestBody: { attendees: [] },
      });
      expect(memberCal.events.delete).not.toHaveBeenCalled();
      memberCal.events.get.mockResolvedValue(got({ organizer: { email: "me@x", self: true }, description: undefined }));
      await adapter.cancel(ref({ organizerSelf: false, organizerEmail: "me@x" }), { clients: { calendarClient: memberCal } });
      expect(memberCal.events.delete).not.toHaveBeenCalled();
    });

    it("returns already for a cancelled event", async () => {
      cal.events.get.mockResolvedValue(got({ status: "cancelled" }));
      expect(await adapter.cancel(ref())).toEqual({ status: "already", link: LINK });
      expect(cal.events.delete).not.toHaveBeenCalled();
    });

    it("returns already for a 404 or 410", async () => {
      cal.events.get.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code: 404 }));
      expect((await adapter.cancel(ref())).status).toBe("already");
      cal.events.get.mockRejectedValueOnce(Object.assign(new Error("Gone"), { response: { status: 410 } }));
      expect((await adapter.cancel(ref())).status).toBe("already");
      expect(cal.events.delete).not.toHaveBeenCalled();
    });

    it("propagates other errors", async () => {
      cal.events.get.mockRejectedValue(Object.assign(new Error("boom"), { code: 500 }));
      await expect(adapter.cancel(ref())).rejects.toThrow("boom");
    });

    it("returns changed when the event moved to another day or time", async () => {
      cal.events.get.mockResolvedValueOnce(got({ start: { dateTime: nyLocal("2026-10-18", 840) }, end: { dateTime: nyLocal("2026-10-18", 960) } }));
      expect((await adapter.cancel(ref())).status).toBe("changed");
      cal.events.get.mockResolvedValueOnce(got({ start: { dateTime: nyLocal("2026-10-17", 900) }, end: { dateTime: nyLocal("2026-10-17", 960) } }));
      expect(await adapter.cancel(ref())).toEqual({ status: "changed", link: LINK });
      expect(cal.events.delete).not.toHaveBeenCalled();
      expect(cal.events.patch).not.toHaveBeenCalled();
    });

    it("compares all-day events by date with a null start", async () => {
      cal.events.get.mockResolvedValue(got({ start: { date: "2026-10-17" }, end: { date: "2026-10-18" } }));
      expect((await adapter.cancel(ref({ start: null, end: null }))).status).toBe("cancelled");
      expect((await adapter.cancel(ref())).status).toBe("changed");
    });

    it("cancels a member-organized event with the member's client on primary", async () => {
      const memberCal = makeCalendar();
      memberCal.events.get.mockResolvedValue(got({ organizer: { email: "me@x", self: true } }));
      const a = createRmsAdapter({ calendarClient: cal, catalog: [SET2], botCalendarId: "bot@x", sleep: async () => {} });
      const res = await a.cancel(ref({ organizerSelf: false, organizerEmail: "me@x" }), { clients: { calendarClient: memberCal } });
      expect(res.status).toBe("cancelled");
      expect(memberCal.events.get).toHaveBeenCalledWith({ calendarId: "primary", eventId: "E1" });
      expect(memberCal.events.delete).toHaveBeenCalledWith({ calendarId: "primary", eventId: "E1", sendUpdates: "all" });
      expect(cal.events.get).not.toHaveBeenCalled();
    });

    it("throws when a non-bot event has no member clients", async () => {
      await expect(adapter.cancel(ref({ organizerSelf: false }))).rejects.toThrow("member clients required");
      expect(cal.events.get).not.toHaveBeenCalled();
    });

    it("keeps the same eventId when one event is listed from two resources", async () => {
      cal.events.list.mockResolvedValue({ data: { items: [ev("Shared", "2026-10-17T14:00:00-04:00", "2026-10-17T16:00:00-04:00", { id: "EV9" })] } });
      const { reservations } = await adapter.listReservations({ from: "2026-10-17", to: "2026-10-17", items: [SET2, POOL] });
      expect(reservations.map((r) => r.ref.eventId)).toEqual(["EV9", "EV9"]);
      expect(reservations.map((r) => r.ref.resources)).toEqual([[SET2.calendarId], [POOL.calendarId]]);
    });
  });
});
