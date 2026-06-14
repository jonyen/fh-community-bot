# Photo Attachments for the FH Maintenance Bot — Design

**Date:** 2026-06-13
**Status:** Approved, pending implementation plan

## Summary

Let users attach photos when reporting (or following up on) a maintenance issue
in Slack, and surface those photos in the Google Sheet: an inline thumbnail of
the first photo plus a growing list of clickable links to every photo. Photos
are copied from Slack into a dedicated Google Drive folder so the sheet can
reference them without Slack authentication.

## Goals

- Capture photos attached to the **initial report** and to **thread replies**.
- Show a **thumbnail preview** of the first photo directly in the sheet.
- Keep **every** photo one click away, including photos added later in the thread.
- Degrade gracefully: a photo failure never blocks issue logging.

## Non-goals

- Reshaping the one-row-per-issue sheet model.
- Fixing the pre-existing row-id quirk (see Known limitations).
- OCR, image analysis, or attaching photos to LLM prompts.

## Key constraints discovered during design

- **A Google Sheets cell holds exactly one value.** A cell is *either* an
  `=IMAGE()` (the whole cell renders as the image) *or* text/links — the two
  cannot coexist in one cell. Merging cells keeps only the top-left value.
  Therefore multiple inline thumbnails in one cell is impossible; the design
  uses two columns (thumbnail + links).
- **`=IMAGE()` needs an unauthenticated URL.** Slack file URLs are token-gated,
  so photos must be copied into Drive and shared "anyone with link." Even then,
  `drive.google.com/uc?...` links are unreliable for `IMAGE()`; the
  `https://lh3.googleusercontent.com/d/<fileId>` CDN form renders far more
  consistently. The links column is the fallback if a thumbnail won't render.

## Sheet layout changes

Current columns: `A=DATE, B=SUBMITTER, C=ISSUE, D=PRIORITY, E=DAYS SINCE FILED,
F=IN CHARGE, G=STATUS, H=NOTES`. Add two columns:

- **Column I — "Photo"**: `=IMAGE("https://lh3.googleusercontent.com/d/<fileId>")`
  for the first photo on the issue. Renders an inline thumbnail.
- **Column J — "Photo Links"**: newline-separated photo URLs (all photos,
  including the first). Sheets auto-linkifies plain URLs, making each clickable.
  This is the **appendable** column — thread-reply photos are appended here.

The data range widens from `A:H` to `A:J`.

## Photo flow (Slack → Drive → Sheet)

1. Slack delivers photos in `event.files[]` — on the `app_mention` for the
   initial report, and on `message` / `file_share` events for thread replies.
2. For each image file, download bytes from `url_private_download` using
   `Authorization: Bearer $SLACK_BOT_TOKEN` (requires the **`files:read`** Slack
   OAuth scope). Non-image files are ignored.
3. Upload each image to the dedicated Drive folder (`GOOGLE_DRIVE_FOLDER_ID`),
   set permission `anyone-with-link: reader`, capture the `fileId`.
4. Write the thumbnail formula (column I, first photo only) and append the links
   (column J, all photos).

## Components

### New

- **`src/services/drive.js`** — `createDriveService(driveClient, folderId)`
  exposing `uploadPhoto({ buffer, name, mimeType }) → { fileId, imageUrl, viewUrl }`.
  - Uploads into `folderId`.
  - Sets `anyone-with-link: reader` permission via `drive.permissions.create`.
  - `imageUrl` = `https://lh3.googleusercontent.com/d/<fileId>` (for `IMAGE()`).
  - `viewUrl` = the Drive `webViewLink` (for the links column).

- **`src/lib/photos.js`** — pipeline helper. Given `event.files`, the Slack bot
  token, and a drive service: filter to image mimetypes, download each from
  Slack (`fetch` with auth header), upload via the drive service, and return an
  array of photo descriptors `{ imageUrl, viewUrl, name }`. Isolated so it is
  unit-testable with mocked `fetch` and a mocked drive service. Returns an empty
  array (and logs) on partial/total failure rather than throwing.

### Changed

- **`src/services/sheets.js`**
  - Extend `DATA_RANGE` / `parseRow` to `A:J`; add `photoThumb` (I) and
    `photoLinks` (J) to the parsed issue shape.
  - `appendIssue` accepts an optional `photos` array; writes the column I
    thumbnail formula and the column J links for the initial photos.
  - New `appendPhotos(rowId, photos)` mirroring `appendNote`'s read-then-append
    pattern: read existing column J, append new links (newline-separated); set
    column I only if it is currently empty (first photo wins the thumbnail).

- **`src/events/mention.js`** — gather photos from `event.files` and run the
  pipeline:
  - On issue creation (both the inline-severity path and the severity-reply
    path), pass `photos` to `appendIssue`.
  - On a thread-reply note for a created issue, call `appendPhotos`. A photo-only
    reply (no text) should still attach the photo.
  - Photo-pipeline failures degrade gracefully: the issue/note still logs; the
    reply text notes that the photo couldn't be attached.

- **`src/lambda/dispatch.js`** — stop skipping `subtype: "file_share"` thread
  messages so photo-only thread replies reach the mention handler. The existing
  guards (must have `thread_ts`, ignore `bot_id`) still apply.

- **`src/lambda/clients.js`** — construct a `google.drive({ version: "v3", auth:
  oauth2Client })` client, build the drive service, and pass it (plus the Slack
  bot token, needed for downloads) into the mention handler.

- **`src/config.js`**, **`.env.example`**, **`template.yaml`**, **README** — add
  `GOOGLE_DRIVE_FOLDER_ID`.

## Operational setup (one-time, performed by the operator)

- **Regenerate the Google refresh token** with the added `drive.file` scope.
  `scripts/get-google-token.js` gets `drive.file` added to its requested scopes.
  `drive.file` lets the app manage only files it creates — minimal and
  sufficient for upload + permission-setting on its own files.
- **Create a dedicated Drive folder**, share it with the same Google identity
  that issued the refresh token, and set its ID as `GOOGLE_DRIVE_FOLDER_ID`.
- **Add the `files:read` Slack OAuth scope** and reinstall the app.

## Error handling

- Photo download/upload failures never block issue logging — they degrade to
  "logged without photo," logged to CloudWatch. The Slack reply notes the
  degradation when relevant.
- `IMAGE()` render flakiness is covered by the always-present links column.
- Non-image attachments are silently ignored.

## Known limitations

- **Row-id quirk (pre-existing, matched not fixed):** `appendIssue` always
  returns `"5"` because new rows are inserted at the top. Thread-reply appends
  (`appendNote` today, `appendPhotos` here) therefore target the most-recent
  row. Photos follow the same behavior as notes; this is unchanged scope.

## Testing

Unit tests for:

- `drive.js` — `uploadPhoto` against a mocked drive client (upload + permission
  calls, URL shapes).
- `photos.js` — pipeline against mocked `fetch` and drive service (image
  filtering, partial-failure degradation).
- `sheets.js` — `appendIssue` with photos and `appendPhotos` append semantics
  (thumbnail-only-if-empty, links concatenation).
- `mention.js` — issue creation and thread-reply paths with `event.files`,
  including graceful degradation.
- `dispatch.js` — `file_share` thread messages route to the handler;
  non-thread / bot file shares still skip.
