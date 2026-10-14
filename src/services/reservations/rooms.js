// src/services/reservations/rooms.js
// Rooms live on Management's "Upcoming Room Requests" tab. Status is theirs to
// manage by hand, so the bot writes it blank and only treats Denied/Declined
// rows as not holding the room.
import { parseSheetDate, formatSheetDate, parseSheetTime, fmtTime, overlaps, nyToday } from "../../lib/reservation-time.js";
import { splitRooms, roomsConflict } from "../../lib/rooms-catalog.js";

const INACTIVE = new Set(["denied", "declined"]);

export function createRoomsAdapter({ sheetsClient, spreadsheetId, tab, link, now = () => new Date() }) {
  async function readRows() {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A2:I` });
    const today = nyToday(now());
    return (res.data.values || [])
      .map((r) => ({
        title: (r[0] || "").trim(),
        date: parseSheetDate(r[1], today),
        start: parseSheetTime(r[2]),
        end: parseSheetTime(r[3]),
        holder: (r[5] || "").trim(),
        rooms: splitRooms(r[6]),
        status: (r[7] || "").trim().toLowerCase(),
      }))
      .filter((r) => r.date && r.rooms.length > 0 && !INACTIVE.has(r.status));
  }

  const toReservation = (r) => ({
    category: "rooms", item: r.rooms.join(", "), date: r.date, start: r.start, end: r.end,
    title: r.title, holder: r.holder, holderUserId: null, holderEmail: null,
  });

  async function listReservations({ from, to, items }) {
    const wanted = items?.length ? items.map((i) => i.label) : null;
    const rows = (await readRows()).filter(
      (r) => r.date >= from && r.date <= to && (!wanted || roomsConflict(wanted, r.rooms))
    );
    return { reservations: rows.map(toReservation), errors: [] };
  }

  async function findConflicts({ date, start, end, items }) {
    const wanted = items.map((i) => i.label);
    return (await readRows())
      .filter((r) => r.date === date && overlaps(start, end, r.start, r.end) && roomsConflict(wanted, r.rooms))
      .map(toReservation);
  }

  async function book({ date, start, end, items, title, ministry, requesterName }) {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tab}'!A:I`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          title, formatSheetDate(date), fmtTime(start), fmtTime(end), ministry || "",
          requesterName, items.map((i) => i.label).join("\n"), "", "Booked via #reservations",
        ]],
      },
    });
    return { status: "booked", link };
  }

  return { backend: "rooms", link, listReservations, findConflicts, book };
}
