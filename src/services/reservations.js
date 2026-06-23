// src/services/reservations.js
import { selectTabForDate } from "../lib/reservation-tabs.js";
import { parseTimeToMinutes, formatMinutes, inferYear } from "../lib/reservation-time.js";
import { createRoomMatcher } from "../lib/reservation-rooms.js";
import { findRoomConflicts } from "../lib/reservation-overlap.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDateCell(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${WEEKDAYS[d.getUTCDay()]}`;
}

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

  async function makeRoomReservation({ room, dateIso, startTime, endTime, what, who }) {
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    if (startMin === null || endMin === null) return { ok: false, reason: "unparseable time" };
    const { tab, events, all } = await eventsForDate(dateIso);
    if (!tab) return { ok: false, reason: "no week tab for that date" };
    const { conflicts } = findRoomConflicts({ room, startMin, endMin }, events);
    if (conflicts.length > 0) return { ok: false, reason: "conflict", conflicts };

    // chronological insertion point: first row on/after this date whose start is later
    let insertAt = all.length + 1; // default end (account for header at 0)
    for (const e of all) {
      const laterSameDay = sameDate(e.date, dateIso) && e.startMin !== null && e.startMin > startMin;
      if (laterSameDay) { insertAt = e.rowIndex; break; }
    }
    const values = [
      formatDateCell(dateIso), formatMinutes(startMin), formatMinutes(endMin),
      "", "", what || "", room, who || "", "", "", "", "",
    ];
    await sheetService.insertRow(tab, insertAt, values);
    return { ok: true };
  }

  async function listRoom({ room, fromIso, toIso }) {
    const out = [];
    const from = new Date(`${fromIso}T00:00:00Z`);
    const to = new Date(`${toIso}T00:00:00Z`);
    const tabs = await sheetService.listScheduleTabs();
    const seenTabs = new Set();
    for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
      const day = new Date(t);
      const tab = selectTabForDate(tabs, day);
      if (!tab || seenTabs.has(tab)) continue;
      seenTabs.add(tab);
      const events = await sheetService.readWeekEvents(tab);
      for (const e of events) {
        if (roomMatcher.match(e.location) !== room) continue;
        let dateIso = "";
        if (e.date) {
          const year = inferYear(e.date.month, e.date.day, now());
          dateIso = `${year}-${String(e.date.month).padStart(2, "0")}-${String(e.date.day).padStart(2, "0")}`;
        }
        out.push({
          dateIso,
          startTime: e.startMin !== null ? formatMinutes(e.startMin) : "",
          endTime: e.endMin !== null ? formatMinutes(e.endMin) : "",
          what: e.what,
        });
      }
    }
    return out;
  }

  return { classifyTarget, checkRoom, makeRoomReservation, listRoom };
}
