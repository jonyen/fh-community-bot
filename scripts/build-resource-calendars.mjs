// Build the RESOURCE_CALENDARS map from a pasted Google "browse resources"
// directory dump. Each entry has a `title` and a `did` (the calendar id,
// base64-encoded). Reads the directory JSON from a file argument or stdin and
// writes the decoded `{ "<title>": "<calendarId>" }` JSON to stdout.
//
// Usage:
//   node scripts/build-resource-calendars.mjs resources.json
//   pbpaste | node scripts/build-resource-calendars.mjs
//
// Accepts either a JSON array of {title, did} or several such arrays
// concatenated (re-run and merge as you paste more categories). Entries whose
// type is not "calendar" are skipped. Duplicate titles keep the last id and a
// warning is printed to stderr.
//
// Pipe straight into a GitHub Actions variable:
//   node scripts/build-resource-calendars.mjs resources.json \
//     | gh variable set RESOURCE_CALENDARS --body-file -

import { readFileSync } from "node:fs";

function readInput() {
  const fileArg = process.argv[2];
  if (fileArg) return readFileSync(fileArg, "utf8");
  return readFileSync(0, "utf8"); // stdin
}

function decodeDid(did) {
  return Buffer.from(String(did), "base64").toString("utf8");
}

let raw;
try {
  raw = JSON.parse(readInput());
} catch (err) {
  process.stderr.write(`Could not parse input as JSON: ${err.message}\n`);
  process.exit(1);
}

const entries = Array.isArray(raw) ? raw : [raw];
const map = {};
let skipped = 0;
for (const e of entries) {
  if (!e || (e.type && e.type !== "calendar") || !e.title || !e.did) {
    skipped += 1;
    continue;
  }
  const id = decodeDid(e.did);
  if (map[e.title] && map[e.title] !== id) {
    process.stderr.write(`Duplicate title "${e.title}" — keeping latest id.\n`);
  }
  map[e.title] = id;
}

process.stderr.write(
  `Decoded ${Object.keys(map).length} resource calendar(s); skipped ${skipped}.\n`
);
process.stdout.write(JSON.stringify(map, null, 2) + "\n");
