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

  async function insertEvent(calendarId, { summary, startIso, endIso, description }) {
    const res = await calendarClient.events.insert({
      calendarId,
      requestBody: {
        summary,
        description: description || "",
        start: { dateTime: startIso },
        end: { dateTime: endIso },
      },
    });
    return { id: res.data.id };
  }

  return { listEvents, isBusy, insertEvent };
}
