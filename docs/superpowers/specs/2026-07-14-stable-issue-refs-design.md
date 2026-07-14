# Stable issue references via hidden SLACK_REF column

**Date:** 2026-07-14
**Status:** Approved

## Problem

The bot identifies sheet rows by position. `appendIssue` always inserts at row 5
and returns `"5"`; thread-note and photo appends use an in-memory
`createdIssues` map of thread ts → row number. Row numbers rot whenever:

- a new issue inserts at row 5 (every existing mapping shifts by 1),
- humans move rows between the sheet's BACKLOG / IN PROGRESS / BLOCKED /
  COMPLETED sections,
- rows are deleted (e.g. duplicate cleanup).

The map is also per-Lambda-instance memory, so notes silently stop attaching
after an instance recycles or when a different instance handles the reply.

## Design

Add a hidden column K (`SLACK_REF`) holding the Slack thread ts of the report
thread — unique per issue and already the key the bot uses. Resolve ref → row
at write time by scanning column K.

### Sheet migration (one-time, run before deploy)

Script in `scripts/`:

1. Expand the `Maintenance Request` grid from 10 to 11 columns.
2. Write header `SLACK_REF` in K2 (header row).
3. Hide column K.

Existing rows keep a blank K. Old code ignores K, so the script is safe to run
before the code deploys (required order — new code writing A:K into a
10-column grid errors).

### Code changes

**`src/services/sheets.js`**
- `DATA_RANGE` becomes `A5:K`; `parseRow` gains `slackRef` (index 10).
- `appendIssue({ ..., slackRef })` writes the ref into K on insert.
- New `findIssueRowByRef(ref)` → current row number (string, same shape as
  today's `id`) or `null`. Blank/missing K cells never match.
- `appendNote` / `appendPhotos` / `updateIssueStatus` unchanged; callers
  resolve ref → row immediately before writing.

**`src/events/maintenanceForm.js`**
- Pass `slackRef: threadTs` to `appendIssue`.
- Drop `createdIssues.set` and the `createdIssues` dependency.

**`src/events/mention.js`**
- Drop the `createdIssues` map. For thread replies
  (`event.thread_ts` set), resolve
  `issueRowId = await sheetsService.findIssueRowByRef(threadKey)`.
- No lookup for top-level messages (no extra read volume).

**`src/lambda/clients.js`** (and any other wiring)
- Remove the shared `createdIssues` map.

### Explicitly unchanged

- `close #N` and duplicate warnings keep using visible row numbers — humans
  see row numbers in the sheet, and those flows already re-read the sheet at
  action time.
- Human-entered rows (blank K): bot cannot attach notes to them, same as
  today.
- Issues logged before this deploys are orphaned (no ref recorded) — same
  loss mode as today's map on Lambda recycle.

## Testing

- `sheets.test.js`: `appendIssue` writes the ref into K; `findIssueRowByRef`
  found / not-found / blank-K cases.
- `maintenanceForm.test.js`: `appendIssue` called with `slackRef`.
- `mention.test.js`: thread-note path resolves the row via the sheets service
  mock instead of the injected map.

## Rejected alternatives

- **Content matching at write time** — fragile against edits/near-dupes,
  keeps the in-memory map.
- **DynamoDB thread→row table** — new infra; rows still shift under it.
