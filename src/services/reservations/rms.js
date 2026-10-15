// src/services/reservations/rms.js
// Tech, sports, outreach and accessories are Workspace resource calendars
// (RMS). The bot only has reader access to them, so it books by creating an
// event on its own calendar with the resource as an attendee; the resource
// accepts or declines it. RMS_BOOKING_ENABLED=false turns writes off, for when
// the bot's account can't book resources.
import { TZ, nyDateTime, nyLocal, nyParts, addDaysIso, overlaps } from "../../lib/reservation-time.js";
import { calendarLink } from "../../lib/rms-catalog.js";

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function holderOf(e) {
  const desc = e.description || "";
  const userId = desc.match(/Slack: <@([A-Z0-9]+)>/)?.[1] || null;
  const name = desc.match(/Requested by: (.+)/)?.[1]?.trim();
  if (e.organizer?.self && name) return { holder: name, holderUserId: userId, holderEmail: null };
  const email = e.organizer?.email || e.creator?.email || null;
  return { holder: e.organizer?.displayName || email || "someone", holderUserId: userId, holderEmail: email };
}

function toReservation(entry, e) {
  const allDay = !e.start?.dateTime;
  const s = allDay ? null : nyParts(e.start.dateTime);
  const en = allDay ? null : nyParts(e.end.dateTime);
  return {
    category: entry.category,
    item: entry.label,
    date: allDay ? e.start.date : s.date,
    start: allDay ? null : s.min,
    // An event running past midnight blocks the rest of its first day.
    end: allDay ? null : en.date === s.date ? en.min : 1440,
    title: e.summary || "",
    ...holderOf(e),
  };
}

export function createRmsAdapter({
  calendarClient, catalog, bookingEnabled = true, botCalendarId = "primary", concurrency = 8,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const link = "https://calendar.google.com";

  async function eventsFor(entry, from, to) {
    const res = await calendarClient.events.list({
      calendarId: entry.calendarId,
      timeMin: nyDateTime(from, 0),
      timeMax: nyDateTime(addDaysIso(to, 1), 0),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    return (res.data.items || []).filter((e) => e.status !== "cancelled").map((e) => toReservation(entry, e));
  }

  async function listReservations({ from, to, items }) {
    const entries = items?.length ? items : catalog;
    const results = await mapLimit(entries, concurrency, async (entry) => {
      try {
        return { ok: await eventsFor(entry, from, to) };
      } catch (err) {
        return { error: `${entry.label}: ${err.message}` };
      }
    });
    const errors = results.filter((r) => r.error).map((r) => r.error);
    if (entries.length > 0 && errors.length === entries.length) throw new Error(errors[0]);
    return { reservations: results.flatMap((r) => r.ok || []), errors };
  }

  async function findConflicts({ date, start, end, items }) {
    const lists = await mapLimit(items, concurrency, (entry) => eventsFor(entry, date, date));
    return lists.flat().filter((r) => r.date === date && overlaps(start, end, r.start, r.end));
  }

  async function book({ date, start, end, items, title, requesterName, requesterUserId, permalink }) {
    const itemLink = calendarLink(items[0].calendarId);
    if (!bookingEnabled) {
      return { status: "unavailable", reason: "Please book this one in Google Calendar (RMS) for now.", link: itemLink };
    }
    // The resource only processes the invite when it is sent; with "none" it
    // stays needsAction forever. The resource is the only attendee, so no
    // person gets an email.
    const res = await calendarClient.events.insert({
      calendarId: botCalendarId,
      sendUpdates: "all",
      requestBody: {
        summary: `${title} — ${requesterName}`,
        description: `Requested by: ${requesterName}\nSlack: <@${requesterUserId}>\n${permalink}`,
        start: { dateTime: nyLocal(date, start), timeZone: TZ },
        end: { dateTime: nyLocal(date, end), timeZone: TZ },
        attendees: items.map((i) => ({ email: i.calendarId, resource: true })),
      },
    });
    const eventId = res.data.id;
    // Resources answer the invite a few seconds after it is sent (about 6 s
    // in a live test), so allow up to 12 s.
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(1500);
      const got = await calendarClient.events.get({ calendarId: botCalendarId, eventId });
      const resources = (got.data.attendees || []).filter((a) => a.resource);
      const declined = resources.filter((a) => a.responseStatus === "declined");
      if (declined.length > 0) {
        await calendarClient.events.delete({ calendarId: botCalendarId, eventId, sendUpdates: "none" });
        return { status: "unavailable", reason: "The calendar declined the booking (it may already be taken).", link: itemLink };
      }
      if (resources.every((a) => a.responseStatus === "accepted")) break;
    }
    return { status: "booked", link: itemLink };
  }

  return { backend: "rms", link, listReservations, findConflicts, book };
}
