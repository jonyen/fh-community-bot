# Maintenance Report Form (In-Thread Block Kit)

**Date:** 2026-07-06
**Status:** Approved

## Problem

Reporting a maintenance issue today is a chatbot back-and-forth: user mentions the bot with issue text, an LLM classifies whether it's a maintenance request, the bot asks "How severe is this issue?", and the user replies with a severity keyword. This requires multi-turn state (in-memory `pendingIssues` cache plus thread-transcript recovery for cold Lambda containers), and there is no structured issue type.

Replace it with a single in-thread Block Kit form the reporter fills out: description, issue type dropdown, severity dropdown, Submit button.

## User Flow

1. User mentions `@FH Maintenance` in a maintenance channel, with or without issue text.
2. Bot replies in the thread with a form message:
   - **Description** — `plain_text_input`, multiline, pre-filled with the mention text (minus the @mention) when present.
   - **Issue type** — `static_select`: Lighting, Elevator, Pest Control, Electrical, Plumbing, HVAC, Janitorial, Other.
   - **Severity** — `static_select`: Minor, Medium, Critical.
   - **Submit** button.
3. Reporter (or anyone in the thread) fills the form and clicks Submit. Slack sends a `block_actions` interactivity payload; all field values arrive in `payload.state.values`, so no server-side pending state is needed.
4. On submit the worker:
   - Validates description non-empty; if empty, posts an ephemeral error and leaves the form up.
   - Runs duplicate detection against open issues from the last 7 days (warn-only; never blocks).
   - Appends the row to the Google Sheet, including the new TYPE column J.
   - Collects photos attached to the original mention message and writes their Drive links.
   - Replaces the form (`chat.update`) with a confirmation: severity, type, sheet link, "might be related to issue #N" when dedup matched, and `cc <@U0000000000>` for Medium/Critical.
5. Thread replies after logging continue to append notes/photos to the row (unchanged behavior).

## Architecture

Existing pipeline: API Gateway → receiver Lambda (signature verify, filter, enqueue) → SQS → worker Lambda → `dispatchSlackEvent` → handlers.

### receiver.js

Form-encoded bodies currently mean slash commands only. Add: if the form body contains a `payload` parameter, it is an interactivity payload — parse the JSON, and for `type === "block_actions"` enqueue an envelope `{ type: "block_actions", payload }`. Slash command handling unchanged.

Slack app configuration (manual, one-time): enable Interactivity with the Request URL set to the same events endpoint.

### dispatch.js

Route `slackEnvelope.type === "block_actions"` to a new form-submit handler before event handling. Mention routing to the maintenance handler is unchanged (channel filter still applies inside the handler).

### events/mention.js

- On mention: post the form message in the thread (after the existing eyes reaction). Pre-fill description from mention text.
- Delete: severity-reply parsing path, `pendingIssues` cache, `recoverPendingFromThread` and its helpers (`SEVERITY_PROMPT` constant, transcript reconstruction), LLM classification gate (`isMaintenanceRequest` call), `suggestFix` call, inline severity extraction (`extractSeverity`), and the `create new:` bypass (dedup no longer blocks).
- Keep: list/status command, close/resolve commands, notes/photos append for created issues (`createdIssues` map), channel filter, eyes reaction.

### New: form-submit handler

Handles the `block_actions` envelope: extract description/type/severity from `payload.state.values`, resolve the reporter as the user who clicked Submit (`payload.user.id` → display name via `users.info`), run dedup, append issue, collect photos from the original mention message (fetch thread root), `chat.update` the form message into the confirmation, record the row id in `createdIssues` so follow-up thread replies append notes.

Double-submit safety: the first submit replaces the form via `chat.update`; a late duplicate payload references a message whose blocks no longer contain the form — detect and ignore.

### services/sheets.js

- Columns become A–J with `J = TYPE`; `DATA_RANGE` extends to `A:J`; `parseRow` gains `type`.
- `appendIssue({ reporter, description, severity, type, photos })` writes type into J.
- Sheet owner adds the TYPE header to column J manually.

### services/groq.js

Remove maintenance-only functions no longer referenced: `suggestFix`, `isMaintenanceRequest` (and its `isObviouslyNotMaintenance` helper), and their prompts. Reservation/info functions stay.

### lib/severity.js

Remove if no remaining callers.

## Issue Type Options

Lighting, Elevator, Pest Control, Electrical, Plumbing, HVAC, Janitorial, Other. ("Other" placed last.)

## Error Handling

- Sheets append failure on submit: post error in thread ("Couldn't log this issue right now — please try again in a few minutes."), leave the form up so the user can retry.
- Photo collection failure: log and continue without photos (existing behavior).
- Empty description on submit: ephemeral prompt to fill it in; form stays.

## Testing

- `tests/lambda/receiver.test.js`: `payload=` form body → block_actions envelope enqueued; slash commands still work; bad payload JSON → 400.
- `tests/lambda/dispatch.test.js`: block_actions envelope routes to form handler.
- `tests/events/mention.test.js`: mention posts form (pre-filled description); severity back-and-forth tests removed; list/close/notes tests kept.
- New form-handler tests: submit happy path (sheet row incl. type, confirmation via chat.update, cc on Medium/Critical), empty description, dedup warn text, sheets failure keeps form, duplicate submit ignored.
- `tests/services/sheets.test.js`: J column write, A:J range, parseRow type.

## Out of Scope

- Room reservations, gender aliases, OneStop info Q&A flows.
- Sheet header/formatting changes beyond code writing column J.
- Modal-based form (impossible from app_mention — no trigger_id).
