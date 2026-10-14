// src/services/reservations/kitchen.js
// Arie's kitchen sheet has three pre-dated rows per day that people fill in.
// The sheet's own rule is "no more than 3 ministry groups at same cooking time
// frame". Arie rolls the dates forward by hand, so a future date may have no
// rows yet; then the bot sends people to the sheet instead of inventing rows.
import { parseSheetDate, parseSheetTime, fmtTime, overlaps, nyToday } from "../../lib/reservation-time.js";

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

  const toReservation = (r) => ({
    category: "kitchen", item: "Kitchen", date: r.date, start: r.start, end: r.end, title: r.name,
    holder: r.phone ? `${r.name} (${r.phone})` : r.name, holderUserId: null, holderEmail: null,
  });

  async function listReservations({ from, to }) {
    const rows = (await readRows()).filter((r) => r.name && r.date >= from && r.date <= to);
    return { reservations: rows.map(toReservation), errors: [] };
  }

  async function findConflicts({ date, start, end }) {
    const hits = (await readRows()).filter((r) => r.name && r.date === date && overlaps(start, end, r.start, r.end));
    return hits.length >= maxGroups ? hits.map(toReservation) : [];
  }

  async function book({ date, start, end, requesterName, phone, appliances = {} }) {
    const sameDay = (await readRows()).filter((r) => r.date === date);
    if (sameDay.length === 0) {
      return { status: "unavailable", reason: "The kitchen sheet is not open yet for that date.", link };
    }
    const free = sameDay.find((r) => !r.name);
    if (!free) {
      return { status: "unavailable", reason: `All ${sameDay.length} kitchen rows for that day are taken.`, link };
    }
    const data = [
      { range: `'${tab}'!B${free.row}:E${free.row}`, values: [[requesterName, phone || "", fmtTime(start), fmtTime(end)]] },
    ];
    for (const a of APPLIANCES) {
      const v = appliances[a.key];
      if (v == null || v === false) continue;
      data.push({ range: `'${tab}'!${a.col}${free.row}`, values: [[a.kind === "bool" ? "TRUE" : Number(v)]] });
    }
    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data },
    });
    return { status: "booked", link };
  }

  return { backend: "kitchen", link, listReservations, findConflicts, book };
}
