# Connected Google Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members connect their own acts2.network Google account once from Slack, and every #reservations booking is then written as them.

**Architecture:** A pending booking and a single-use state nonce go in DynamoDB. The member gets an ephemeral "Connect Google" button that opens Google consent. A separate `OAuthCallbackFn` Lambda verifies the account, stores the KMS-encrypted refresh token, and queues `oauth_connected`. The worker resumes the booking with per-member Google clients. Reads stay on the bot token.

**Tech Stack:** Node 22 ESM, vitest, `googleapis` (OAuth2, Sheets, Calendar), `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-kms`, `@slack/web-api`, AWS SAM.

**Spec:** `docs/superpowers/specs/2026-10-14-reservations-connect-design.md` (builds on `docs/superpowers/specs/2026-10-14-reservations-hub-design.md`)

## Global Constraints

- Hosted domain: `acts2.network`. Google email must equal the Slack profile email (case-insensitive) and have `email_verified`.
- Scopes, exactly: `openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/spreadsheets`, with `access_type=offline`, `prompt=consent`.
- Pending booking lifetime 30 min (`1800` s); state nonce 10 min (`600` s), single use; nonce = 32 random bytes, base64url.
- Callback path: `/oauth/google/callback`, on `OAuthCallbackFn`'s own Function URL.
- Refresh tokens: KMS-encrypted with encryption context `{ slackUserId }`. Callback role `kms:Encrypt` only; worker role `kms:Decrypt` only.
- Tokens, codes and id tokens never appear in logs, Slack messages, SQS bodies or HTML pages.
- Reads (check, list, `findConflicts`, digest) always use the bot clients. Only `book()` writes use member clients.
- When connect is not configured, behaviour is exactly as on `feat/reservations-hub`.
- Table name `fh-community-reservations-auth`, key `pk` (string), TTL attribute `expiresAt` (epoch seconds). Code checks `expiresAt` itself as well.

## Review Focus

1. **Signing in with the wrong Google account** (personal Gmail, or a colleague's acts2 account): rejected, the new token revoked, nothing stored, and the page says which account to use. Pinned in Task 6.
2. **A reused, double-clicked or old consent link:** the second use shows "expired" and can never trigger a second booking. Pinned in Task 6 (state consumed once) and Task 8 (resume deletes the pending booking before booking).
3. **The slot is taken while the member is on the consent screen:** a conflict reply, never a double booking. Pinned in Task 8 (resume re-checks conflicts).
4. **A token revoked from Google's security page:** the next booking re-prompts instead of failing with an error. Pinned in Task 8 (`invalid_grant`).
5. **A member without edit access to a sheet:** told who to ask, with the link, not "couldn't save (403)". Pinned in Task 8.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/google-oauth.js` | Consent URL, identity check, HTML pages, callback path constant |
| `src/services/authStore.js` | DynamoDB + KMS: users, pending bookings, state nonces |
| `src/services/memberGoogle.js` | Member refresh token → Sheets/Calendar clients, revoke, error classifiers |
| `src/services/reservations/{rooms,kitchen,rms}.js` | `book(request, { clients })` |
| `src/lambda/oauthCallback.js` | Callback core (`createOAuthCallback`) + Lambda `handler` |
| `src/events/reservations.js` | Connect check, prompt, resume, revoked, 403 owners, disconnect |
| `src/lib/reservation-catalog.js` | `CATEGORY_OWNERS` |
| `src/lib/logger.js` | Redact token fields |
| `src/config.js`, `src/lambda/clients.js`, `src/lambda/dispatch.js` | Wiring |
| `template.yaml`, `.github/workflows/deploy.yml`, docs | Infra |

### Shared shapes

```js
// authStore user record (getUser)
{ googleEmail, status /* "active" | "revoked" */, ciphertext /* base64 */ }

// pending booking (getPending)
{ slackUserId, slackEmail, request: { req, requester, backend }, channel, threadTs }

// requester (built in the flow)
{ requesterName, requesterUserId, phone, permalink, slackEmail }

// memberGoogle.clientsFor(slackUserId)
{ status: "active", clients: { sheetsClient, calendarClient }, googleEmail } | { status: "none" | "revoked" }

// SQS envelope from the callback
{ type: "oauth_connected", pendingId }
```

---

### Task 1: Dependencies and log redaction

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm), `src/lib/logger.js`
- Test: `tests/lib/logger.test.js` (append)

**Interfaces:**
- Produces: logger redacts keys `refresh_token`, `access_token`, `id_token`, `refreshToken`, `client_secret` to `"[redacted]"` at any depth.

- [ ] **Step 1: Install**

Run: `npm install @aws-sdk/client-dynamodb@^3.1051.0 @aws-sdk/lib-dynamodb@^3.1051.0 @aws-sdk/client-kms@^3.1051.0`
Expected: three packages added to `dependencies`.

- [ ] **Step 2: Write the failing test (append to `tests/lib/logger.test.js`)**

```js
describe('redaction', () => {
  let out;
  beforeEach(() => { out = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  test('never writes token fields, at any depth', () => {
    log.info("tokens", { refresh_token: "R", nested: { access_token: "A", id_token: "I", refreshToken: "R2", client_secret: "S" }, keep: "ok" });
    const line = JSON.parse(out.mock.calls.at(-1)[0]);
    expect(line.refresh_token).toBe("[redacted]");
    expect(line.nested).toEqual({ access_token: "[redacted]", id_token: "[redacted]", refreshToken: "[redacted]", client_secret: "[redacted]" });
    expect(line.keep).toBe("ok");
    expect(out.mock.calls.at(-1)[0]).not.toMatch(/"R"|"A"|"I"|"R2"|"S"/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/lib/logger.test.js`
Expected: FAIL on `refresh_token` being `"R"`.

- [ ] **Step 4: Implement in `src/lib/logger.js`**

Above `function replacer()` add:

```js
// Google OAuth material must never reach CloudWatch, whoever logs it.
const REDACTED_KEYS = new Set(["refresh_token", "access_token", "id_token", "refreshToken", "client_secret"]);
```

and as the first line inside the returned function of `replacer()`:

```js
    if (REDACTED_KEYS.has(_key)) return "[redacted]";
```

- [ ] **Step 5: Run to verify pass, then the suite**

Run: `npx vitest run tests/lib/logger.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/logger.js tests/lib/logger.test.js
git commit -m "chore(connect): add DynamoDB and KMS SDKs; redact OAuth tokens in logs"
```

---

### Task 2: OAuth helpers

**Files:**
- Create: `src/lib/google-oauth.js`
- Test: `tests/lib/google-oauth.test.js`

**Interfaces:**
- Produces: `OAUTH_CALLBACK_PATH = "/oauth/google/callback"`, `HOSTED_DOMAIN = "acts2.network"`, `SCOPES` (array), `buildConsentUrl({ clientId, redirectUri, state, loginHint }) -> string`, `checkIdentity(payload, expectedEmail) -> { ok: true, email } | { ok: false, reason: "unverified"|"domain"|"mismatch", email }`, `htmlPage(statusCode, title, message) -> { statusCode, headers, body }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/google-oauth.test.js
import { describe, it, expect } from "vitest";
import { buildConsentUrl, checkIdentity, htmlPage, SCOPES, OAUTH_CALLBACK_PATH } from "../../src/lib/google-oauth.js";

describe("buildConsentUrl", () => {
  it("asks for offline access to calendar events and sheets in the acts2 domain", () => {
    const url = new URL(buildConsentUrl({ clientId: "CID", redirectUri: "https://cb.example/oauth/google/callback", state: "NONCE", loginHint: "d@acts2.network" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = Object.fromEntries(url.searchParams);
    expect(p).toEqual({
      client_id: "CID", redirect_uri: "https://cb.example/oauth/google/callback", response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/spreadsheets",
      access_type: "offline", prompt: "consent", hd: "acts2.network", state: "NONCE", login_hint: "d@acts2.network",
    });
    expect(SCOPES).toHaveLength(4);
    expect(OAUTH_CALLBACK_PATH).toBe("/oauth/google/callback");
  });
  it("omits login_hint when unknown", () => {
    const url = new URL(buildConsentUrl({ clientId: "C", redirectUri: "https://x/cb", state: "S" }));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

describe("checkIdentity", () => {
  const ok = { email: "Deandra.Shim@acts2.network", email_verified: true, hd: "acts2.network" };
  it("accepts the matching verified domain account, ignoring case", () => {
    expect(checkIdentity(ok, "deandra.shim@acts2.network")).toEqual({ ok: true, email: "Deandra.Shim@acts2.network" });
  });
  it("rejects an unverified email", () => {
    expect(checkIdentity({ ...ok, email_verified: false }, "deandra.shim@acts2.network")).toMatchObject({ ok: false, reason: "unverified" });
  });
  it("rejects another domain", () => {
    expect(checkIdentity({ email: "d@gmail.com", email_verified: true }, "d@acts2.network")).toEqual({ ok: false, reason: "domain", email: "d@gmail.com" });
  });
  it("rejects a colleague's account", () => {
    expect(checkIdentity({ ...ok, email: "alan.chow@acts2.network" }, "deandra.shim@acts2.network")).toEqual({ ok: false, reason: "mismatch", email: "alan.chow@acts2.network" });
  });
  it("rejects when there is no payload", () => {
    expect(checkIdentity(undefined, "x@acts2.network")).toMatchObject({ ok: false, reason: "unverified" });
  });
});

describe("htmlPage", () => {
  it("escapes text and forbids caching and referrers", () => {
    const page = htmlPage(403, "Wrong <account>", "Use a&b");
    expect(page.statusCode).toBe(403);
    expect(page.headers).toEqual({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    expect(page.body).toContain("Wrong &lt;account&gt;");
    expect(page.body).toContain("Use a&amp;b");
    expect(page.body).not.toContain("<account>");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/google-oauth.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/lib/google-oauth.js
// Per-member Google sign-in for #reservations. Only acts2.network accounts,
// and only the account whose email matches the member's Slack profile, so
// nobody can attach someone else's Google account to their Slack identity.
export const OAUTH_CALLBACK_PATH = "/oauth/google/callback";
export const HOSTED_DOMAIN = "acts2.network";
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function buildConsentUrl({ clientId, redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent: Google only returns a refresh token on a fresh consent.
    access_type: "offline",
    prompt: "consent",
    hd: HOSTED_DOMAIN,
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function checkIdentity(payload, expectedEmail) {
  const email = payload?.email || null;
  if (!payload?.email_verified) return { ok: false, reason: "unverified", email };
  if (payload.hd !== HOSTED_DOMAIN) return { ok: false, reason: "domain", email };
  if (String(email).toLowerCase() !== String(expectedEmail || "").toLowerCase()) {
    return { ok: false, reason: "mismatch", email };
  }
  return { ok: true, email };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function htmlPage(statusCode, title, message) {
  const t = escapeHtml(title);
  return {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d1d1f;background:#fff}@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}h1{font-size:1.4rem}</style></head>
<body><h1>${t}</h1><p>${escapeHtml(message)}</p></body></html>`,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/google-oauth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-oauth.js tests/lib/google-oauth.test.js
git commit -m "feat(connect): consent URL, identity check and callback pages"
```

---

### Task 3: Auth store (DynamoDB + KMS)

**Files:**
- Create: `src/services/authStore.js`
- Test: `tests/services/authStore.test.js`

**Interfaces:**
- Produces: `PENDING_TTL_S = 1800`, `STATE_TTL_S = 600`, `createAuthStore({ ddb, kms, tableName, keyId, now = () => Date.now() })` with:
  - `saveUser({ slackUserId, googleEmail, refreshToken, scopes })`
  - `getUser(slackUserId) -> { googleEmail, status, ciphertext } | null`
  - `decryptToken(slackUserId, ciphertext) -> string`
  - `markRevoked(slackUserId)`, `deleteUser(slackUserId)`
  - `createPending({ slackUserId, slackEmail, request, channel, threadTs }) -> { pendingId, nonce }`
  - `consumeState(nonce) -> { pendingId, slackUserId, slackEmail } | null`
  - `getPending(pendingId) -> { slackUserId, slackEmail, request, channel, threadTs } | null`
  - `deletePending(pendingId)`

- [ ] **Step 1: Write the failing tests**

```js
// tests/services/authStore.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAuthStore, PENDING_TTL_S, STATE_TTL_S } from "../../src/services/authStore.js";

function fakeDdb() {
  const items = new Map();
  const send = vi.fn(async (cmd) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case "PutCommand": items.set(i.Item.pk, structuredClone(i.Item)); return {};
      case "GetCommand": return { Item: items.has(i.Key.pk) ? structuredClone(items.get(i.Key.pk)) : undefined };
      case "DeleteCommand": {
        const old = items.get(i.Key.pk);
        if (i.ConditionExpression && !old) {
          const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
        }
        items.delete(i.Key.pk);
        return { Attributes: i.ReturnValues === "ALL_OLD" ? old : undefined };
      }
      case "UpdateCommand": {
        const it = items.get(i.Key.pk);
        if (it) it.status = i.ExpressionAttributeValues[":s"];
        return {};
      }
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
  return { send, items };
}

function fakeKms() {
  return {
    send: vi.fn(async (cmd) => {
      const i = cmd.input;
      if (cmd.constructor.name === "EncryptCommand") {
        return { CiphertextBlob: Buffer.from(`${JSON.stringify(i.EncryptionContext)}|${Buffer.from(i.Plaintext).toString("utf8")}`) };
      }
      if (cmd.constructor.name === "DecryptCommand") {
        const [ctx, plain] = Buffer.from(i.CiphertextBlob).toString("utf8").split("|");
        if (ctx !== JSON.stringify(i.EncryptionContext)) throw new Error("InvalidCiphertextException");
        return { Plaintext: Buffer.from(plain, "utf8") };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }),
  };
}

describe("authStore", () => {
  let ddb, kms, t, store;
  beforeEach(() => {
    ddb = fakeDdb();
    kms = fakeKms();
    t = 1_800_000_000_000;
    store = createAuthStore({ ddb, kms, tableName: "T", keyId: "K", now: () => t });
  });

  it("stores the refresh token only as ciphertext bound to the Slack user", async () => {
    await store.saveUser({ slackUserId: "U1", googleEmail: "d@acts2.network", refreshToken: "1//secret", scopes: "s" });
    const item = ddb.items.get("user#U1");
    expect(JSON.stringify(item)).not.toContain("1//secret");
    expect(item).toMatchObject({ googleEmail: "d@acts2.network", status: "active", scopes: "s" });
    expect(kms.send.mock.calls[0][0].input).toMatchObject({ KeyId: "K", EncryptionContext: { slackUserId: "U1" } });
    const user = await store.getUser("U1");
    expect(user).toEqual({ googleEmail: "d@acts2.network", status: "active", ciphertext: item.refreshTokenCiphertext });
    expect(await store.decryptToken("U1", user.ciphertext)).toBe("1//secret");
  });

  it("will not decrypt one user's token as another's", async () => {
    await store.saveUser({ slackUserId: "U1", googleEmail: "d@acts2.network", refreshToken: "tok", scopes: "" });
    const { ciphertext } = await store.getUser("U1");
    await expect(store.decryptToken("U2", ciphertext)).rejects.toThrow();
  });

  it("marks revoked and deletes", async () => {
    await store.saveUser({ slackUserId: "U1", googleEmail: "e", refreshToken: "tok", scopes: "" });
    await store.markRevoked("U1");
    expect((await store.getUser("U1")).status).toBe("revoked");
    await store.deleteUser("U1");
    expect(await store.getUser("U1")).toBeNull();
  });

  it("creates a pending booking and a single-use state with their lifetimes", async () => {
    const { pendingId, nonce } = await store.createPending({ slackUserId: "U1", slackEmail: "d@acts2.network", request: { backend: "rms" }, channel: "C", threadTs: "1.1" });
    expect(pendingId).toMatch(/^[0-9a-f]{32}$/);
    expect(Buffer.from(nonce, "base64url")).toHaveLength(32);
    const nowS = Math.floor(t / 1000);
    expect(ddb.items.get(`pending#${pendingId}`).expiresAt).toBe(nowS + PENDING_TTL_S);
    expect(ddb.items.get(`state#${nonce}`).expiresAt).toBe(nowS + STATE_TTL_S);
    expect(await store.getPending(pendingId)).toEqual({ slackUserId: "U1", slackEmail: "d@acts2.network", request: { backend: "rms" }, channel: "C", threadTs: "1.1" });

    expect(await store.consumeState(nonce)).toEqual({ pendingId, slackUserId: "U1", slackEmail: "d@acts2.network" });
    expect(await store.consumeState(nonce)).toBeNull();
  });

  it("treats expired records as gone even before TTL deletes them", async () => {
    const { pendingId, nonce } = await store.createPending({ slackUserId: "U1", slackEmail: "e", request: {}, channel: "C", threadTs: "1" });
    t += (STATE_TTL_S + 1) * 1000;
    expect(await store.consumeState(nonce)).toBeNull();
    expect(await store.getPending(pendingId)).not.toBeNull();
    t += PENDING_TTL_S * 1000;
    expect(await store.getPending(pendingId)).toBeNull();
  });

  it("deletes a pending booking", async () => {
    const { pendingId } = await store.createPending({ slackUserId: "U1", slackEmail: "e", request: {}, channel: "C", threadTs: "1" });
    await store.deletePending(pendingId);
    expect(await store.getPending(pendingId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/authStore.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/services/authStore.js
// One DynamoDB table holds connected members, pending bookings and sign-in
// nonces. Refresh tokens are stored only as KMS ciphertext bound to the Slack
// user id, so a copied row is useless without the key and the right user.
// DynamoDB TTL can lag by hours, so every read checks expiresAt itself.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

export const PENDING_TTL_S = 1800;
export const STATE_TTL_S = 600;

export function createAuthStore({ ddb, kms, tableName, keyId, now = () => Date.now() }) {
  const nowS = () => Math.floor(now() / 1000);
  const live = (item) => item && (item.expiresAt == null || item.expiresAt > nowS());

  async function saveUser({ slackUserId, googleEmail, refreshToken, scopes }) {
    const enc = await kms.send(new EncryptCommand({
      KeyId: keyId, Plaintext: Buffer.from(refreshToken, "utf8"), EncryptionContext: { slackUserId },
    }));
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: `user#${slackUserId}`, googleEmail, scopes: scopes || "",
        refreshTokenCiphertext: Buffer.from(enc.CiphertextBlob).toString("base64"),
        connectedAt: new Date(now()).toISOString(), status: "active",
      },
    }));
  }

  async function getUser(slackUserId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `user#${slackUserId}` } }));
    if (!Item) return null;
    return { googleEmail: Item.googleEmail, status: Item.status, ciphertext: Item.refreshTokenCiphertext };
  }

  async function decryptToken(slackUserId, ciphertext) {
    const res = await kms.send(new DecryptCommand({
      KeyId: keyId, CiphertextBlob: Buffer.from(ciphertext, "base64"), EncryptionContext: { slackUserId },
    }));
    return Buffer.from(res.Plaintext).toString("utf8");
  }

  async function markRevoked(slackUserId) {
    await ddb.send(new UpdateCommand({
      TableName: tableName, Key: { pk: `user#${slackUserId}` },
      UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "revoked" }, ConditionExpression: "attribute_exists(pk)",
    }));
  }

  async function deleteUser(slackUserId) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `user#${slackUserId}` } }));
  }

  async function createPending({ slackUserId, slackEmail, request, channel, threadTs }) {
    const pendingId = randomBytes(16).toString("hex");
    const nonce = randomBytes(32).toString("base64url");
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `pending#${pendingId}`, slackUserId, slackEmail, request, channel, threadTs, expiresAt: nowS() + PENDING_TTL_S },
    }));
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `state#${nonce}`, pendingId, slackUserId, slackEmail, expiresAt: nowS() + STATE_TTL_S },
    }));
    return { pendingId, nonce };
  }

  // Deleting with a condition makes the nonce single use even under a
  // double-click: only one delete returns the old item.
  async function consumeState(nonce) {
    try {
      const { Attributes } = await ddb.send(new DeleteCommand({
        TableName: tableName, Key: { pk: `state#${nonce}` },
        ConditionExpression: "attribute_exists(pk)", ReturnValues: "ALL_OLD",
      }));
      if (!live(Attributes)) return null;
      return { pendingId: Attributes.pendingId, slackUserId: Attributes.slackUserId, slackEmail: Attributes.slackEmail };
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async function getPending(pendingId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `pending#${pendingId}` } }));
    if (!live(Item)) return null;
    return { slackUserId: Item.slackUserId, slackEmail: Item.slackEmail, request: Item.request, channel: Item.channel, threadTs: Item.threadTs };
  }

  async function deletePending(pendingId) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `pending#${pendingId}` } }));
  }

  return { saveUser, getUser, decryptToken, markRevoked, deleteUser, createPending, consumeState, getPending, deletePending };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/services/authStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/authStore.js tests/services/authStore.test.js
git commit -m "feat(connect): DynamoDB + KMS store for members, pending bookings and nonces"
```

---

### Task 4: Member Google clients

**Files:**
- Create: `src/services/memberGoogle.js`
- Test: `tests/services/memberGoogle.test.js`

**Interfaces:**
- Consumes: Task 3 `authStore.getUser`, `decryptToken`, `deleteUser`.
- Produces: `isInvalidGrant(err) -> boolean`, `isForbidden(err) -> boolean`, `createMemberGoogle({ authStore, clientId, clientSecret, googleLib = google })` with `clientsFor(slackUserId)`, `forget(slackUserId)`, `revoke(slackUserId) -> boolean` (true if they were connected).

- [ ] **Step 1: Write the failing tests**

```js
// tests/services/memberGoogle.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemberGoogle, isInvalidGrant, isForbidden } from "../../src/services/memberGoogle.js";

function fakeGoogle() {
  const made = [];
  class OAuth2 {
    constructor(...args) { this.args = args; made.push(this); this.revokeToken = vi.fn().mockResolvedValue({}); }
    setCredentials(c) { this.creds = c; }
  }
  return {
    made,
    lib: {
      auth: { OAuth2 },
      sheets: vi.fn(({ auth }) => ({ kind: "sheets", auth })),
      calendar: vi.fn(({ auth }) => ({ kind: "calendar", auth })),
    },
  };
}

function fakeStore(user) {
  return {
    getUser: vi.fn().mockResolvedValue(user),
    decryptToken: vi.fn().mockResolvedValue("1//refresh"),
    deleteUser: vi.fn().mockResolvedValue(),
  };
}

describe("memberGoogle", () => {
  let g;
  beforeEach(() => { g = fakeGoogle(); });

  it("builds Sheets and Calendar clients from the member's refresh token", async () => {
    const store = fakeStore({ googleEmail: "d@acts2.network", status: "active", ciphertext: "CT" });
    const mg = createMemberGoogle({ authStore: store, clientId: "CID", clientSecret: "SEC", googleLib: g.lib });
    const res = await mg.clientsFor("U1");
    expect(res.status).toBe("active");
    expect(res.googleEmail).toBe("d@acts2.network");
    expect(store.decryptToken).toHaveBeenCalledWith("U1", "CT");
    expect(g.made[0].args).toEqual(["CID", "SEC"]);
    expect(g.made[0].creds).toEqual({ refresh_token: "1//refresh" });
    expect(res.clients.sheetsClient).toEqual({ kind: "sheets", auth: g.made[0] });
    expect(res.clients.calendarClient).toEqual({ kind: "calendar", auth: g.made[0] });
  });

  it("reuses clients in a warm container until the token changes", async () => {
    const store = fakeStore({ googleEmail: "e", status: "active", ciphertext: "CT" });
    const mg = createMemberGoogle({ authStore: store, clientId: "C", clientSecret: "S", googleLib: g.lib });
    await mg.clientsFor("U1");
    await mg.clientsFor("U1");
    expect(store.decryptToken).toHaveBeenCalledTimes(1);
    store.getUser.mockResolvedValue({ googleEmail: "e", status: "active", ciphertext: "CT2" });
    await mg.clientsFor("U1");
    expect(store.decryptToken).toHaveBeenCalledTimes(2);
  });

  it("reports none and revoked without decrypting", async () => {
    const none = createMemberGoogle({ authStore: fakeStore(null), clientId: "C", clientSecret: "S", googleLib: g.lib });
    expect(await none.clientsFor("U1")).toEqual({ status: "none" });
    const revokedStore = fakeStore({ googleEmail: "e", status: "revoked", ciphertext: "CT" });
    const revoked = createMemberGoogle({ authStore: revokedStore, clientId: "C", clientSecret: "S", googleLib: g.lib });
    expect(await revoked.clientsFor("U1")).toEqual({ status: "revoked" });
    expect(revokedStore.decryptToken).not.toHaveBeenCalled();
  });

  it("revokes with Google, deletes the record, and survives a Google failure", async () => {
    const store = fakeStore({ googleEmail: "e", status: "active", ciphertext: "CT" });
    const mg = createMemberGoogle({ authStore: store, clientId: "C", clientSecret: "S", googleLib: g.lib });
    expect(await mg.revoke("U1")).toBe(true);
    expect(g.made.at(-1).revokeToken).toHaveBeenCalledWith("1//refresh");
    expect(store.deleteUser).toHaveBeenCalledWith("U1");

    store.decryptToken.mockRejectedValue(new Error("kms down"));
    expect(await mg.revoke("U1")).toBe(true);
    expect(store.deleteUser).toHaveBeenCalledTimes(2);

    store.getUser.mockResolvedValue(null);
    expect(await mg.revoke("U1")).toBe(false);
  });
});

describe("error classifiers", () => {
  it("recognises a revoked token", () => {
    expect(isInvalidGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isInvalidGrant(new Error("invalid_grant"))).toBe(true);
    expect(isInvalidGrant(new Error("quota"))).toBe(false);
  });
  it("recognises a permission error", () => {
    expect(isForbidden({ code: 403 })).toBe(true);
    expect(isForbidden({ status: 403 })).toBe(true);
    expect(isForbidden({ response: { status: 403 } })).toBe(true);
    expect(isForbidden({ code: "403" })).toBe(true);
    expect(isForbidden({ code: 500 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/memberGoogle.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/services/memberGoogle.js
// Google clients that act as one member, built from their stored refresh
// token. Only bookings use them; every read stays on the bot's token.
import { google } from "googleapis";
import { log } from "../lib/logger.js";

export function isInvalidGrant(err) {
  return err?.response?.data?.error === "invalid_grant" || /invalid_grant/.test(err?.message || "");
}

export function isForbidden(err) {
  return Number(err?.code ?? err?.status ?? err?.response?.status) === 403;
}

export function createMemberGoogle({ authStore, clientId, clientSecret, googleLib = google }) {
  // Warm containers keep the OAuth2 client, which caches its access token.
  const cache = new Map();

  async function clientsFor(slackUserId) {
    const user = await authStore.getUser(slackUserId);
    if (!user) return { status: "none" };
    if (user.status !== "active") return { status: user.status };
    const hit = cache.get(slackUserId);
    if (hit && hit.ciphertext === user.ciphertext) {
      return { status: "active", clients: hit.clients, googleEmail: user.googleEmail };
    }
    const refreshToken = await authStore.decryptToken(slackUserId, user.ciphertext);
    const auth = new googleLib.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const clients = {
      sheetsClient: googleLib.sheets({ version: "v4", auth }),
      calendarClient: googleLib.calendar({ version: "v3", auth }),
    };
    cache.set(slackUserId, { ciphertext: user.ciphertext, clients });
    return { status: "active", clients, googleEmail: user.googleEmail };
  }

  function forget(slackUserId) {
    cache.delete(slackUserId);
  }

  // Deletes the record even when Google or KMS fails: a member who asked to
  // disconnect must never be booked as again.
  async function revoke(slackUserId) {
    const user = await authStore.getUser(slackUserId);
    if (!user) return false;
    try {
      const token = await authStore.decryptToken(slackUserId, user.ciphertext);
      await new googleLib.auth.OAuth2(clientId, clientSecret).revokeToken(token);
    } catch (error) {
      log.warn("google token revoke failed", { error });
    }
    await authStore.deleteUser(slackUserId);
    forget(slackUserId);
    return true;
  }

  return { clientsFor, forget, revoke };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/services/memberGoogle.test.js`
Expected: PASS. (The `kms down` case logs a warn line; that is expected output.)

- [ ] **Step 5: Commit**

```bash
git add src/services/memberGoogle.js tests/services/memberGoogle.test.js
git commit -m "feat(connect): per-member Google clients, revoke, error classifiers"
```

---

### Task 5: Adapters write with the member's clients

**Files:**
- Modify: `src/services/reservations/rooms.js`, `src/services/reservations/kitchen.js`, `src/services/reservations/rms.js`
- Test: append to `tests/services/reservations/rooms.test.js`, `kitchen.test.js`, `rms.test.js`

**Interfaces:**
- Produces: `book(request, { clients } = {})`. Writes use `clients.sheetsClient` / `clients.calendarClient` when given; reads always use the construction clients. RMS: `bookingEnabled=false` only blocks when `clients` is absent.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` of `tests/services/reservations/rooms.test.js`:

```js
  it("appends with the member's Sheets client when given, still reading with the bot's", async () => {
    const member = { spreadsheets: { values: { append: vi.fn().mockResolvedValue({}) } } };
    await adapter.book(
      { date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }], title: "T", ministry: "", requesterName: "D" },
      { clients: { sheetsClient: member } }
    );
    expect(member.spreadsheets.values.append).toHaveBeenCalledTimes(1);
    expect(sheets.spreadsheets.values.append).not.toHaveBeenCalled();
  });
```

Append inside the top-level `describe` of `tests/services/reservations/kitchen.test.js`:

```js
  it("writes with the member's Sheets client but finds the row with the bot's", async () => {
    const member = { spreadsheets: { values: { batchUpdate: vi.fn().mockResolvedValue({}) } } };
    await adapter.book(
      { date: "2026-10-17", start: 1020, end: 1080, requesterName: "J", phone: "", appliances: {} },
      { clients: { sheetsClient: member } }
    );
    expect(sheets.spreadsheets.values.get).toHaveBeenCalled();
    expect(member.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    expect(sheets.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
  });
```

Append inside the top-level `describe` of `tests/services/reservations/rms.test.js`:

```js
  it("books on the member's calendar when given, even with bot booking disabled", async () => {
    const memberCal = makeCalendar();
    const off = createRmsAdapter({ calendarClient: cal, catalog: [SET2], bookingEnabled: false, sleep: async () => {} });
    const res = await off.book(
      { date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "T", requesterName: "D", requesterUserId: "U9", permalink: "p" },
      { clients: { calendarClient: memberCal } }
    );
    expect(res.status).toBe("booked");
    expect(memberCal.events.insert).toHaveBeenCalledTimes(1);
    expect(memberCal.events.get).toHaveBeenCalled();
    expect(cal.events.insert).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/reservations/`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

`src/services/reservations/rooms.js` — change the `book` signature and the client used for the append:

```js
  async function book({ date, start, end, items, title, ministry, requesterName }, { clients } = {}) {
    // Written as the member when they are connected, so the sheet's edit
    // history shows them.
    const writer = clients?.sheetsClient || sheetsClient;
    await writer.spreadsheets.values.append({
```

(the rest of the call is unchanged).

`src/services/reservations/kitchen.js` — change the signature and the `batchUpdate` client:

```js
  async function book({ date, start, end, requesterName, phone, appliances = {} }, { clients } = {}) {
```

and replace `await sheetsClient.spreadsheets.values.batchUpdate({` with:

```js
    const writer = clients?.sheetsClient || sheetsClient;
    await writer.spreadsheets.values.batchUpdate({
```

`src/services/reservations/rms.js` — change the signature, the disabled check, and use one calendar for insert/get/delete:

```js
  async function book({ date, start, end, items, title, requesterName, requesterUserId, permalink }, { clients } = {}) {
    const itemLink = calendarLink(items[0].calendarId);
    // A connected member books on their own calendar; the flag only governs
    // booking on the bot's.
    if (!bookingEnabled && !clients) {
```

then directly after that `if` block:

```js
    const cal = clients?.calendarClient || calendarClient;
```

and replace each `calendarClient.events.insert(`, `calendarClient.events.get(` and `calendarClient.events.delete(` inside `book` with `cal.events.insert(`, `cal.events.get(` and `cal.events.delete(`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/services/reservations/ && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/reservations tests/services/reservations
git commit -m "feat(connect): adapters write with the member's Google clients"
```

---

### Task 6: OAuth callback Lambda

**Files:**
- Create: `src/lambda/oauthCallback.js`
- Test: `tests/lambda/oauthCallback.test.js`

**Interfaces:**
- Consumes: Task 2 `checkIdentity`, `htmlPage`, `OAUTH_CALLBACK_PATH`; Task 3 `consumeState`, `getPending`, `deletePending`, `saveUser`.
- Produces: `createOAuthCallback({ authStore, oauth2Client, clientId, enqueue }) -> async ({ query, redirectUri }) => page`; `handler(event)` (Lambda entry; lazy deps from env `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET`, `AUTH_TABLE`, `AUTH_KMS_KEY_ID`, `EVENT_QUEUE_URL`).

- [ ] **Step 1: Write the failing tests**

```js
// tests/lambda/oauthCallback.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOAuthCallback } from "../../src/lambda/oauthCallback.js";

const PAYLOAD = { email: "deandra.shim@acts2.network", email_verified: true, hd: "acts2.network" };
const REDIRECT = "https://cb.lambda-url.us-east-1.on.aws/oauth/google/callback";

function setup({ state = { pendingId: "P1", slackUserId: "U9", slackEmail: "deandra.shim@acts2.network" }, pending = { slackUserId: "U9" }, payload = PAYLOAD } = {}) {
  const authStore = {
    consumeState: vi.fn().mockResolvedValue(state),
    getPending: vi.fn().mockResolvedValue(pending),
    deletePending: vi.fn().mockResolvedValue(),
    saveUser: vi.fn().mockResolvedValue(),
  };
  const oauth2Client = {
    getToken: vi.fn().mockResolvedValue({ tokens: { refresh_token: "1//R", access_token: "A", id_token: "ID", scope: "s" } }),
    verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => payload }),
    revokeToken: vi.fn().mockResolvedValue({}),
  };
  const enqueue = vi.fn().mockResolvedValue();
  const cb = createOAuthCallback({ authStore, oauth2Client, clientId: "CID", enqueue });
  return { cb, authStore, oauth2Client, enqueue };
}

describe("OAuth callback", () => {
  it("connects the member and queues only the pending id", async () => {
    const { cb, authStore, oauth2Client, enqueue } = setup();
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(authStore.consumeState).toHaveBeenCalledWith("N");
    expect(oauth2Client.getToken).toHaveBeenCalledWith({ code: "CODE", redirect_uri: REDIRECT });
    expect(oauth2Client.verifyIdToken).toHaveBeenCalledWith({ idToken: "ID", audience: "CID" });
    expect(authStore.saveUser).toHaveBeenCalledWith({ slackUserId: "U9", googleEmail: "deandra.shim@acts2.network", refreshToken: "1//R", scopes: "s" });
    expect(enqueue).toHaveBeenCalledWith({ type: "oauth_connected", pendingId: "P1" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Connected");
    expect(page.body).not.toContain("1//R");
  });

  it("rejects a reused or unknown link without touching Google", async () => {
    const { cb, oauth2Client, enqueue } = setup({ state: null });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain("expired");
    expect(oauth2Client.getToken).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a missing state", async () => {
    const { cb, authStore } = setup();
    expect((await cb({ query: { code: "C" }, redirectUri: REDIRECT })).statusCode).toBe(400);
    expect(authStore.consumeState).not.toHaveBeenCalled();
  });

  it("drops the pending booking when the member declines consent", async () => {
    const { cb, authStore, oauth2Client } = setup();
    const page = await cb({ query: { error: "access_denied", state: "N" }, redirectUri: REDIRECT });
    expect(authStore.deletePending).toHaveBeenCalledWith("P1");
    expect(oauth2Client.getToken).not.toHaveBeenCalled();
    expect(page.body).toContain("Nothing was booked");
  });

  it("stores nothing and revokes the new token for a different account", async () => {
    const { cb, authStore, oauth2Client, enqueue } = setup({ payload: { ...PAYLOAD, email: "alan.chow@acts2.network" } });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("You signed in as alan.chow@acts2.network, but your Slack account is deandra.shim@acts2.network.");
    expect(oauth2Client.revokeToken).toHaveBeenCalledWith("1//R");
    expect(authStore.saveUser).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("tells a personal-account sign-in to use acts2.network", async () => {
    const { cb, authStore } = setup({ payload: { email: "d@gmail.com", email_verified: true } });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("acts2.network");
    expect(authStore.saveUser).not.toHaveBeenCalled();
  });

  it("still connects when the pending booking is gone, and asks for the request again", async () => {
    const { cb, authStore, enqueue } = setup({ pending: null });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(authStore.saveUser).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(page.body).toContain("send your request again");
  });

  it("shows a retry page when Google rejects the code", async () => {
    const { cb, oauth2Client, authStore } = setup();
    oauth2Client.getToken.mockRejectedValue(new Error("invalid_grant"));
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.statusCode).toBe(502);
    expect(authStore.saveUser).not.toHaveBeenCalled();
  });

  it("shows a retry page when no refresh token came back", async () => {
    const { cb, oauth2Client, authStore } = setup();
    oauth2Client.getToken.mockResolvedValue({ tokens: { access_token: "A", id_token: "ID" } });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.statusCode).toBe(502);
    expect(authStore.saveUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lambda/oauthCallback.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/lambda/oauthCallback.js
// Google redirects here after a member approves (or declines) access. It is
// its own Lambda, off the Slack receiver, so googleapis and the token
// exchange never slow the receiver against Slack's 3 s deadline. Nothing
// secret ever goes into the page, the logs or the queue: the queue only gets
// the pending booking id.
import { checkIdentity, htmlPage, OAUTH_CALLBACK_PATH, HOSTED_DOMAIN } from "../lib/google-oauth.js";
import { log, metric } from "../lib/logger.js";

const DIMENSIONS = { Flow: "connect" };

export function createOAuthCallback({ authStore, oauth2Client, clientId, enqueue }) {
  return async function handle({ query = {}, redirectUri }) {
    const { code, state, error } = query;
    if (!state) return htmlPage(400, "This link isn't valid", "Ask again in #reservations.");

    const consumed = await authStore.consumeState(state);
    if (!consumed) return htmlPage(400, "This link has expired", "Ask again in #reservations and use the new button.");

    if (error) {
      await authStore.deletePending(consumed.pendingId);
      return htmlPage(200, "Not connected", "Nothing was booked. You can close this tab.");
    }
    if (!code) return htmlPage(400, "This link isn't valid", "Ask again in #reservations.");

    let tokens;
    let payload;
    try {
      ({ tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUri }));
      const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      metric("ConnectFailed", 1, { dimensions: DIMENSIONS, fields: { stage: "exchange" } });
      log.error("google code exchange failed", { error: err });
      return htmlPage(502, "Couldn't connect", "Google didn't accept the sign-in. Please try again from Slack.");
    }

    const identity = checkIdentity(payload, consumed.slackEmail);
    if (!identity.ok) {
      try {
        await oauth2Client.revokeToken(tokens.refresh_token || tokens.access_token);
      } catch (err) {
        log.warn("revoking a rejected token failed", { error: err });
      }
      metric("ConnectRejected", 1, { dimensions: DIMENSIONS, fields: { reason: identity.reason } });
      const message = identity.reason === "mismatch"
        ? `You signed in as ${identity.email}, but your Slack account is ${consumed.slackEmail}. Please sign in as ${consumed.slackEmail}.`
        : `Please sign in with your ${HOSTED_DOMAIN} account (${consumed.slackEmail}).`;
      return htmlPage(403, "Wrong Google account", message);
    }

    if (!tokens.refresh_token) {
      metric("ConnectFailed", 1, { dimensions: DIMENSIONS, fields: { stage: "no_refresh_token" } });
      return htmlPage(502, "Couldn't connect", "Google didn't return offline access. Please try again from Slack.");
    }

    try {
      await authStore.saveUser({ slackUserId: consumed.slackUserId, googleEmail: identity.email, refreshToken: tokens.refresh_token, scopes: tokens.scope });
    } catch (err) {
      metric("ConnectFailed", 1, { dimensions: DIMENSIONS, fields: { stage: "store" } });
      log.error("storing google token failed", { error: err });
      return htmlPage(502, "Couldn't connect", "Something went wrong on our side. Please try again from Slack.");
    }
    metric("Connected", 1, { dimensions: DIMENSIONS });

    const pending = await authStore.getPending(consumed.pendingId);
    if (!pending) {
      return htmlPage(200, "Connected", "Your Google account is connected. Please send your request again in #reservations.");
    }
    await enqueue({ type: "oauth_connected", pendingId: consumed.pendingId });
    return htmlPage(200, "Connected", "You can close this tab and go back to Slack. Your booking is being made now.");
  };
}

let cached;
async function getCallback() {
  if (cached !== undefined) return cached;
  const { GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, AUTH_TABLE, AUTH_KMS_KEY_ID, EVENT_QUEUE_URL } = process.env;
  if (!GOOGLE_WEB_CLIENT_ID || !GOOGLE_WEB_CLIENT_SECRET || !AUTH_TABLE || !AUTH_KMS_KEY_ID || !EVENT_QUEUE_URL) {
    cached = null;
    return cached;
  }
  const [{ google }, { DynamoDBClient }, { DynamoDBDocumentClient }, { KMSClient }, { SQSClient, SendMessageCommand }, { createAuthStore }] =
    await Promise.all([
      import("googleapis"), import("@aws-sdk/client-dynamodb"), import("@aws-sdk/lib-dynamodb"),
      import("@aws-sdk/client-kms"), import("@aws-sdk/client-sqs"), import("../services/authStore.js"),
    ]);
  const sqs = new SQSClient({});
  cached = createOAuthCallback({
    authStore: createAuthStore({
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      kms: new KMSClient({}),
      tableName: AUTH_TABLE,
      keyId: AUTH_KMS_KEY_ID,
    }),
    oauth2Client: new google.auth.OAuth2(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET),
    clientId: GOOGLE_WEB_CLIENT_ID,
    enqueue: (body) => sqs.send(new SendMessageCommand({ QueueUrl: EVENT_QUEUE_URL, MessageBody: JSON.stringify(body) })),
  });
  return cached;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method;
  if (method !== "GET" || event.rawPath !== OAUTH_CALLBACK_PATH) return htmlPage(404, "Not found", "Nothing here.");
  const callback = await getCallback();
  if (!callback) return htmlPage(503, "Not set up", "Google connect isn't configured yet.");
  // The redirect URI must match the one in the consent URL exactly; it is
  // this function's own URL, so it is rebuilt from the request host.
  const redirectUri = `https://${event.requestContext.domainName}${OAUTH_CALLBACK_PATH}`;
  return callback({ query: event.queryStringParameters || {}, redirectUri });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lambda/oauthCallback.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lambda/oauthCallback.js tests/lambda/oauthCallback.test.js
git commit -m "feat(connect): OAuth callback Lambda — verify account, store token, resume booking"
```

---

### Task 7: Category owners

**Files:**
- Modify: `src/lib/reservation-catalog.js`
- Test: `tests/lib/reservation-catalog.test.js` (append)

**Interfaces:**
- Produces: `CATEGORY_OWNERS = { rooms: "Management", kitchen: "Arie Chen", tech: "Alan Chow", sports: "Joe Pagan", outreach: "Joe Pagan", accessories: "the equipment team" }`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { CATEGORY_OWNERS } from "../../src/lib/reservation-catalog.js";

describe("CATEGORY_OWNERS", () => {
  it("names who to ask for each category", () => {
    expect(CATEGORY_OWNERS).toEqual({
      rooms: "Management", kitchen: "Arie Chen", tech: "Alan Chow",
      sports: "Joe Pagan", outreach: "Joe Pagan", accessories: "the equipment team",
    });
  });
});
```

(Put the `import` line with the file's other imports at the top.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/reservation-catalog.test.js`
Expected: FAIL, `CATEGORY_OWNERS` undefined.

- [ ] **Step 3: Implement — add after `CATEGORY_NAMES` in `src/lib/reservation-catalog.js`**

```js
// Who a member should ask when Google refuses their account (no edit access
// to a sheet, or not allowed to book a resource). From the OneStop Links tab.
export const CATEGORY_OWNERS = {
  rooms: "Management", kitchen: "Arie Chen", tech: "Alan Chow",
  sports: "Joe Pagan", outreach: "Joe Pagan", accessories: "the equipment team",
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/reservation-catalog.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservation-catalog.js tests/lib/reservation-catalog.test.js
git commit -m "feat(connect): category owners for access-denied replies"
```

---

### Task 8: Flow — connect, prompt, resume, revoked, 403, disconnect

**Files:**
- Modify: `src/events/reservations.js`
- Test: `tests/events/reservations-connect.test.js` (new)

**Interfaces:**
- Consumes: Task 3 store, Task 4 `isInvalidGrant`/`isForbidden`/memberGoogle, Task 5 `book(request, { clients })`, Task 7 `CATEGORY_OWNERS`.
- Produces: `createReservationsHandler({ llm, adapters, catalog, channelId, now, connect })` where `connect` is `null` or `{ authStore, memberGoogle, consentUrl: ({ state, loginHint }) => string }`; returns `{ channelId, handleMessage, resume({ pendingId, client }), disconnect({ userId, channel, client, responseUrl }) }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/events/reservations-connect.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsHandler } from "../../src/events/reservations.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { CLOSED_METADATA } from "../../src/lib/reservation-format.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
const BOOK = { intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" };
const MEMBER_CLIENTS = { sheetsClient: { kind: "member-sheets" }, calendarClient: { kind: "member-cal" } };

function makeAdapter(backend) {
  return {
    backend, link: `https://${backend}`,
    findConflicts: vi.fn().mockResolvedValue([]),
    listReservations: vi.fn().mockResolvedValue({ reservations: [], errors: [] }),
    book: vi.fn().mockResolvedValue({ status: "booked", link: `https://${backend}/item` }),
  };
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack/p1" }),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Deandra Shim", profile: { display_name: "Deandra", phone: "555", email: "deandra.shim@acts2.network" } } }),
      lookupByEmail: vi.fn().mockRejectedValue(new Error("users_not_found")),
    },
  };
}

function makeConnect(status = "none") {
  return {
    authStore: {
      createPending: vi.fn().mockResolvedValue({ pendingId: "P1", nonce: "NONCE" }),
      getPending: vi.fn(),
      deletePending: vi.fn().mockResolvedValue(),
      markRevoked: vi.fn().mockResolvedValue(),
    },
    memberGoogle: {
      clientsFor: vi.fn().mockResolvedValue(status === "active" ? { status, clients: MEMBER_CLIENTS, googleEmail: "deandra.shim@acts2.network" } : { status }),
      forget: vi.fn(),
      revoke: vi.fn().mockResolvedValue(true),
    },
    consentUrl: vi.fn(({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  };
}

const msg = (o = {}) => ({ type: "message", channel: "CRES", user: "U9", text: "book tech set 2 sat 2-4pm for youth night", ts: "100.1", ...o });

describe("reservations with connected accounts", () => {
  let llm, adapters, client;
  beforeEach(() => {
    llm = { parseReservationRequest: vi.fn().mockResolvedValue(BOOK) };
    adapters = { rooms: makeAdapter("rooms"), kitchen: makeAdapter("kitchen"), rms: makeAdapter("rms") };
    client = makeClient();
  });
  const handler = (connect) => createReservationsHandler({ llm, adapters, catalog: CATALOG, channelId: "CRES", now: () => new Date("2026-10-14T16:00:00Z"), connect });

  it("prompts a member who isn't connected, keeps the booking pending, writes nothing", async () => {
    const connect = makeConnect("none");
    await handler(connect).handleMessage({ event: msg(), client });
    expect(adapters.rms.book).not.toHaveBeenCalled();
    const pending = connect.authStore.createPending.mock.calls[0][0];
    expect(pending).toMatchObject({ slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES", threadTs: "100.1" });
    expect(pending.request.backend).toBe("rms");
    expect(pending.request.req.items).toEqual([SET2]);
    expect(pending.request.requester).toEqual({ requesterName: "Deandra", requesterUserId: "U9", phone: "555", permalink: "https://slack/p1", slackEmail: "deandra.shim@acts2.network" });
    expect(connect.consentUrl).toHaveBeenCalledWith({ state: "NONCE", loginHint: "deandra.shim@acts2.network" });
    const eph = client.chat.postEphemeral.mock.calls[0][0];
    expect(eph).toMatchObject({ channel: "CRES", user: "U9", thread_ts: "100.1", username: "FH Reservations" });
    expect(eph.text).toMatch(/connect your Google account once/);
    expect(eph.blocks[1].elements[0]).toMatchObject({ type: "button", url: "https://accounts.google.com/o/oauth2/v2/auth?state=NONCE", action_id: "reservations_connect_google" });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("books as a connected member", async () => {
    const connect = makeConnect("active");
    await handler(connect).handleMessage({ event: msg(), client });
    expect(adapters.rms.book.mock.calls[0][1]).toEqual({ clients: MEMBER_CLIENTS });
    expect(adapters.rms.book.mock.calls[0][0]).not.toHaveProperty("slackEmail");
    expect(client.chat.postMessage.mock.calls[0][0].text).toMatch(/^✅ Tech Set 2/);
  });

  it("re-prompts when the member's token was revoked in Google", async () => {
    const connect = makeConnect("active");
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }));
    await handler(connect).handleMessage({ event: msg(), client });
    expect(connect.authStore.markRevoked).toHaveBeenCalledWith("U9");
    expect(connect.memberGoogle.forget).toHaveBeenCalledWith("U9");
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/expired/);
    expect(connect.authStore.createPending).toHaveBeenCalled();
  });

  it("re-prompts a member whose status is already revoked", async () => {
    const connect = makeConnect("revoked");
    await handler(connect).handleMessage({ event: msg(), client });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/expired/);
    expect(adapters.rms.book).not.toHaveBeenCalled();
  });

  it("names who to ask when the member can't edit the room sheet", async () => {
    const connect = makeConnect("active");
    llm.parseReservationRequest.mockResolvedValue({ ...BOOK, items: ["MPR"] });
    adapters.rooms.book.mockRejectedValue(Object.assign(new Error("The caller does not have permission"), { code: 403 }));
    await handler(connect).handleMessage({ event: msg(), client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toBe("You don't have edit access to the room request sheet. Ask Management to share it with you: https://rooms");
  });

  it("names the equipment owner when Calendar refuses the member", async () => {
    const connect = makeConnect("active");
    adapters.rms.book.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: 403 }));
    await handler(connect).handleMessage({ event: msg(), client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toBe("Google Calendar won't let your account book Tech Set 2. Ask Alan Chow.");
  });

  it("can't connect a member with no email on their Slack profile", async () => {
    const connect = makeConnect("none");
    client.users.info.mockResolvedValue({ user: { real_name: "X", profile: { display_name: "X" } } });
    await handler(connect).handleMessage({ event: msg(), client });
    expect(connect.authStore.createPending).not.toHaveBeenCalled();
    expect(client.chat.postMessage.mock.calls[0][0].text).toMatch(/can't see an email on your Slack profile/);
  });

  it("disconnects on request", async () => {
    const connect = makeConnect("active");
    await handler(connect).handleMessage({ event: msg({ text: "please disconnect my google account" }), client });
    expect(connect.memberGoogle.revoke).toHaveBeenCalledWith("U9");
    expect(llm.parseReservationRequest).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0]).toMatchObject({ channel: "CRES", user: "U9", text: "Disconnected your Google account. Bookings will ask you to connect again." });
  });

  it("disconnect via slash command falls back to response_url", async () => {
    const connect = makeConnect("active");
    connect.memberGoogle.revoke.mockResolvedValue(false);
    client.chat.postEphemeral.mockRejectedValue(new Error("channel_not_found"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
    await handler(connect).disconnect({ userId: "U9", channel: "D1", client, responseUrl: "https://hooks.slack/r" });
    expect(fetchSpy).toHaveBeenCalledWith("https://hooks.slack/r", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ response_type: "ephemeral", text: "Your Google account wasn't connected." });
    fetchSpy.mockRestore();
  });

  it("without connect, books on the bot account as before", async () => {
    await handler(null).handleMessage({ event: msg(), client });
    expect(adapters.rms.book.mock.calls[0]).toHaveLength(1);
  });

  describe("resume after sign-in", () => {
    const pending = (connect) => connect.authStore.getPending.mockResolvedValue({
      slackUserId: "U9", slackEmail: "deandra.shim@acts2.network", channel: "CRES", threadTs: "100.1",
      request: {
        backend: "rms",
        req: { items: [SET2], date: "2026-10-17", start: 840, end: 960, title: "Youth night", ministry: null, appliances: {} },
        requester: { requesterName: "Deandra", requesterUserId: "U9", phone: "555", permalink: "https://slack/p1", slackEmail: "deandra.shim@acts2.network" },
      },
    });

    it("deletes the pending booking first, re-checks conflicts, then books as the member", async () => {
      const connect = makeConnect("active");
      pending(connect);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(connect.authStore.deletePending).toHaveBeenCalledWith("P1");
      expect(connect.authStore.deletePending.mock.invocationCallOrder[0]).toBeLessThan(adapters.rms.book.mock.invocationCallOrder[0]);
      expect(adapters.rms.findConflicts).toHaveBeenCalledWith({ date: "2026-10-17", start: 840, end: 960, items: [SET2] });
      expect(adapters.rms.book.mock.calls[0]).toEqual([
        { date: "2026-10-17", start: 840, end: 960, items: [SET2], title: "Youth night", ministry: null, requesterName: "Deandra", requesterUserId: "U9", phone: "555", permalink: "https://slack/p1", appliances: {} },
        { clients: MEMBER_CLIENTS },
      ]);
      const p = client.chat.postMessage.mock.calls[0][0];
      expect(p).toMatchObject({ channel: "CRES", thread_ts: "100.1", reply_broadcast: true, metadata: CLOSED_METADATA });
    });

    it("reports a slot taken during sign-in instead of booking", async () => {
      const connect = makeConnect("active");
      pending(connect);
      adapters.rms.findConflicts.mockResolvedValue([{ category: "tech", item: "Tech Set 2", date: "2026-10-17", start: 840, end: 900, title: "Rally", holder: "Alan", holderUserId: null, holderEmail: null }]);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(client.chat.postMessage.mock.calls[0][0].text).toMatch(/^❌ Tech Set 2 is taken/);
    });

    it("does nothing for an unknown or already-used pending id", async () => {
      const connect = makeConnect("active");
      connect.authStore.getPending.mockResolvedValue(null);
      await handler(connect).resume({ pendingId: "P1", client });
      expect(adapters.rms.book).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/events/reservations-connect.test.js`
Expected: most tests FAIL (`resume`/`disconnect` not functions, no ephemeral prompt).

- [ ] **Step 3: Implement in `src/events/reservations.js`**

Read the file first. Then:

(a) Imports — add:

```js
import { CATEGORY_OWNERS } from "../lib/reservation-catalog.js";
import { isInvalidGrant, isForbidden } from "../services/memberGoogle.js";
```

(merge `CATEGORY_OWNERS` into the existing `reservation-catalog.js` import line).

(b) Constants under `TECH_NOTE`:

```js
const DISCONNECT = /\bdisconnect\b.*\bgoogle\b/i;
```

(c) Factory signature: `export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date(), connect = null }) {`

(d) Add these inner functions after `withMentions`:

```js
  function makeReply(client, channel, rootTs) {
    return (text, { closed = false, broadcast = false } = {}) =>
      client.chat.postMessage({
        channel, thread_ts: rootTs, text, ...BOT_PERSONA,
        ...(broadcast ? { reply_broadcast: true } : {}),
        ...(closed ? { metadata: CLOSED_METADATA } : {}),
      });
  }

  function conflictText(req, conflicts) {
    const names = req.items.map((i) => i.label).join(", ");
    return `❌ ${names} is taken ${fmtDay(req.date)}:\n${conflicts.map(reservationLine).join("\n")}\nPlease check with them.`;
  }

  function forbiddenText(adapter, req) {
    if (adapter.backend === "rooms") return `You don't have edit access to the room request sheet. Ask ${CATEGORY_OWNERS.rooms} to share it with you: ${adapter.link}`;
    if (adapter.backend === "kitchen") return `You don't have edit access to the kitchen sheet. Ask ${CATEGORY_OWNERS.kitchen} to share it with you: ${adapter.link}`;
    const names = req.items.map((i) => i.label).join(", ");
    return `Google Calendar won't let your account book ${names}. Ask ${CATEGORY_OWNERS[req.items[0].category] || "the equipment team"}.`;
  }

  async function promptConnect({ req, adapter, requester, reply, client, channel, rootTs, revoked }) {
    if (!requester.slackEmail) {
      return reply(`I can't see an email on your Slack profile, so I can't connect your Google account. You can book directly: ${adapter.link}`);
    }
    const { nonce } = await connect.authStore.createPending({
      slackUserId: requester.requesterUserId, slackEmail: requester.slackEmail,
      request: { req, requester, backend: adapter.backend }, channel, threadTs: rootTs,
    });
    const url = connect.consentUrl({ state: nonce, loginHint: requester.slackEmail });
    const text = revoked
      ? "Your Google connection has expired. Connect again and I'll finish this booking as you."
      : "To book as you, connect your Google account once. I'll finish this booking as soon as you approve.";
    await client.chat.postEphemeral({
      channel, user: requester.requesterUserId, thread_ts: rootTs, text, ...BOT_PERSONA,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "actions", elements: [{ type: "button", action_id: "reservations_connect_google", style: "primary", text: { type: "plain_text", text: "Connect Google" }, url }] },
      ],
    });
  }

  async function finishBooking({ req, adapter, requester, reply, client, channel, rootTs }) {
    let clients;
    if (connect) {
      const member = await connect.memberGoogle.clientsFor(requester.requesterUserId);
      if (member.status !== "active") {
        return promptConnect({ req, adapter, requester, reply, client, channel, rootTs, revoked: member.status === "revoked" });
      }
      clients = member.clients;
    }
    const booking = {
      date: req.date, start: req.start, end: req.end, items: req.items, title: req.title, ministry: req.ministry,
      requesterName: requester.requesterName, requesterUserId: requester.requesterUserId, phone: requester.phone,
      permalink: requester.permalink, appliances: req.appliances,
    };
    let result;
    try {
      result = clients ? await adapter.book(booking, { clients }) : await adapter.book(booking);
    } catch (error) {
      if (clients && isInvalidGrant(error)) {
        await connect.authStore.markRevoked(requester.requesterUserId);
        connect.memberGoogle.forget(requester.requesterUserId);
        return promptConnect({ req, adapter, requester, reply, client, channel, rootTs, revoked: true });
      }
      if (clients && isForbidden(error)) return reply(forbiddenText(adapter, req));
      metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
      log.error("reservation write failed", { backend: adapter.backend, error });
      return reply(`⚠️ I couldn't save that booking (${error.message}). Please book it directly: ${adapter.link}`);
    }
    if (result.status !== "booked") {
      return reply(`${result.reason} You can book it here: ${result.link}`);
    }
    metric("ReservationBooked", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend, asMember: !!clients } });
    const names = req.items.map((i) => i.label).join(", ");
    const note = req.items.some((i) => i.category === "tech") ? `\n${TECH_NOTE}` : "";
    // The booking is written. Failing the event now would make SQS retry it
    // and book again, so a failed confirmation is logged, never rethrown.
    try {
      await reply(
        `✅ ${names} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)} · ${req.title} · <@${requester.requesterUserId}>\n<${result.link}|Open the booking>${note}`,
        { closed: true, broadcast: true }
      );
    } catch (error) {
      log.error("reservation confirmation failed", { backend: adapter.backend, error });
    }
  }

  async function resume({ pendingId, client }) {
    if (!connect) return;
    const pending = await connect.authStore.getPending(pendingId);
    if (!pending) return;
    // Deleted before booking: an SQS retry of this message finds nothing and
    // can never book twice.
    await connect.authStore.deletePending(pendingId);
    const { req, requester, backend } = pending.request;
    const adapter = adapters[backend];
    if (!adapter) return;
    const reply = makeReply(client, pending.channel, pending.threadTs);
    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    if (conflicts.length) return reply(conflictText(req, conflicts));
    return finishBooking({ req, adapter, requester, reply, client, channel: pending.channel, rootTs: pending.threadTs });
  }

  async function disconnect({ userId, channel, client, responseUrl }) {
    if (!connect) return;
    const had = await connect.memberGoogle.revoke(userId);
    const text = had ? "Disconnected your Google account. Bookings will ask you to connect again." : "Your Google account wasn't connected.";
    try {
      await client.chat.postEphemeral({ channel, user: userId, text, ...BOT_PERSONA });
    } catch (error) {
      if (!responseUrl) throw error;
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", text }),
      });
    }
  }
```

(e) In `handleMessage`:
- replace the inline `const reply = (text, …) => client.chat.postMessage({…});` with `const reply = makeReply(client, event.channel, rootTs);`
- directly after that line add:

```js
    if (connect && DISCONNECT.test(event.text)) return disconnect({ userId: event.user, channel: event.channel, client });
```

- replace the conflict reply line with `return reply(conflictText(req, conflicts));` (keep the `if (conflicts.length)`)
- replace everything from `const info = await client.users.info({ user: event.user });` to the end of `handleMessage` with:

```js
    const info = await client.users.info({ user: event.user });
    const profile = info.user?.profile || {};
    const { permalink } = await client.chat.getPermalink({ channel: event.channel, message_ts: rootTs });
    const requester = {
      requesterName: profile.display_name || info.user?.real_name || "Someone",
      requesterUserId: event.user,
      phone: profile.phone || "",
      permalink,
      slackEmail: profile.email || null,
    };
    return finishBooking({ req, adapter, requester, reply, client, channel: event.channel, rootTs });
  }
```

(f) Return value: `return { channelId, handleMessage, resume, disconnect };`

(g) Delete the line `const names = req.items.map((i) => i.label).join(", ");` in `handleMessage`; after this change nothing there uses it (`conflictText` and `finishBooking` build their own).

- [ ] **Step 4: Run new and existing flow tests**

Run: `npx vitest run tests/events/`
Expected: PASS — the new file and the unchanged `tests/events/reservations.test.js` (the existing booking test asserts `book` was called with one object, which still holds because without `connect` it is called with one argument).

- [ ] **Step 5: Commit**

```bash
git add src/events/reservations.js tests/events/reservations-connect.test.js
git commit -m "feat(connect): book as the member — prompt, resume after sign-in, revoked, 403 owners, disconnect"
```

---

### Task 9: Wiring — config, clients, dispatch

**Files:**
- Modify: `src/config.js`, `src/lambda/clients.js`, `src/lambda/dispatch.js`
- Test: `tests/config.test.js` (append), `tests/lambda/dispatch.test.js` (append)

**Interfaces:**
- Produces: `loadConfig().googleConnect = null | { clientId, clientSecret, redirectUri, tableName, keyId }` (all five of `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `AUTH_TABLE`, `AUTH_KMS_KEY_ID` required); dispatch routes `{ type: "oauth_connected", pendingId }` to `reservationsHandler.resume` and slash `/reservations-disconnect` to `reservationsHandler.disconnect`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.js`:

```js
describe("googleConnect config", () => {
  const BASE = { SLACK_BOT_TOKEN: "x", SLACK_CHANNEL_IDS: "C", GOOGLE_SHEET_ID: "s", GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "c", GOOGLE_REFRESH_TOKEN: "r" };
  const KEYS = ["GOOGLE_WEB_CLIENT_ID", "GOOGLE_WEB_CLIENT_SECRET", "OAUTH_REDIRECT_URI", "AUTH_TABLE", "AUTH_KMS_KEY_ID"];
  let originalEnv;
  beforeEach(() => { originalEnv = { ...process.env }; for (const k of KEYS) delete process.env[k]; Object.assign(process.env, BASE); });
  afterEach(() => { process.env = originalEnv; });

  it("is null unless every value is set", () => {
    process.env.GOOGLE_WEB_CLIENT_ID = "W";
    expect(loadConfig().googleConnect).toBeNull();
  });

  it("reads all five values", () => {
    Object.assign(process.env, { GOOGLE_WEB_CLIENT_ID: "W", GOOGLE_WEB_CLIENT_SECRET: "WS", OAUTH_REDIRECT_URI: "https://cb/oauth/google/callback", AUTH_TABLE: "T", AUTH_KMS_KEY_ID: "K" });
    expect(loadConfig().googleConnect).toEqual({ clientId: "W", clientSecret: "WS", redirectUri: "https://cb/oauth/google/callback", tableName: "T", keyId: "K" });
  });
});
```

Append to `tests/lambda/dispatch.test.js`:

```js
describe("dispatch for connected accounts", () => {
  it("resumes a booking after sign-in", async () => {
    const reservationsHandler = { channelId: "CRES", handleMessage: vi.fn(), resume: vi.fn().mockResolvedValue(), disconnect: vi.fn() };
    const client = makeClient();
    await dispatchSlackEvent({ slackEnvelope: { type: "oauth_connected", pendingId: "P1" }, handler: vi.fn(), reservationsHandler, client });
    expect(reservationsHandler.resume).toHaveBeenCalledWith({ pendingId: "P1", client });
  });

  it("routes /reservations-disconnect", async () => {
    const reservationsHandler = { channelId: "CRES", handleMessage: vi.fn(), resume: vi.fn(), disconnect: vi.fn().mockResolvedValue() };
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/reservations-disconnect", user_id: "U9", channel_id: "D1", response_url: "https://r" },
      handler: vi.fn(), reservationsHandler, client,
    });
    expect(reservationsHandler.disconnect).toHaveBeenCalledWith({ userId: "U9", channel: "D1", client, responseUrl: "https://r" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.js tests/lambda/dispatch.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`src/config.js` — add before `loadConfig`:

```js
// Members connecting their own Google accounts. Off unless the Web OAuth
// client, the callback URL, the table and the KMS key are all configured.
function loadGoogleConnect() {
  const { GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, OAUTH_REDIRECT_URI, AUTH_TABLE, AUTH_KMS_KEY_ID } = process.env;
  if (!GOOGLE_WEB_CLIENT_ID || !GOOGLE_WEB_CLIENT_SECRET || !OAUTH_REDIRECT_URI || !AUTH_TABLE || !AUTH_KMS_KEY_ID) return null;
  return { clientId: GOOGLE_WEB_CLIENT_ID, clientSecret: GOOGLE_WEB_CLIENT_SECRET, redirectUri: OAUTH_REDIRECT_URI, tableName: AUTH_TABLE, keyId: AUTH_KMS_KEY_ID };
}
```

and add `googleConnect: loadGoogleConnect(),` to the returned object.

`src/lambda/dispatch.js` — in the `slash_command` block, before its `return;`:

```js
    if (reservationsHandler?.disconnect && slackEnvelope.command === "/reservations-disconnect") {
      await reservationsHandler.disconnect({
        userId: slackEnvelope.user_id, channel: slackEnvelope.channel_id, client, responseUrl: slackEnvelope.response_url,
      });
    }
```

and before the `block_actions` block:

```js
  // Queued by the OAuth callback once a member has connected Google.
  if (slackEnvelope.type === "oauth_connected") {
    if (reservationsHandler?.resume) await reservationsHandler.resume({ pendingId: slackEnvelope.pendingId, client });
    return;
  }
```

`src/lambda/clients.js` — add imports:

```js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { createAuthStore } from "../services/authStore.js";
import { createMemberGoogle } from "../services/memberGoogle.js";
import { buildConsentUrl } from "../lib/google-oauth.js";
```

Inside `if (res) {`, before `reservationsHandler = createReservationsHandler({`:

```js
    let connect = null;
    const gc = config.googleConnect;
    if (gc) {
      const authStore = createAuthStore({
        ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), kms: new KMSClient({}), tableName: gc.tableName, keyId: gc.keyId,
      });
      connect = {
        authStore,
        memberGoogle: createMemberGoogle({ authStore, clientId: gc.clientId, clientSecret: gc.clientSecret }),
        consentUrl: ({ state, loginHint }) => buildConsentUrl({ clientId: gc.clientId, redirectUri: gc.redirectUri, state, loginHint }),
      };
    }
```

and add `connect,` to the `createReservationsHandler({ … })` argument object.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/lambda/clients.js src/lambda/dispatch.js tests/config.test.js tests/lambda/dispatch.test.js
git commit -m "feat(connect): wire connected accounts into config, clients and dispatch"
```

---

### Task 10: Infra, deploy and docs

**Files:**
- Modify: `template.yaml`, `.github/workflows/deploy.yml`, `.env.example`, `README.md`, `docs/RUNBOOK.md`, `docs/aws-bootstrap.md`

- [ ] **Step 1: `template.yaml` parameters** (after `RmsBookingEnabled`)

```yaml
  # Members connecting their own Google accounts (Web OAuth client in the
  # acts2.network GCP project, Internal consent screen). Off while empty.
  GoogleWebClientId:     { Type: String, Default: "", NoEcho: true }
  GoogleWebClientSecret: { Type: String, Default: "", NoEcho: true }
```

- [ ] **Step 2: `template.yaml` resources** (after `DigestFailedAlarm`)

```yaml
  # Connected members, pending bookings and sign-in nonces. Refresh tokens are
  # KMS ciphertext; pending rows and nonces expire through TTL.
  AuthTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: fh-community-reservations-auth
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: pk, AttributeType: S }
      KeySchema:
        - { AttributeName: pk, KeyType: HASH }
      TimeToLiveSpecification: { AttributeName: expiresAt, Enabled: true }
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }
      SSESpecification: { SSEEnabled: true }

  AuthKey:
    Type: AWS::KMS::Key
    Properties:
      Description: Encrypts members' Google refresh tokens for #reservations
      EnableKeyRotation: true
      KeyPolicy:
        Version: "2012-10-17"
        Statement:
          # Lets IAM policies grant use of the key; the functions below get
          # Encrypt or Decrypt, never both.
          - Sid: AccountRoot
            Effect: Allow
            Principal: { AWS: !Sub "arn:aws:iam::${AWS::AccountId}:root" }
            Action: "kms:*"
            Resource: "*"

  # Google redirects members here after consent. Its own function and URL, so
  # googleapis never weighs on the Slack receiver's 3 s budget.
  OAuthCallbackFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/lambda/oauthCallback.handler
      Description: Google sign-in callback for #reservations connected accounts
      MemorySize: 256
      Timeout: 15
      Environment:
        Variables:
          GOOGLE_WEB_CLIENT_ID:     !Ref GoogleWebClientId
          GOOGLE_WEB_CLIENT_SECRET: !Ref GoogleWebClientSecret
          AUTH_TABLE:               !Ref AuthTable
          AUTH_KMS_KEY_ID:          !Ref AuthKey
          EVENT_QUEUE_URL:          !Ref EventQueue
      FunctionUrlConfig:
        AuthType: NONE
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref AuthTable }
        - KMSEncryptPolicy: { KeyId: !Ref AuthKey }
        - SQSSendMessagePolicy: { QueueName: !GetAtt EventQueue.QueueName }

  OAuthCallbackLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/${OAuthCallbackFn}
      RetentionInDays: 14
```

- [ ] **Step 3: `template.yaml` worker changes**

WorkerFn `Environment.Variables` add:

```yaml
          GOOGLE_WEB_CLIENT_ID:     !Ref GoogleWebClientId
          GOOGLE_WEB_CLIENT_SECRET: !Ref GoogleWebClientSecret
          OAUTH_REDIRECT_URI:       !Sub "${OAuthCallbackFnUrl.FunctionUrl}oauth/google/callback"
          AUTH_TABLE:               !Ref AuthTable
          AUTH_KMS_KEY_ID:          !Ref AuthKey
```

WorkerFn `Policies` add (as new list items):

```yaml
        - DynamoDBCrudPolicy: { TableName: !Ref AuthTable }
        - KMSDecryptPolicy: { KeyId: !Ref AuthKey }
```

`Outputs` add:

```yaml
  OAuthRedirectUri:
    Description: Add this as an authorized redirect URI on the Google Web OAuth client
    Value: !Sub "${OAuthCallbackFnUrl.FunctionUrl}oauth/google/callback"
```

- [ ] **Step 4: Validate**

Run: `sam validate --lint`
Expected: `template.yaml is a valid SAM Template`.

- [ ] **Step 5: `.github/workflows/deploy.yml`**

`SAM deploy` env add:

```yaml
          GOOGLE_WEB_CLIENT_ID: ${{ secrets.GOOGLE_WEB_CLIENT_ID }}
          GOOGLE_WEB_CLIENT_SECRET: ${{ secrets.GOOGLE_WEB_CLIENT_SECRET }}
```

and in the script before `sam deploy`:

```bash
          if [ -n "$GOOGLE_WEB_CLIENT_ID" ]; then
            OPTIONAL_PARAMS+=("GoogleWebClientId=$GOOGLE_WEB_CLIENT_ID" "GoogleWebClientSecret=$GOOGLE_WEB_CLIENT_SECRET")
          fi
```

- [ ] **Step 6: Docs**

`docs/aws-bootstrap.md` — after the `scheduler` policy block, add:

````markdown
Connected Google accounts add a DynamoDB table and a KMS key. Add this inline
policy too, or the deploy fails with a `dynamodb:CreateTable` or
`kms:CreateKey` AccessDenied and rolls back:

```bash
aws iam put-role-policy --role-name <DEPLOY_ROLE> \
  --policy-name connected-accounts --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AuthTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeTable",
        "dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive", "dynamodb:DescribeTimeToLive",
        "dynamodb:UpdateContinuousBackups", "dynamodb:DescribeContinuousBackups",
        "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:ListTagsOfResource"
      ],
      "Resource": "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/fh-community-reservations-auth"
    },
    {
      "Sid": "AuthKey",
      "Effect": "Allow",
      "Action": [
        "kms:CreateKey", "kms:DescribeKey", "kms:GetKeyPolicy", "kms:PutKeyPolicy",
        "kms:EnableKeyRotation", "kms:GetKeyRotationStatus", "kms:ScheduleKeyDeletion",
        "kms:TagResource", "kms:UntagResource", "kms:ListResourceTags", "kms:UpdateKeyDescription"
      ],
      "Resource": "*"
    }
  ]
}'
```

`kms:CreateKey` has no resource ARN before the key exists, which is why that
statement is `*`.
````

`README.md` — in the `#reservations` section, after the digest paragraph, add:

```markdown
### Booking as yourself (connected Google accounts)

Bookings are written as the member who asked, so calendars show the real
organizer and the sheets' edit history shows the real person. The first time a
member books, the bot sends them a private "Connect Google" button. They sign
in with their acts2.network account (it must match their Slack email) and
approve Calendar and Sheets access, and the booking finishes on its own. To
disconnect, use `/reservations-disconnect` or write "disconnect my Google" in
#reservations.

Reads (check, list, the digest) still use the bot's Google token.

One-time setup:

1. In a GCP project owned by the acts2.network organization, set the OAuth
   consent screen to **Internal** and enable the Calendar and Sheets APIs.
2. Create a **Web application** OAuth client. Add the stack output
   `OAuthRedirectUri` as an authorized redirect URI.
3. Save its id and secret as GitHub secrets `GOOGLE_WEB_CLIENT_ID` and
   `GOOGLE_WEB_CLIENT_SECRET`, and redeploy.
4. In the Slack app, add the slash command `/reservations-disconnect` with the
   receiver's Function URL as its request URL.
```

`docs/RUNBOOK.md` — append:

```markdown
## Connected accounts: "Couldn't connect" pages or `ConnectFailed`

The `ConnectFailed` metric carries a `stage` field:

- `exchange`: Google refused the sign-in code. Usually the redirect URI on the
  Web OAuth client doesn't match the stack output `OAuthRedirectUri` exactly,
  or the client secret changed. Fix the client or the GitHub secrets and
  redeploy.
- `no_refresh_token`: Google returned no offline access. Check the consent
  screen is Internal and the scopes are approved.
- `store`: DynamoDB or KMS failed. Check the OAuthCallbackFn logs.

`ConnectRejected` with `reason: mismatch` means a member signed in with a
Google account that doesn't match their Slack email. This is working as
intended; the page told them which account to use.

## A member says bookings keep asking them to connect

Their stored token is revoked (they removed access in their Google account, or
it went unused for six months). The bot marks them `revoked` and prompts again;
connecting again fixes it. If it keeps happening for everyone, check the OAuth
consent screen is still **Internal**: in External testing mode Google expires
refresh tokens after 7 days.
```

`.env.example` — append:

```
# Connected Google accounts (optional). Web OAuth client from the acts2.network
# GCP project; the redirect URI is the OAuthRedirectUri stack output.
GOOGLE_WEB_CLIENT_ID=
GOOGLE_WEB_CLIENT_SECRET=
OAUTH_REDIRECT_URI=
AUTH_TABLE=fh-community-reservations-auth
AUTH_KMS_KEY_ID=
```

- [ ] **Step 7: Run tests and commit**

Run: `npm test && sam validate --lint`
Expected: PASS and valid.

```bash
git add template.yaml .github/workflows/deploy.yml .env.example README.md docs/RUNBOOK.md docs/aws-bootstrap.md
git commit -m "feat(connect): callback Lambda, auth table, KMS key, deploy secrets, docs"
```

---

### Task 11: Live connect test (after deploy; needs the owner)

Requires: both PRs merged and deployed, the four setup steps in the README done, the deploy-role policies applied. Ask the user before each step.

- [ ] **Step 1:** In #reservations, as a test member, ask to book an accessory on 2027-12-30 at 3 AM ("book the kiddie pool dec 30 2027 3-3:30am test"). Expect the ephemeral "Connect Google" button and no ✅.
- [ ] **Step 2:** Click it and sign in with the **wrong** account first, if one is handy. Expect the "Wrong Google account" page and no record in the table: `aws dynamodb get-item --table-name fh-community-reservations-auth --key '{"pk":{"S":"user#<SlackId>"}}'` returns nothing.
- [ ] **Step 3:** Ask again and sign in with the right account. Expect "Connected", then the ✅ in the thread within ~15 s, and the event on the member's own calendar with the Kiddie Pool accepted.
- [ ] **Step 4:** Click the old button again. Expect "This link has expired" and no second booking.
- [ ] **Step 5:** Delete the test event (from the member's calendar). Run `/reservations-disconnect`. Expect "Disconnected" and the table row gone; the app no longer listed at myaccount.google.com/permissions.
