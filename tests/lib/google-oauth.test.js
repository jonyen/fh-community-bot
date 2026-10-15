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
