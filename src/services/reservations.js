// src/services/reservations.js
import { selectTabForDate } from "../lib/reservation-tabs.js";
import { parseTimeToMinutes, formatMinutes, inferYear } from "../lib/reservation-time.js";
import { createRoomMatcher } from "../lib/reservation-rooms.js";
import { findRoomConflicts } from "../lib/reservation-overlap.js";

function sameDate(eventDate, dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return eventDate && eventDate.month === d.getUTCMonth() + 1 && eventDate.day === d.getUTCDate();
}

export function createReservationsService({ sheetService, calendarService, roomMatcher, resourceCalendars, now }) {
  // Resource calendars are keyed by their full Google resource title
  // (e.g. "DMV Accessories-Popcorn Machine"). Build a forgiving matcher over
  // those titles so a user phrase ("popcorn machine") resolves via the same
  // normalize+substring logic the room matcher uses.
  const resourceMatcher = createRoomMatcher(Object.keys(resourceCalendars || {}), {});

  function classifyTarget(target) {
    const room = roomMatcher.match(target);
    if (room) return { kind: "room", name: room };
    const resourceTitle = resourceMatcher.match(target);
    if (resourceTitle) {
      return { kind: "resource", name: resourceTitle, calendarId: resourceCalendars[resourceTitle] };
    }
    return { kind: "unmanaged", name: target };
  }

  async function eventsForDate(dateIso) {
    const date = new Date(`${dateIso}T12:00:00Z`);
    const tabs = await sheetService.listScheduleTabs();
    const tab = selectTabForDate(tabs, date);
    if (!tab) return { tab: null, events: [] };
    const all = await sheetService.readWeekEvents(tab);
    const events = all
      .filter((e) => sameDate(e.date, dateIso))
      .map((e) => ({ ...e, room: roomMatcher.match(e.location) }));
    return { tab, events, all };
  }

  async function checkRoom({ room, dateIso, startTime, endTime }) {
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    const { events } = await eventsForDate(dateIso);
    const { conflicts, skipped } = findRoomConflicts({ room, startMin, endMin }, events);
    return { available: conflicts.length === 0, conflicts, skipped };
  }

  async function listReservations({ room = null, fromIso, toIso }) {
    const from = new Date(`${fromIso}T00:00:00Z`);
    const to = new Date(`${toIso}T00:00:00Z`);
    const tabs = await sheetService.listScheduleTabs();
    const seenTabs = new Set();
    const out = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
      const day = new Date(t);
      const tab = selectTabForDate(tabs, day);
      if (!tab || seenTabs.has(tab)) continue;
      seenTabs.add(tab);
      const events = await sheetService.readWeekEvents(tab);
      for (const e of events) {
        if (!e.date) continue;
        const year = inferYear(e.date.month, e.date.day, now());
        const dateIso = `${year}-${String(e.date.month).padStart(2, "0")}-${String(e.date.day).padStart(2, "0")}`;
        if (dateIso < fromIso || dateIso > toIso) continue; // window filter (zero-padded ISO compares lexically)
        if (room && roomMatcher.match(e.location) !== room) continue;
        out.push({
          dateIso,
          startTime: e.startMin !== null ? formatMinutes(e.startMin) : "",
          endTime: e.endMin !== null ? formatMinutes(e.endMin) : "",
          location: e.location,
          what: e.what,
          _startMin: e.startMin ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }
    out.sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : a._startMin - b._startMin));
    return out.map(({ _startMin, ...item }) => item);
  }

  async function listRoom({ room, fromIso, toIso }) {
    const items = await listReservations({ room, fromIso, toIso });
    return items.map(({ dateIso, startTime, endTime, what }) => ({ dateIso, startTime, endTime, what }));
  }

  async function resourceLastUsed(query) {
    const candidates = resourceMatcher.matchAll(query);
    if (candidates.length === 0) return { status: "unknown", query };
    if (candidates.length > 1) return { status: "ambiguous", candidates };
    const resourceName = candidates[0];
    const calendarId = resourceCalendars[resourceName];
    if (!calendarId) return { status: "unknown", query };
    try {
      const lastUse = await calendarService.lastEvent(calendarId);
      return { status: "ok", resourceName, lastUse };
    } catch {
      return { status: "error", resourceName };
    }
  }

  return { classifyTarget, checkRoom, listRoom, listReservations, resourceLastUsed };
}
