// tests/services/authStore.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAuthStore, PENDING_TTL_S, STATE_TTL_S, BOOKING_CLAIM_TTL_S } from "../../src/services/authStore.js";

// Understands only the shapes the store uses: OR-joined clauses of
// attribute_not_exists(pk), "#v = :v" and "expiresAt <= :now".
function conditionHolds(i, old) {
  const vals = i.ExpressionAttributeValues || {};
  return i.ConditionExpression.split(" OR ").some((c) => {
    if (c === "attribute_exists(pk)") return !!old;
    if (c === "attribute_not_exists(pk)") return !old;
    if (c === "#v = :v") return !!old && old.version === vals[":v"];
    if (c === "expiresAt <= :now") return !!old && old.expiresAt <= vals[":now"];
    throw new Error(`fakeDdb cannot evaluate ${c}`);
  });
}

// Real marshalling throws on undefined (the client has no removeUndefinedValues).
function rejectUndefined(v, nested = false) {
  if (v === undefined && nested) throw new Error("Pass options.removeUndefinedValues=true to remove undefined values");
  if (v && typeof v === "object") Object.values(v).forEach((x) => rejectUndefined(x, true));
}

function fakeDdb() {
  const items = new Map();
  const send = vi.fn(async (cmd) => {
    const i = cmd.input;
    rejectUndefined(i.Item); rejectUndefined(i.ExpressionAttributeValues);
    switch (cmd.constructor.name) {
      case "PutCommand": {
        if (i.ConditionExpression && !conditionHolds(i, items.get(i.Item.pk))) {
          const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
        }
        items.set(i.Item.pk, structuredClone(i.Item)); return {};
      }
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
        if (i.ConditionExpression && !conditionHolds(i, it)) {
          const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
        }
        // "SET #n = :v, other = :w" on an existing row, or an upsert for the ledger.
        const target = it || { pk: i.Key.pk };
        for (const part of i.UpdateExpression.replace(/^SET /, "").split(", ")) {
          const [name, val] = part.split(" = ");
          target[i.ExpressionAttributeNames?.[name] || name] = structuredClone(i.ExpressionAttributeValues[val]);
        }
        items.set(i.Key.pk, target);
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

describe("booking claims", () => {
  it("claims a booking once; a second claim of the same key fails", async () => {
    const ddb = fakeDdb();
    const store = createAuthStore({ ddb, kms: {}, tableName: "T", keyId: "K", now: () => 1_000_000 });
    expect(await store.claimBooking("dm:D9:1.000100")).toBe(true);
    expect(await store.claimBooking("dm:D9:1.000100")).toBe(false);
    expect(await store.claimBooking("dm:D9:2.000100")).toBe(true);
    expect(ddb.items.get("booking#dm:D9:1.000100").expiresAt).toBe(1000 + BOOKING_CLAIM_TTL_S);
  });

  it("rethrows any other DynamoDB error", async () => {
    const ddb = { send: vi.fn().mockRejectedValue(Object.assign(new Error("throttled"), { name: "ThrottlingException" })) };
    const store = createAuthStore({ ddb, kms: {}, tableName: "T", keyId: "K" });
    await expect(store.claimBooking("k")).rejects.toThrow("throttled");
  });
});

describe("booking ledger", () => {
  const make = () => {
    const ddb = fakeDdb();
    return { ddb, store: createAuthStore({ ddb, kms: {}, tableName: "T", keyId: "K", now: () => 1_000_000 }) };
  };
  const ref = (date, n = 1) => ({ backend: "gcal", date, id: `e${n}` });

  it("records two refs and reads both back", async () => {
    const { store } = make();
    await store.recordBooking("U1", ref("2026-10-21", 1), { today: "2026-10-20" });
    await store.recordBooking("U1", ref("2026-10-22", 2), { today: "2026-10-20" });
    expect(await store.bookingsFor("U1", { today: "2026-10-20" })).toEqual([ref("2026-10-21", 1), ref("2026-10-22", 2)]);
  });

  it("hides past refs on read and drops them on the next write", async () => {
    const { ddb, store } = make();
    await store.recordBooking("U1", ref("2026-10-20", 1), { today: "2026-10-20" });
    expect(await store.bookingsFor("U1", { today: "2026-10-21" })).toEqual([]);
    await store.recordBooking("U1", ref("2026-10-22", 2), { today: "2026-10-21" });
    expect(ddb.items.get("bookings#U1").refs).toEqual([ref("2026-10-22", 2)]);
  });

  it("keeps the newest 50 of 51 records", async () => {
    const { store } = make();
    for (let n = 1; n <= 51; n++) await store.recordBooking("U1", ref("2026-11-01", n), { today: "2026-10-20" });
    const refs = await store.bookingsFor("U1", { today: "2026-10-20" });
    expect(refs).toHaveLength(50);
    expect(refs[0].id).toBe("e2");
    expect(refs[49].id).toBe("e51");
  });

  it("expires the row after the latest ref date", async () => {
    const { ddb, store } = make();
    await store.recordBooking("U1", ref("2026-10-21", 1), { today: "2026-10-20" });
    await store.recordBooking("U1", ref("2026-10-25", 2), { today: "2026-10-20" });
    expect(ddb.items.get("bookings#U1").expiresAt).toBeGreaterThan(Date.parse("2026-10-26T00:00:00Z") / 1000 - 1);
  });

  it("returns [] for an unknown user", async () => {
    const { store } = make();
    expect(await store.bookingsFor("U404", { today: "2026-10-20" })).toEqual([]);
  });
});

describe("tray and series", () => {
  let t, ddb, store;
  const ref = (date, n = 1) => ({ backend: "gcal", date, id: `e${n}` });
  const rms = (date, n) => ({ backend: "rms", date, eventId: n });
  const series = (refs) => ({ id: "s1", item: "x", start: "10:00", end: "11:00", title: "T", repeat: "weekly", channel: "C1", postTs: "1.2", refs });
  beforeEach(() => {
    t = Date.parse("2026-10-20T12:00:00Z");
    ddb = fakeDdb();
    store = createAuthStore({ ddb, kms: {}, tableName: "T", keyId: "K", now: () => t });
  });

  it("round-trips a tray and bumps its version", async () => {
    expect(await store.getTray("U1")).toBeNull();
    expect(await store.putTray("U1", { step: "pick" }, { expectVersion: 0 })).toBe(true);
    expect(await store.getTray("U1")).toEqual({ step: "pick", version: 1 });
    expect(await store.putTray("U1", { step: "when" }, { expectVersion: 1 })).toBe(true);
    expect((await store.getTray("U1")).version).toBe(2);
  });

  it("lets a stale writer lose", async () => {
    await store.putTray("U1", { step: "pick" }, { expectVersion: 0 });
    await store.putTray("U1", { step: "when" }, { expectVersion: 1 });
    expect(await store.putTray("U1", { step: "stale" }, { expectVersion: 1 })).toBe(false);
    expect(await store.putTray("U1", { step: "again" }, { expectVersion: 0 })).toBe(false);
    expect((await store.getTray("U1")).step).toBe("when");
  });

  it("rethrows errors other than a lost race", async () => {
    const boom = createAuthStore({ ddb: { send: async () => { throw new Error("down"); } }, kms: {}, tableName: "T", keyId: "K" });
    await expect(boom.putTray("U1", {}, { expectVersion: 0 })).rejects.toThrow("down");
  });

  it("reads an expired tray as null and lets version 0 replace it", async () => {
    await store.putTray("U1", { step: "pick" }, { expectVersion: 0 });
    t += 86401 * 1000;
    expect(await store.getTray("U1")).toBeNull();
    expect(await store.putTray("U1", { step: "new" }, { expectVersion: 0 })).toBe(true);
    expect(await store.getTray("U1")).toEqual({ step: "new", version: 1 });
  });

  it("deletes a tray", async () => {
    await store.putTray("U1", { step: "pick" }, { expectVersion: 0 });
    await store.deleteTray("U1");
    expect(await store.getTray("U1")).toBeNull();
  });

  it("hides past series refs and drops series that have ended", async () => {
    await store.recordSeries("U1", series([ref("2026-10-20", 1), ref("2026-10-27", 2)]), { today: "2026-10-20" });
    expect((await store.seriesFor("U1", { today: "2026-10-21" }))[0].refs).toEqual([ref("2026-10-27", 2)]);
    expect(await store.seriesFor("U1", { today: "2026-10-28" })).toEqual([]);
  });

  it("includes series refs in bookingsFor", async () => {
    await store.recordBooking("U1", ref("2026-10-21", 1), { today: "2026-10-20" });
    await store.recordSeries("U1", series([ref("2026-10-22", 2), ref("2026-10-29", 3)]), { today: "2026-10-20" });
    const got = await store.bookingsFor("U1", { today: "2026-10-20" });
    expect(got.map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("keeps singles and series when either is recorded after the other", async () => {
    await store.recordSeries("U1", series([ref("2026-11-10", 2)]), { today: "2026-10-20" });
    await store.recordBooking("U1", ref("2026-10-21", 1), { today: "2026-10-20" });
    const row = ddb.items.get("bookings#U1");
    expect(row.refs).toHaveLength(1);
    expect(row.series).toHaveLength(1);
    expect(row.expiresAt).toBe(Date.parse("2026-11-12T00:00:00Z") / 1000);
    await store.recordSeries("U1", { ...series([ref("2026-10-30", 3)]), id: "s2" }, { today: "2026-10-20" });
    expect(ddb.items.get("bookings#U1").refs).toHaveLength(1);
    expect(ddb.items.get("bookings#U1").series).toHaveLength(2);
  });

  it("caps single refs at MAX_BOOKING_REFS without touching series", async () => {
    await store.recordSeries("U1", series(Array.from({ length: 60 }, (_, n) => ref("2026-11-01", 100 + n))), { today: "2026-10-20" });
    for (let n = 1; n <= 51; n++) await store.recordBooking("U1", ref("2026-11-01", n), { today: "2026-10-20" });
    const row = ddb.items.get("bookings#U1");
    expect(row.refs).toHaveLength(50);
    expect(row.series[0].refs).toHaveLength(60);
  });

  it("drops named series refs by key and the series when empty", async () => {
    await store.recordSeries("U1", series([rms("2026-10-21", 7), rms("2026-10-28", 8)]), { today: "2026-10-20" });
    await store.dropSeriesRefs("U1", "s1", ["rms:7"]);
    expect((await store.seriesFor("U1", { today: "2026-10-20" }))[0].refs).toEqual([rms("2026-10-28", 8)]);
    await store.dropSeriesRefs("U1", "s1", ["rms:8"]);
    expect(await store.seriesFor("U1", { today: "2026-10-20" })).toEqual([]);
  });

  it("drops undefined fields before writing", async () => {
    expect(await store.putTray("U1", { step: "pick", note: undefined, nested: { a: undefined, b: 1 } }, { expectVersion: 0 })).toBe(true);
    expect(await store.getTray("U1")).toEqual({ step: "pick", nested: { b: 1 }, version: 1 });
    await store.recordSeries("U1", series([{ ...ref("2026-10-21", 1), holder: undefined }]), { today: "2026-10-20" });
    expect((await store.seriesFor("U1", { today: "2026-10-20" }))[0].refs).toEqual([ref("2026-10-21", 1)]);
  });

  it("ignores a series with no live refs", async () => {
    await store.recordSeries("U1", series([]), { today: "2026-10-20" });
    await store.recordSeries("U1", series([ref("2026-10-19", 1)]), { today: "2026-10-20" });
    expect(ddb.items.has("bookings#U1")).toBe(false);
  });

  it("falls back to a two day expiry when nothing has a date", async () => {
    await store.recordSeries("U1", series([ref("2026-10-21", 1)]), { today: "2026-10-20" });
    await store.dropSeriesRefs("U1", "s1", ["nope"]);
    await store.recordBooking("U1", ref("2026-10-21", 2), { today: "2026-10-20" });
    expect(Number.isFinite(ddb.items.get("bookings#U1").expiresAt)).toBe(true);
  });

  it("deletes the row when the last refs are dropped and no singles remain", async () => {
    await store.recordSeries("U1", series([rms("2026-10-21", 7)]), { today: "2026-10-20" });
    await store.dropSeriesRefs("U1", "s1", ["rms:7"]);
    expect(ddb.items.has("bookings#U1")).toBe(false);
  });

  it("leaves the row unchanged for an unknown series id", async () => {
    await store.recordSeries("U1", series([rms("2026-10-21", 7)]), { today: "2026-10-20" });
    const before = structuredClone(ddb.items.get("bookings#U1"));
    await store.dropSeriesRefs("U1", "nope", ["rms:7"]);
    expect(ddb.items.get("bookings#U1")).toEqual(before);
  });
});
