// tests/lambda/oauthCallback.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOAuthCallback } from "../../src/lambda/oauthCallback.js";

const PAYLOAD = { email: "deandra.shim@acts2.network", email_verified: true, hd: "acts2.network" };
const FULL_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/spreadsheets";
const REDIRECT = "https://cb.lambda-url.us-east-1.on.aws/oauth/google/callback";

function setup({ state = { pendingId: "P1", slackUserId: "U9", slackEmail: "deandra.shim@acts2.network" }, pending = { slackUserId: "U9" }, payload = PAYLOAD } = {}) {
  const authStore = {
    consumeState: vi.fn().mockResolvedValue(state),
    getPending: vi.fn().mockResolvedValue(pending),
    deletePending: vi.fn().mockResolvedValue(),
    saveUser: vi.fn().mockResolvedValue(),
  };
  const oauth2Client = {
    getToken: vi.fn().mockResolvedValue({ tokens: { refresh_token: "1//R", access_token: "A", id_token: "ID", scope: FULL_SCOPE } }),
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
    expect(authStore.saveUser).toHaveBeenCalledWith({ slackUserId: "U9", googleEmail: "deandra.shim@acts2.network", refreshToken: "1//R", scopes: FULL_SCOPE });
    expect(enqueue).toHaveBeenCalledWith({ type: "oauth_connected", pendingId: "P1", slackUserId: "U9" });
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

  it("tells a wrong-account sign-in how to try again (review fix)", async () => {
    const { cb } = setup({ payload: { ...PAYLOAD, email: "alan.chow@acts2.network" } });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.body).toContain("Then send your request again in #reservations.");
  });

  it("refuses a partial grant, revokes it and stores nothing (review fix)", async () => {
    const { cb, oauth2Client, authStore, enqueue } = setup();
    oauth2Client.getToken.mockResolvedValue({ tokens: { refresh_token: "1//R", access_token: "A", id_token: "ID",
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events" } });
    const page = await cb({ query: { code: "CODE", state: "N" }, redirectUri: REDIRECT });
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("both Google Calendar and Google Sheets");
    expect(page.body).toContain("Then send your request again in #reservations.");
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

describe("OAuth callback Lambda entry", () => {
  it("answers 404 for anything but GET on the callback path", async () => {
    const { handler } = await import("../../src/lambda/oauthCallback.js");
    expect((await handler({ rawPath: "/", requestContext: { http: { method: "GET" } } })).statusCode).toBe(404);
    expect((await handler({ rawPath: "/oauth/google/callback", requestContext: { http: { method: "POST" } } })).statusCode).toBe(404);
  });
  it("answers 503 when connect isn't configured", async () => {
    const { handler } = await import("../../src/lambda/oauthCallback.js");
    const res = await handler({ rawPath: "/oauth/google/callback", requestContext: { http: { method: "GET" }, domainName: "x" }, queryStringParameters: { state: "s" } });
    expect(res.statusCode).toBe(503);
  });
});
