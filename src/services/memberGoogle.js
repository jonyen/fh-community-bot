// src/services/memberGoogle.js
// Google clients that act as one member, built from their stored refresh
// token. Only bookings use them; every read stays on the bot's token.
import { google } from "googleapis";
import { log } from "../lib/logger.js";

export function isInvalidGrant(err) {
  return err?.response?.data?.error === "invalid_grant" || /invalid_grant/.test(err?.message || "");
}

// The member unticked Calendar or Sheets on Google's consent screen, so the
// token works but can't do this. Connecting again with both fixes it; the
// sheet owner can't.
export function isScopeMissing(err) {
  const data = err?.response?.data?.error;
  const reasons = [...(data?.errors || []), ...(data?.details || [])].map((e) => e?.reason);
  return reasons.includes("insufficientPermissions") || reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    || /insufficient authentication scopes/i.test(err?.message || "");
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
