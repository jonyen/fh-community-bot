// tests/services/authStore.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAuthStore, PENDING_TTL_S, STATE_TTL_S, BOOKING_CLAIM_TTL_S } from "../../src/services/authStore.js";

function fakeDdb() {
  const items = new Map();
  const send = vi.fn(async (cmd) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case "PutCommand": {
        if (i.ConditionExpression && items.has(i.Item.pk)) {
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
