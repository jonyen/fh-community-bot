// One-time backfill: fill the SLACK LINK column (L) of the Maintenance Request
// sheet for rows logged before the bot started recording a permalink.
//
// Those rows carry a SLACK_REF (K), but it was written as a plain value, so
// Sheets parsed the thread ts as a number and it reads back rounded to the
// second ("1788883646" for 1788883645.693749). The exact ts is therefore gone
// from the sheet and has to be recovered from Slack: pull the channel's
// messages, keep the ones whose ts rounds to the stored ref, and accept a row
// only when exactly one of them also matches what the row says. A row that
// stays ambiguous is left empty rather than pointed at a guess.
//
// Prints a plan and writes nothing unless --apply is passed. Never overwrites a
// cell that already has a link, so it is safe to re-run.
//
// Usage:
//   node --env-file=.env scripts/backfill-slack-links.mjs [--apply]

import { google } from "googleapis";
import { WebClient } from "@slack/web-api";

const APPLY = process.argv.includes("--apply");

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_SHEET_ID,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_IDS,
  SLACK_CHANNEL_ID,
} = process.env;

const missing = Object.entries({
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_SHEET_ID,
  SLACK_BOT_TOKEN,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const CHANNELS = (SLACK_CHANNEL_IDS || SLACK_CHANNEL_ID || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
if (CHANNELS.length === 0) {
  console.error("Set SLACK_CHANNEL_IDS (or SLACK_CHANNEL_ID)");
  process.exit(1);
}

const SHEET_NAME = "Maintenance Request";
const DATA_START_ROW = 5;

const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const sheets = google.sheets({ version: "v4", auth });
const slack = new WebClient(SLACK_BOT_TOKEN);

function normalize(text) {
  return (text || "")
    .replace(/<@[A-Z0-9_]+>/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Word overlap, scored against the shorter side so an edited-down description
// still matches the message it came from.
function similarity(a, b) {
  const wordsA = new Set(normalize(a).split(" ").filter(Boolean));
  const wordsB = new Set(normalize(b).split(" ").filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared += 1;
  return shared / Math.min(wordsA.size, wordsB.size);
}

async function fetchMessages(channel, oldest) {
  const messages = [];
  let cursor;
  do {
    const res = await slack.conversations.history({
      channel,
      oldest: String(oldest),
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    messages.push(...(res.messages || []).map((m) => ({ ...m, channel })));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return messages;
}

const userNames = new Map();
async function realName(userId) {
  if (!userId) return "";
  if (userNames.has(userId)) return userNames.get(userId);
  let name = "";
  try {
    const res = await slack.users.info({ user: userId });
    name = res.user?.real_name || res.user?.name || "";
  } catch {
    name = "";
  }
  userNames.set(userId, name);
  return name;
}

const sheetRes = await sheets.spreadsheets.values.get({
  spreadsheetId: GOOGLE_SHEET_ID,
  range: `'${SHEET_NAME}'!A${DATA_START_ROW}:L`,
});
const rows = (sheetRes.data.values || []).map((row, i) => ({
  rowNumber: i + DATA_START_ROW,
  submitter: row[1] || "",
  description: row[2] || "",
  ref: row[10] || "",
  link: row[11] || "",
}));

const todo = rows.filter((r) => r.ref && !r.link);
console.log(`${rows.length} data rows, ${todo.length} with a ref and no link`);
if (todo.length === 0) process.exit(0);

const oldestRef = Math.min(...todo.map((r) => Number(r.ref)).filter(Number.isFinite));
const messages = [];
for (const channel of CHANNELS) {
  const found = await fetchMessages(channel, Math.floor(oldestRef) - 2);
  console.log(`[slack] ${channel}: ${found.length} messages since ${new Date(oldestRef * 1000).toISOString()}`);
  messages.push(...found);
}

// Refs lost their fractional part, so a ref can only be narrowed to the second
// it was written in. Group the candidates by that second.
const bySecond = new Map();
for (const message of messages) {
  const key = String(Math.round(Number(message.ts)));
  if (!bySecond.has(key)) bySecond.set(key, []);
  bySecond.get(key).push(message);
}

const matched = [];
const skipped = [];

for (const row of todo) {
  const exact = messages.find((m) => m.ts === row.ref);
  const candidates = exact ? [exact] : bySecond.get(String(Math.round(Number(row.ref)))) || [];

  if (candidates.length === 0) {
    skipped.push({ ...row, reason: "no message in that second" });
    continue;
  }

  const scored = [];
  for (const candidate of candidates) {
    const nameScore = row.submitter
      ? similarity(row.submitter, await realName(candidate.user))
      : 0;
    scored.push({
      candidate,
      score: similarity(row.description, candidate.text) + nameScore,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  // One clear winner only. A tie means two reports landed in the same second
  // and nothing in the row tells them apart, so leave the cell empty.
  if (best.score < 0.5) {
    skipped.push({ ...row, reason: `best candidate scored ${best.score.toFixed(2)}` });
    continue;
  }
  if (runnerUp && best.score - runnerUp.score < 0.25) {
    skipped.push({ ...row, reason: "two candidates score alike" });
    continue;
  }

  const permalink = await slack.chat.getPermalink({
    channel: best.candidate.channel,
    message_ts: best.candidate.ts,
  });
  matched.push({
    ...row,
    ts: best.candidate.ts,
    score: best.score,
    permalink: permalink.permalink,
  });
}

console.log(`\nmatched ${matched.length}, skipped ${skipped.length}\n`);
for (const m of matched) {
  console.log(`row ${m.rowNumber}  ${m.ref} -> ${m.ts}  (${m.score.toFixed(2)})  ${m.submitter}: ${m.description.slice(0, 45)}`);
}
for (const s of skipped) {
  console.log(`SKIP row ${s.rowNumber}  ${s.ref}  ${s.reason}  ${s.submitter}: ${s.description.slice(0, 45)}`);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write column L.");
  process.exit(0);
}

if (matched.length) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: matched.map((m) => ({
        range: `'${SHEET_NAME}'!L${m.rowNumber}`,
        values: [[m.permalink]],
      })),
    },
  });
  console.log(`\nwrote ${matched.length} link(s) to column L`);
}
