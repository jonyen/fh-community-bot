# Connected Google Accounts for #reservations — Design

**Date:** 2026-10-14
**Status:** Draft, pending review
**Builds on:** [`2026-10-14-reservations-hub-design.md`](./2026-10-14-reservations-hub-design.md) (branch `feat/reservations-hub`)

## Summary

Today every write the reservations bot makes uses one Google token, which
belongs to the bot owner (`jonathan.yen@acts2.network`). Equipment bookings
would therefore show him as the organizer, and sheet edits would show him as
the editor. Until this design ships, equipment bookings are link-only
(`RMS_BOOKING_ENABLED=false`).

This design lets each member **connect their own Google account once**. After
that, every booking they make from #reservations is written **as them**:
equipment calendar events, room request rows, and kitchen rows. Reads (check,
list, conflict checks, the weekly digest) keep using the bot token.

## Goals

- A member connects their acts2.network Google account from Slack in one click
  and one consent screen.
- Every booking is written with the member's own token: calendars and both
  sheets.
- A member who has not connected and asks to book is prompted to connect, and
  the same booking finishes automatically after they approve. They do not have
  to retype the request.
- Nobody can connect a Google account that is not their own.
- Members can disconnect at any time. A revoked token is detected and leads to
  a new prompt.
- Tokens are never readable in logs, Slack, SQS, or the database without KMS.

## Non-goals

- Domain-wide delegation (a service account acting as anyone). Rejected: it
  needs a super admin and grants the bot power over every account.
- Writing as the member for reads. Reads stay on the bot token, so the digest
  works without anyone connecting.
- Granting members edit access to sheets. If a member cannot edit a sheet, the
  bot tells them who to ask.
- Accounts outside `acts2.network`.

## Flow

1. **Request.** A member asks to book. Parsing, clarifying questions and the
   conflict check work exactly as in the hub design, using the bot token.
2. **Connected?** The bot looks up `user#<SlackId>`.
   - Connected (`status = active`): go to step 6.
   - Not connected or revoked: go to step 3.
3. **Pending booking.** The bot stores the parsed booking as `pending#<id>`
   (expires in 30 minutes). This includes the requester's Slack email from
   `users.info`. It also creates `state#<nonce>` (expires in 10 minutes, single
   use) that points at the pending id.
4. **Prompt.** The bot posts an **ephemeral** message in the thread, visible
   only to the requester:
   "To book as you, connect your Google account once." The message has a URL
   button, "Connect Google", that opens Google's consent page with:
   - `client_id` = the Web OAuth client
   - `redirect_uri` = `<FunctionUrl>oauth/google/callback`
   - `scope` = `openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/spreadsheets`
   - `access_type=offline`, `prompt=consent`, `hd=acts2.network`
   - `login_hint` = the Slack email, `state` = the nonce
5. **Callback** (receiver Lambda, `GET /oauth/google/callback`):
   1. Consume `state#<nonce>` with a conditional delete. If it is missing or
      already used, show "This link has expired. Ask again in #reservations."
   2. If Google returned `error=access_denied`, show "Not connected. Nothing
      was booked." and delete the pending booking.
   3. Exchange the code for tokens.
   4. Verify the `id_token` signature and audience. Require:
      `email_verified = true`, `hd = acts2.network`, and `email` equal (case
      insensitive) to the pending booking's Slack email. On a mismatch, store
      nothing. Revoke the new token, and show "You signed in as X, but your
      Slack account is Y. Please sign in as Y."
   5. Encrypt the refresh token with KMS (encryption context
      `{ slackUserId }`). Store `user#<SlackId>` with `status = active`.
   6. Enqueue `{ type: "oauth_connected", pendingId }` to the event queue.
   7. Return a small HTML page: "Connected. You can close this tab and go back
      to Slack."
6. **Book as the member** (worker):
   1. Load the pending booking (when resuming) or the current request.
   2. Re-run the conflict check, because the slot may have filled during the
      sign-in.
   3. Decrypt the member's refresh token. Build member Google clients
      (Calendar, Sheets) and call `adapter.book(request, { clients })`.
   4. Post the normal ✅ confirmation in the original thread (broadcast) and
      delete the pending booking.

## Adapter change

`book()` gets a second argument:

```js
book(request, { clients: { sheetsClient, calendarClient } })
```

- **Rooms and kitchen:** write with `clients.sheetsClient`.
- **RMS:** insert on the member's `primary` calendar with
  `clients.calendarClient`. The event description keeps
  `Requested by` / `Slack:` lines for reading back. The holder logic
  (`holderOf`) is unchanged, and the organizer is now the member.
- Reads and `findConflicts` keep the bot clients given at construction.
- When `clients` is missing (connect not configured), the adapter uses its
  bot clients, as today.

`RMS_BOOKING_ENABLED` keeps its meaning for the bot-token path only. When
connect is configured, equipment books as the member whatever this flag says.

## Failure handling

| Case | Behaviour |
|---|---|
| `invalid_grant` on refresh (revoked, password reset, 6-month idle) | Set `status = revoked`. Store the pending booking and prompt again (steps 3–4). |
| Sheet write returns 403 (no edit access) | Write nothing. Reply: "You don't have edit access to the room request sheet. Ask Management to share it with you: <link>". For the kitchen sheet, "Ask Arie Chen". |
| Calendar insert 403 (member may not book this resource) | Reply: "Google Calendar won't let your account book <item>. Ask <owner>." |
| Resource declines (taken in the meantime) | The existing path: delete the event and reply unavailable. |
| Pending booking expired before the callback | The callback still connects the account. The page says "Connected. Please send your request again." |
| Slot filled during sign-in | Conflict reply in the thread, as in the hub design. |
| KMS or DynamoDB error | Log and alarm (`ConnectFailed` metric). The member is told "Couldn't connect right now, please try again." |
| Same member, two pending requests | Each has its own pending id and link. Signing in through one link resumes only that booking. The member is connected after it, so the other request books when they send it again or open its link before it expires. |

## Disconnect

- `/reservations-disconnect` (slash command), or the message "disconnect my
  Google" in #reservations.
- The worker revokes the refresh token with Google
  (`oauth2.revokeToken`), deletes `user#<SlackId>`, and replies ephemerally
  "Disconnected. Bookings will ask you to connect again."

## Storage

One DynamoDB table, `fh-community-reservations-auth`, on-demand, TTL attribute
`expiresAt`.

| `pk` | Attributes | TTL |
|---|---|---|
| `user#<SlackId>` | `googleEmail`, `refreshTokenCiphertext` (base64), `scopes`, `connectedAt`, `status` (`active`/`revoked`) | none |
| `pending#<id>` | `slackUserId`, `slackEmail`, `request` (parsed booking JSON), `channel`, `threadTs`, `createdAt` | 30 min |
| `state#<nonce>` | `pendingId`, `slackUserId` | 10 min |

DynamoDB TTL deletion can lag. Every read therefore also checks `expiresAt`
itself.

## Security

- **Encryption.** A dedicated customer-managed KMS key. The receiver role gets
  `kms:Encrypt` only, and the worker role gets `kms:Decrypt` only. The
  encryption context `{ slackUserId }` binds each ciphertext to its owner.
- **State.** The nonce is a random 32-byte value (`crypto.randomBytes`), stored
  server-side, single use, 10-minute life. There is no signing secret to
  manage.
- **Account match.** The Google email must equal the Slack email and be in
  `acts2.network`. This blocks connecting someone else's Google account to
  your Slack account.
- **No token leaks.** Tokens and codes never appear in logs, Slack messages,
  SQS bodies or error pages. The logger redacts `refresh_token`,
  `access_token`, `code` and `id_token` fields.
- **Scope breadth.** `spreadsheets` grants access to every sheet the member
  can open. It is the narrowest scope that can write existing sheets
  (`drive.file` only covers files the app created). The consent screen shows
  this to the member.
- **Callback endpoint.** It is public (Function URL). It accepts only `GET`
  with `code` and `state`. Without a valid state it does nothing.

## Infra

- `template.yaml`: the table, the KMS key with its policy, IAM statements for
  the receiver (DynamoDB read/write, `kms:Encrypt`, `sqs:SendMessage`) and the
  worker (DynamoDB read/write, `kms:Decrypt`). New parameters
  `GoogleWebClientId` and `GoogleWebClientSecret` (NoEcho).
- The receiver keeps its Slack signature check for every path except
  `/oauth/google/callback`.
- The slash command `/reservations-disconnect` is registered in the Slack app.
- Cost: about $1/month for the KMS key. DynamoDB on-demand cost is negligible.

## Prerequisites (owner setup)

1. A GCP project owned by the **acts2.network** organization, with the OAuth
   consent screen user type set to **Internal**. (External in testing mode
   expires refresh tokens after 7 days and caps at 100 users.)
2. Calendar API and Sheets API enabled on that project.
3. A **Web application** OAuth client with redirect URI
   `<FunctionUrl>oauth/google/callback`. Its id and secret go in GitHub
   secrets `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_WEB_CLIENT_SECRET`.
4. The deploy role can create DynamoDB tables and KMS keys (add to
   `docs/aws-bootstrap.md`).

## Units

- `src/services/authStore.js`: DynamoDB + KMS. Save and load users, create and
  consume pending bookings and states.
- `src/lib/google-oauth.js`: build the consent URL, exchange a code, verify an
  `id_token`, revoke.
- `src/services/memberGoogle.js`: member refresh token to Sheets and Calendar
  clients, with a per-container access-token cache and `invalid_grant`
  detection.
- `src/lambda/oauthCallback.js`: the callback handler, called by the receiver
  for the callback path.
- `src/events/reservations.js`: connect check, prompt, resume on
  `oauth_connected`, disconnect.
- The adapters: the `book(request, { clients })` change.

## Testing

- `authStore`: fake DynamoDB and KMS clients. Round trip, conditional state
  consume (second use fails), expiry checks, and the encryption context passed
  to KMS.
- `google-oauth`: consent URL parameters, `id_token` checks (wrong `hd`, wrong
  email, unverified), error pages.
- Callback: happy path enqueues only the pending id; replayed state;
  `access_denied`; email mismatch revokes and stores nothing; expired pending
  booking still connects.
- Flow: not connected → pending + ephemeral prompt and no write; connected →
  writes with member clients; resume re-checks conflicts; `invalid_grant` →
  revoked + prompt; sheet 403 → owner message; disconnect revokes and deletes.
- Adapters: `book` uses the passed clients for writes and the bot clients for
  reads.
- Manual: a real connect with a test member on a far-future date, then
  disconnect and confirm the token is revoked.
