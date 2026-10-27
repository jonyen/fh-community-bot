// tests/services/memberGoogle.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemberGoogle, isInvalidGrant, isForbidden, isScopeMissing } from "../../src/services/memberGoogle.js";

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
    const mg = createMemberGoogle({ authStore: store, clientId: "C", clientSecret: "S", botEmail: "bot@acts2.network", googleLib: g.lib });
    expect(await mg.revoke("U1")).toBe(true);
    expect(g.made.at(-1).revokeToken).toHaveBeenCalledWith("1//refresh");
    expect(store.deleteUser).toHaveBeenCalledWith("U1");

    store.decryptToken.mockRejectedValue(new Error("kms down"));
    expect(await mg.revoke("U1")).toBe(true);
    expect(store.deleteUser).toHaveBeenCalledTimes(2);

    store.getUser.mockResolvedValue(null);
    expect(await mg.revoke("U1")).toBe(false);
  });

  // Revoking cancels the account's whole grant to the GCP project, which
  // would also kill the bot's own refresh token (2026-10-27).
  it("deletes but never revokes the bot's own account", async () => {
    const store = fakeStore({ googleEmail: "Bot@acts2.network", status: "active", ciphertext: "CT" });
    const mg = createMemberGoogle({ authStore: store, clientId: "C", clientSecret: "S", botEmail: "bot@acts2.network", googleLib: g.lib });
    expect(await mg.revoke("U1")).toBe(true);
    expect(store.decryptToken).not.toHaveBeenCalled();
    expect(g.made.some((c) => c.revokeToken.mock.calls.length)).toBe(false);
    expect(store.deleteUser).toHaveBeenCalledWith("U1");
  });

  it("deletes but never revokes while the bot's account is unknown", async () => {
    const store = fakeStore({ googleEmail: "e", status: "active", ciphertext: "CT" });
    const mg = createMemberGoogle({ authStore: store, clientId: "C", clientSecret: "S", googleLib: g.lib });
    expect(await mg.revoke("U1")).toBe(true);
    expect(g.made.some((c) => c.revokeToken.mock.calls.length)).toBe(false);
    expect(store.deleteUser).toHaveBeenCalledWith("U1");
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

describe("isScopeMissing (review fix)", () => {
  it("recognises a token without the needed scope", () => {
    expect(isScopeMissing({ code: 403, response: { data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } })).toBe(true);
    expect(isScopeMissing({ code: 403, response: { data: { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } } })).toBe(true);
    expect(isScopeMissing(Object.assign(new Error("Request had insufficient authentication scopes."), { code: 403 }))).toBe(true);
    expect(isScopeMissing(Object.assign(new Error("The caller does not have permission"), { code: 403 }))).toBe(false);
  });
});

