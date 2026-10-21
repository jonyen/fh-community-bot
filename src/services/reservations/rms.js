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

// book() writes this line, so it marks an event the bot made.
const SLACK_MARK = /Slack: <@([A-Z0-9]+)>/;

function holderOf(e) {
  const desc = e.description || "";
  const userId = desc.match(SLACK_MARK)?.[1] || null;
  const name = desc.match(/Requested by: (.+)/)?.[1]?.trim();
  if (e.organizer?.self && name) return { holder: name, holderUserId: userId, holderEmail: null };
  const email = e.organizer?.email || e.creator?.email || null;
  return { holder: e.organizer?.displayName || email || "someone", holderUserId: userId, holderEmail: email };
}

function whenOf(e) {
  const allDay = !e.start?.dateTime;
  const s = allDay ? null : nyParts(e.start.dateTime);
  const en = allDay ? null : nyParts(e.end.dateTime);
  return {
    date: allDay ? e.start.date : s.date,
    start: allDay ? null : s.min,
    // An event running past midnight blocks the rest of its first day.
    end: allDay ? null : en.date === s.date ? en.min : 1440,
  };
}

function toReservation(entry, e) {
  const when = whenOf(e);
  const title = e.summary || "";
  return {
    category: entry.category,
    item: entry.label,
    ...when,
    title,
    ...holderOf(e),
    ref: {
      backend: "rms",
      eventId: e.id,
      organizerEmail: e.organizer?.email || null,
      organizerSelf: !!e.organizer?.self,
      resources: [entry.calendarId],
      ...when,
      title,
    },
  };
}

const isGone = (err) => [404, 410].includes(err?.code) || [404, 410].includes(err?.response?.status);

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

  // One calendar read per item over the whole span, however many dates.
  async function checkDates({ dates, start, end, items }) {
    if (dates.length === 0) return {};
    const sorted = [...dates].sort();
    const lists = await mapLimit(items, concurrency, (entry) => eventsFor(entry, sorted[0], sorted.at(-1)));
    const all = lists.flat();
    return Object.fromEntries(dates.map((date) => [date, {
      conflicts: all.filter((r) => r.date === date && overlaps(start, end, r.start, r.end)),
      unavailable: null,
    }]));
  }

  async function findConflicts({ date, start, end, items }) {
    return (await checkDates({ dates: [date], start, end, items }))[date].conflicts;
  }

  async function book({ date, start, end, items, title, requesterName, requesterUserId }, { clients } = {}) {
    const itemLink = calendarLink(items[0].calendarId);
    // A connected member books on their own calendar; the flag only governs
    // booking on the bot's.
    if (!bookingEnabled && !clients) {
      return { status: "unavailable", reason: "Please book this one in Google Calendar (RMS) for now.", link: itemLink };
    }
    const cal = clients?.calendarClient || calendarClient;
    // The resource only processes the invite when it is sent; with "none" it
    // stays needsAction forever. The resource is the only attendee, so no
    // person gets an email.
    const res = await cal.events.insert({
      calendarId: botCalendarId,
      sendUpdates: "all",
      requestBody: {
        summary: `${title} — ${requesterName}`,
        description: `Requested by: ${requesterName}\nSlack: <@${requesterUserId}>`,
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
      const got = await cal.events.get({ calendarId: botCalendarId, eventId });
      const resources = (got.data.attendees || []).filter((a) => a.resource);
      const declined = resources.filter((a) => a.responseStatus === "declined");
      if (declined.length > 0) {
        await cal.events.delete({ calendarId: botCalendarId, eventId, sendUpdates: "none" });
        return { status: "unavailable", reason: "The calendar declined the booking (it may already be taken).", link: itemLink };
      }
      if (resources.every((a) => a.responseStatus === "accepted")) break;
    }
    const ref = {
      backend: "rms", eventId, organizerEmail: null, organizerSelf: !clients,
      resources: items.map((i) => i.calendarId), date, start, end, title: `${title} — ${requesterName}`,
    };
    return { status: "booked", link: itemLink, ref };
  }

  // Delete an event the bot made when nobody else is invited; otherwise
  // (made in Google Calendar, or with guests) only release the booked
  // resources so the people's event survives.
  async function cancel(ref, { clients } = {}) {
    const [cal, calendarId] = ref.organizerSelf ? [calendarClient, botCalendarId] : [clients?.calendarClient, "primary"];
    if (!cal) throw new Error("member clients required");
    const itemLink = calendarLink(ref.resources[0]);
    const eventId = ref.eventId;
    let e;
    try {
      e = (await cal.events.get({ calendarId, eventId })).data;
    } catch (err) {
      if (isGone(err)) return { status: "already", link: itemLink };
      throw err;
    }
    if (e.status === "cancelled") return { status: "already", link: itemLink };
    const now = whenOf(e);
    if (now.date !== ref.date || now.start !== ref.start) return { status: "changed", link: itemLink };
    const organizer = e.organizer?.email;
    const attendees = e.attendees || [];
    const people = attendees.filter((a) => !a.resource && !a.self && a.email !== organizer);
    if (people.length === 0 && SLACK_MARK.test(e.description || "")) {
      await cal.events.delete({ calendarId, eventId, sendUpdates: "all" });
    } else {
      await cal.events.patch({
        calendarId, eventId, sendUpdates: "all",
        requestBody: { attendees: attendees.filter((a) => !ref.resources.includes(a.email)) },
      });
    }
    return { status: "cancelled", link: itemLink };
  }

  return { backend: "rms", link, listReservations, checkDates, findConflicts, book, cancel };
}
