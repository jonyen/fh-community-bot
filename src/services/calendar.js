// src/services/calendar.js
export function createCalendarService(calendarClient) {
  async function listEvents(calendarId, timeMinIso, timeMaxIso) {
    const res = await calendarClient.events.list({
      calendarId,
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items || []).map((e) => ({
      summary: e.summary || "",
      startIso: e.start?.dateTime || e.start?.date || "",
      endIso: e.end?.dateTime || e.end?.date || "",
    }));
  }

  async function isBusy(calendarId, timeMinIso, timeMaxIso) {
    const res = await calendarClient.freebusy.query({
      requestBody: { timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] },
    });
    const busy = res.data.calendars?.[calendarId]?.busy || [];
    return busy.length > 0;
  }

  async function insertEvent(calendarId, { summary, startIso, endIso, description, timeZone }) {
    const start = { dateTime: startIso };
    const end = { dateTime: endIso };
    if (timeZone) { start.timeZone = timeZone; end.timeZone = timeZone; }
    const res = await calendarClient.events.insert({
      calendarId,
      requestBody: { summary, description: description || "", start, end },
    });
    return { id: res.data.id };
  }

  async function lastEvent(calendarId, { lookbackDays = 540 } = {}) {
    const now = new Date();
    const timeMin = new Date(now.getTime() - lookbackDays * 86400000).toISOString();
    let pageToken;
    let latest = null;
    do {
      const res = await calendarClient.events.list({
        calendarId, timeMin, timeMax: now.toISOString(),
        singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken,
      });
      const items = res.data.items || [];
      if (items.length > 0) latest = items[items.length - 1];
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    if (!latest) return null;
    return {
      summary: latest.summary || "",
      startIso: latest.start?.dateTime || latest.start?.date || "",
      endIso: latest.end?.dateTime || latest.end?.date || "",
    };
  }

  return { listEvents, isBusy, insertEvent, lastEvent };
}
