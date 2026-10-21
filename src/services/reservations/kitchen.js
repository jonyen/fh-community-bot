// src/services/reservations/kitchen.js
// Arie's kitchen sheet has three pre-dated rows per day that people fill in.
// The sheet's own rule is "no more than 3 ministry groups at same cooking time
// frame". Arie rolls the dates forward by hand, so a future date may have no
// rows yet; then the bot sends people to the sheet instead of inventing rows.
import { parseSheetDate, parseSheetTime, fmtTime, overlaps, nyToday } from "../../lib/reservation-time.js";
import { sheetText } from "../../lib/sheet-text.js";

export const APPLIANCES = [
  { key: "island", col: "F", label: "Kitchen Island", kind: "bool" },
  { key: "whiteCounter", col: "G", label: "White Counter", kind: "bool" },
  { key: "brownCounter", col: "H", label: "Brown Counter", kind: "bool" },
  { key: "freezer", col: "I", label: "Freezer shelves", kind: "count" },
  { key: "fridge", col: "J", label: "Fridge shelves", kind: "count" },
  { key: "toasterOven", col: "K", label: "Toaster Oven", kind: "bool" },
  { key: "airFryer", col: "L", label: "Air Fryer", kind: "bool" },
  { key: "microwave", col: "M", label: "Microwave", kind: "bool" },
  { key: "largeRiceCooker", col: "N", label: "Large Rice Cooker", kind: "count" },
  { key: "smallRiceCooker", col: "O", label: "8-cup Rice Cooker", kind: "count" },
  { key: "instapot", col: "P", label: "Instapot", kind: "count" },
];

export function createKitchenAdapter({ sheetsClient, spreadsheetId, tab, link, maxGroups = 3, now = () => new Date() }) {
  // Every dated row after the "Date" header, with its 1-based sheet row.
  async function readRows() {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A1:P1000` });
    const values = res.data.values || [];
    const header = values.findIndex((r) => (r[0] || "").trim() === "Date");
    const today = nyToday(now());
    const rows = [];
    for (let i = header + 1; i < values.length; i++) {
      const r = values[i] || [];
      const date = parseSheetDate(r[0], today);
      if (!date) continue;
      rows.push({
        row: i + 1,
        date,
        name: (r[1] || "").trim(),
        phone: (r[2] || "").trim(),
        start: parseSheetTime(r[3]),
        end: parseSheetTime(r[4]),
      });
    }
    return rows;
  }

  const refOf = (r) => ({ backend: "kitchen", row: r.row, date: r.date, name: r.name, start: r.start, end: r.end });

  const toReservation = (r) => ({
    category: "kitchen", item: "Kitchen", date: r.date, start: r.start, end: r.end, title: r.name,
    holder: r.phone ? `${r.name} (${r.phone})` : r.name, holderName: r.name, phone: r.phone,
    holderUserId: null, holderEmail: null, ref: refOf(r),
  });

  async function listReservations({ from, to }) {
    const rows = (await readRows()).filter((r) => r.name && r.date >= from && r.date <= to);
    return { reservations: rows.map(toReservation), errors: [] };
  }

  // One read of the sheet answers every date. A date with no rows at all is
  // one Arie has not rolled forward yet, which is not the same as a free day.
  // memo (a Map shared by one redraw's checks) keeps it to one sheet read
  // however many tray lines are checked.
  async function checkDates({ dates, start, end, memo = null }) {
    const key = `kitchen:${spreadsheetId}:${tab}`;
    if (memo && !memo.has(key)) memo.set(key, readRows());
    const rows = await (memo ? memo.get(key) : readRows());
    return Object.fromEntries(dates.map((date) => {
      if (!rows.some((r) => r.date === date)) {
        return [date, { conflicts: [], unavailable: "The kitchen sheet is not open yet for that date." }];
      }
      const hits = rows.filter((r) => r.name && r.date === date && overlaps(start, end, r.start, r.end));
      return [date, { conflicts: hits.length >= maxGroups ? hits.map(toReservation) : [], unavailable: null }];
    }));
  }

  async function findConflicts({ date, start, end }) {
    return (await checkDates({ dates: [date], start, end }))[date].conflicts;
  }

  // B-E for the group, then one cell per appliance they asked for.
  function writesFor(row, { start, end, requesterName, phone, appliances = {} }) {
    const data = [
      { range: `'${tab}'!B${row}:E${row}`, values: [[sheetText(requesterName), sheetText(phone || ""), fmtTime(start), fmtTime(end)]] },
    ];
    for (const a of APPLIANCES) {
      const v = appliances[a.key];
      if (v == null || v === false) continue;
      data.push({ range: `'${tab}'!${a.col}${row}`, values: [[a.kind === "bool" ? "TRUE" : Number(v)]] });
    }
    return data;
  }

  const writeAll = (writer, data) => writer.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });

  const bookedRef = (row, { date, requesterName, start, end }) =>
    refOf({ row, date, name: requesterName.trim(), start, end });

  const noRowReason = (sameDay) => sameDay.length === 0
    ? "The kitchen sheet is not open yet for that date."
    : `All ${sameDay.length} kitchen rows for that day are taken.`;

  async function book(booking, { clients } = {}) {
    const sameDay = (await readRows()).filter((r) => r.date === booking.date);
    const free = sameDay.find((r) => !r.name);
    if (!free) return { status: "unavailable", reason: noRowReason(sameDay), link };
    const writer = clients?.sheetsClient || sheetsClient;
    await writeAll(writer, writesFor(free.row, booking));
    return { status: "booked", link, ref: bookedRef(free.row, booking) };
  }

  // One read and one write for all the dates. Each booking takes its own free
  // row, so two groups on one day land on two rows.
  async function bookMany(bookings, { clients } = {}) {
    let rows;
    try {
      rows = await readRows();
    } catch (err) {
      return bookings.map(() => ({ status: "error", error: err }));
    }
    const taken = new Set();
    const data = [];
    const results = bookings.map((b) => {
      const sameDay = rows.filter((r) => r.date === b.date);
      const free = sameDay.find((r) => !r.name && !taken.has(r.row));
      if (!free) return { status: "unavailable", reason: noRowReason(sameDay), link };
      // A malformed booking is its own error and does not claim a row.
      try {
        const writes = writesFor(free.row, b);
        const ref = bookedRef(free.row, b);
        taken.add(free.row);
        data.push(...writes);
        return { status: "booked", link, ref };
      } catch (err) {
        return { status: "error", error: err };
      }
    });
    if (data.length === 0) return results;
    try {
      await writeAll(clients?.sheetsClient || sheetsClient, data);
    } catch (err) {
      return results.map((r) => (r.status === "booked" ? { status: "error", error: err } : r));
    }
    return results;
  }

  async function cancel(ref, { clients } = {}) {
    const target = (await readRows()).find((r) => r.row === ref.row);
    if (!target) return { status: "changed", link };
    if (!target.name) return { status: "already", link };
    if (target.name !== ref.name.trim() || target.date !== ref.date || target.start !== ref.start || target.end !== ref.end) {
      return { status: "changed", link };
    }
    const writer = clients?.sheetsClient || sheetsClient;
    await writer.spreadsheets.values.clear({ spreadsheetId, range: `'${tab}'!B${target.row}:P${target.row}` });
    return { status: "cancelled", link };
  }

  return { backend: "kitchen", link, listReservations, checkDates, findConflicts, book, bookMany, cancel };
}
