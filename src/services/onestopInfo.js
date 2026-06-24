// src/services/onestopInfo.js
const DEFAULT_TABS = [
  "BULLETIN", "Links", "Rotations", "Zoom & WR & DT", "IH",
  "Category/Legend", "Cleaning Assignments", "Summer Cleaning Assignments",
];

export function createOneStopInfoService({
  sheetsClient, sheetId, tabs = DEFAULT_TABS, ttlMs = 5 * 60 * 1000, now = () => new Date(),
}) {
  let cache = { fetchedAt: 0, text: null };

  async function fetchCorpus() {
    const blocks = [];
    for (const tab of tabs) {
      let rows = [];
      try {
        const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A1:Z` });
        rows = res.data.values || [];
      } catch {
        continue; // a missing/erroring tab shouldn't break the corpus
      }
      const lines = [];
      for (const row of rows) {
        const cells = (row || []).map((c) => String(c == null ? "" : c).trim());
        if (cells.every((c) => c === "")) continue; // skip empty rows
        lines.push(cells.join(" | "));
      }
      if (lines.length) blocks.push(`### ${tab}\n${lines.join("\n")}`);
    }
    return blocks.join("\n\n");
  }

  async function corpus() {
    const t = now().getTime();
    if (cache.text !== null && t - cache.fetchedAt < ttlMs) return cache.text;
    const text = await fetchCorpus();
    // Only cache non-empty results to retry after transient failures
    if (text) cache = { fetchedAt: t, text };
    return text;
  }

  return { corpus };
}
