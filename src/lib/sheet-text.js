// Bookings are written with USER_ENTERED so times and checkboxes parse, but
// text from Slack must stay text: "+1 703…" would become #ERROR! and
// "=IMPORTXML(…)" a live formula in someone else's sheet. A leading
// apostrophe makes Sheets store the rest literally and is not displayed.
export function sheetText(value) {
  const s = String(value ?? "");
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}
