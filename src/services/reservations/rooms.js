// src/services/reservations/rooms.js
// Rooms live on Management's "Upcoming Room Requests" tab. Status is theirs to
// manage by hand, so the bot writes it blank, treats Denied/Declined/Canceled
// rows as not holding the room, and cancels by writing Canceled into Status.
import { parseSheetDate, formatSheetDate, parseSheetTime, fmtTime, overlaps, nyToday } from "../../lib/reservation-time.js";
import { splitRooms, roomsConflict } from "../../lib/rooms-catalog.js";
import { sheetText } from "../../lib/sheet-text.js";

const INACTIVE = new Set(["denied", "declined", "canceled", "cancelled"]);

export function createRoomsAdapter({ sheetsClient, spreadsheetId, tab, link, now = () => new Date() }) {
  // Every parsed row with its 1-based sheet row; header is skipped by A2.
  async function readAll() {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A2:I` });
    const today = nyToday(now());
    return (res.data.values || [])
      .map((r, i) => ({
        row: i + 2,
        title: (r[0] || "").trim(),
        date: parseSheetDate(r[1], today),
        start: parseSheetTime(r[2]),
        end: parseSheetTime(r[3]),
        holder: (r[5] || "").trim(),
        rooms: splitRooms(r[6]),
        status: (r[7] || "").trim().toLowerCase(),
      }))
      .filter((r) => r.date && r.rooms.length > 0);
  }

  async function readRows() {
    return (await readAll()).filter((r) => !INACTIVE.has(r.status));
  }

  const refOf = (r) => ({
    backend: "rooms", date: r.date, start: r.start, end: r.end, title: r.title, holder: r.holder, rooms: [...r.rooms],
  });

  const sameRooms = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const matches = (r, ref) =>
    r.title === ref.title.trim() && r.date === ref.date && r.start === ref.start && r.end === ref.end &&
    r.holder === ref.holder.trim() && sameRooms(r.rooms, ref.rooms);

  const toReservation = (r) => ({
    category: "rooms", item: r.rooms.join(", "), date: r.date, start: r.start, end: r.end,
    title: r.title, holder: r.holder, holderName: r.holder, holderUserId: null, holderEmail: null,
    ref: refOf(r),
  });

  async function listReservations({ from, to, items }) {
    const wanted = items?.length ? items.map((i) => i.label) : null;
    const rows = (await readRows()).filter(
      (r) => r.date >= from && r.date <= to && (!wanted || roomsConflict(wanted, r.rooms))
    );
    return { reservations: rows.map(toReservation), errors: [] };
  }

  // One read of the sheet answers every date, so a weekly repeat costs the same as one day.
  async function checkDates({ dates, start, end, items }) {
    const wanted = items.map((i) => i.label);
    const rows = await readRows();
    return Object.fromEntries(dates.map((date) => [date, {
      conflicts: rows
        .filter((r) => r.date === date && overlaps(start, end, r.start, r.end) && roomsConflict(wanted, r.rooms))
        .map(toReservation),
      unavailable: null,
    }]));
  }

  async function findConflicts({ date, start, end, items }) {
    return (await checkDates({ dates: [date], start, end, items }))[date].conflicts;
  }

  const rowOf = ({ date, start, end, items, title, ministry, requesterName }) => [
    sheetText(title), formatSheetDate(date), fmtTime(start), fmtTime(end), sheetText(ministry || ""),
    sheetText(requesterName), items.map((i) => i.label).join("\n"), "", "Booked via #reservations",
  ];

  const bookedRef = ({ date, start, end, items, title, requesterName }) =>
    refOf({ date, start, end, title: String(title).trim(), holder: String(requesterName).trim(), rooms: items.map((i) => i.label) });

  const append = (writer, rows) => writer.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab}'!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  async function book(booking, { clients } = {}) {
    // Written as the member when they are connected, so the sheet's edit
    // history shows them.
    const writer = clients?.sheetsClient || sheetsClient;
    await append(writer, [rowOf(booking)]);
    return { status: "booked", link, ref: bookedRef(booking) };
  }

  // Every date in one append, so "reserve all" is one write however many dates.
  async function bookMany(bookings, { clients } = {}) {
    const writer = clients?.sheetsClient || sheetsClient;
    try {
      await append(writer, bookings.map(rowOf));
    } catch (err) {
      return bookings.map(() => ({ status: "error", error: err.message }));
    }
    return bookings.map((b) => ({ status: "booked", link, ref: bookedRef(b) }));
  }

  async function cancel(ref, { clients } = {}) {
    const found = (await readAll()).filter((r) => matches(r, ref));
    const target = found.find((r) => !INACTIVE.has(r.status));
    if (!target) return { status: found.length ? "already" : "changed", link };
    const writer = clients?.sheetsClient || sheetsClient;
    await writer.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tab}'!H${target.row}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Canceled"]] },
    });
    return { status: "cancelled", link };
  }

  return { backend: "rooms", link, listReservations, checkDates, findConflicts, book, bookMany, cancel };
}
