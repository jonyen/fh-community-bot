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
    delete process.env.RESERVATIONS_CHANNEL_ID;
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

  it("enqueues a slash command envelope from a form-encoded payload", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body =
      "token=secret&team_id=T1&channel_id=C1&user_id=U1&command=%2Frefresh-genders" +
      "&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1%2F123%2Fabc";
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler({
      body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(body, ts),
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const enqueued = JSON.parse(sendMock.mock.calls[0][0].input.MessageBody);
    expect(enqueued).toEqual({
      type: "slash_command",
      command: "/refresh-genders",
      user_id: "U1",
      channel_id: "C1",
      team_id: "T1",
      response_url: "https://hooks.slack.com/commands/T1/123/abc",
      text: "",
    });
  });

  it("400s a form-encoded payload missing command/response_url", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = "token=secret&user_id=U1";
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler({
      body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(body, ts),
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enqueues a non-bot message in the reservations channel", async () => {
    process.env.RESERVATIONS_CHANNEL_ID = "Cres";
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    const parsed = { event: { type: "message", channel: "Cres", user: "U1", ts: "1.1", text: "book the MPR" } };
    expect(shouldEnqueueEvent(parsed)).toBe(true);
  });

  it("does not enqueue a bot message in the reservations channel", async () => {
    process.env.RESERVATIONS_CHANNEL_ID = "Cres";
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    const parsed = { event: { type: "message", channel: "Cres", bot_id: "B1", ts: "1.1", text: "x" } };
    expect(shouldEnqueueEvent(parsed)).toBe(false);
  });

  it("enqueues every human message in the ONESTOP_CHANNEL_ID channel", async () => {
    process.env.ONESTOP_CHANNEL_ID = "Cnew";
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "Cnew", text: "what's the door code?" } })).toBe(true);
    delete process.env.ONESTOP_CHANNEL_ID;
  });
});
