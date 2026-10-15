// src/lib/rms-catalog.js
// RESOURCE_CALENDARS maps the Workspace resource name to its calendar id, e.g.
// "DMV Tech Equipment-G-Tech Set 1". Venues and vehicles are out of scope:
// rooms are booked on the room request sheet instead.
const GROUPS = [
  ["DMV Tech Equipment-", "tech", "Tech"],
  ["DMV Sports Equipment-", "sports", "Sports"],
  ["DMV Outreach Supplies-", "outreach", "Outreach"],
  ["DMV Accessories-", "accessories", "Accessories"],
];

export function buildRmsCatalog(resourceCalendars) {
  if (!resourceCalendars || typeof resourceCalendars !== "object") return [];
  const entries = [];
  for (const [name, calendarId] of Object.entries(resourceCalendars)) {
    const group = GROUPS.find(([prefix]) => name.startsWith(prefix));
    if (!group || typeof calendarId !== "string") continue;
    const label = name.slice(group[0].length).replace(/^G-/, "").replace(/^\d+-/, "").trim();
    entries.push({ label, category: group[1], groupName: group[2], calendarId });
  }
  const counts = new Map();
  for (const e of entries) counts.set(e.label.toLowerCase(), (counts.get(e.label.toLowerCase()) || 0) + 1);
  return entries.map(({ label, category, groupName, calendarId }) => ({
    label: counts.get(label.toLowerCase()) > 1 ? `${label} (${groupName})` : label,
    category,
    backend: "rms",
    calendarId,
  }));
}

export function calendarLink(calendarId) {
  return `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(calendarId)}`;
}
