import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(function () {
    this.send = sendMock;
  }),
  SendMessageCommand: vi.fn().mockImplementation(function (input) {
    this.input = input;
  }),
}));

const SECRET = "test-signing-secret";

function buildEvent({ body, timestamp, signature }) {
  return {
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
  };
}

function sign(body, timestamp) {
  const base = `v0:${timestamp}:${body}`;
  return "v0=" + crypto.createHmac("sha256", SECRET).update(base).digest("hex");
}

describe("receiver.handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.EVENT_QUEUE_URL = "https://sqs.example/q";
  });

  it("returns 401 on a bad signature", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body: "{}", timestamp: ts, signature: "v0=bad" }));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("responds to url_verification challenge without enqueuing", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc123");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enqueues event_callback bodies to SQS and acks 200", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hi" } });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.input.QueueUrl).toBe("https://sqs.example/q");
    expect(call.input.MessageBody).toBe(body);
  });

  it("handles base64-encoded bodies from Function URL", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const raw = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
    const body = Buffer.from(raw).toString("base64");
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler({
      body,
      isBase64Encoded: true,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(raw, ts),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input.MessageBody).toBe(raw);
  });

  function eventCallback(eventObj) {
    return JSON.stringify({ type: "event_callback", event: eventObj });
  }

  it("enqueues a !bros plain message", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", text: "!bros let's go", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues a thread reply with no mention", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues a top-level message with a Slack mention", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("drops ordinary top-level chatter (no trigger, no mention, no thread)", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "message", channel: "C1", text: "good morning everyone", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("always enqueues app_mention events regardless of text", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = eventCallback({ type: "app_mention", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
