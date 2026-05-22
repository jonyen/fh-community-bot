import crypto from "node:crypto";

const REPLAY_WINDOW_SECONDS = 60 * 5;

export function verifySlackSignature({ secret, body, timestamp, signature }) {
  if (!secret || !body || !timestamp || !signature) return false;

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > REPLAY_WINDOW_SECONDS) return false;

  const base = `v0:${timestamp}:${body}`;
  const computed = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
