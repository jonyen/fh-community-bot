const VALID_GENDERS = new Set(["male", "female"]);

export function createGenderMapService({ sheetsClient, spreadsheetId, ttlMs, tabName }) {
  let cache = { fetchedAt: 0, data: null };

  async function fetchFromSheet() {
    const range = `'${tabName}'!A2:B`;
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
    const rows = res.data.values || [];
    const data = {};
    for (const row of rows) {
      if (!row || row.length < 2) continue;
      const userId = String(row[0] || "").trim();
      const gender = String(row[1] || "").trim().toLowerCase();
      if (!userId) continue;
      if (!VALID_GENDERS.has(gender)) continue;
      data[userId] = gender;
    }
    return data;
  }

  async function getMap() {
    const now = Date.now();
    if (cache.data && now - cache.fetchedAt < ttlMs) {
      return cache.data;
    }
    const data = await fetchFromSheet();
    cache = { fetchedAt: now, data };
    return data;
  }

  async function invalidate() {
    cache = { fetchedAt: 0, data: null };
    const data = await getMap();
    return Object.keys(data).length;
  }

  return { getMap, invalidate };
}
