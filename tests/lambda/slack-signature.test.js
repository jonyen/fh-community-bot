import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySlackSignature } from "../../src/lambda/slack-signature.js";

const SECRET = "test-signing-secret";

function sign(body, timestamp) {
  const base = `v0:${timestamp}:${body}`;
  return "v0=" + crypto.createHmac("sha256", SECRET).update(base).digest("hex");
}

describe("verifySlackSignature", () => {
  it("accepts a valid signature within the replay window", () => {
    const body = '{"type":"event_callback"}';
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = sign(body, ts);
    expect(verifySlackSignature({ secret: SECRET, body, timestamp: ts, signature: sig })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = sign("original", ts);
    expect(verifySlackSignature({ secret: SECRET, body: "tampered", timestamp: ts, signature: sig })).toBe(false);
  });

  it("rejects timestamps outside the 5-minute window", () => {
    const body = "{}";
    const old = (Math.floor(Date.now() / 1000) - 600).toString();
    const sig = sign(body, old);
    expect(verifySlackSignature({ secret: SECRET, body, timestamp: old, signature: sig })).toBe(false);
  });

  it("rejects missing inputs", () => {
    expect(verifySlackSignature({ secret: SECRET, body: "x", timestamp: "", signature: "" })).toBe(false);
  });
});
