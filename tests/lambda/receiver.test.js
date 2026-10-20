import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("groups an event by the Slack user who sent it, so one member's messages run in order", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", user: "U7", channel: "C7", text: "Saturday", thread_ts: "1.0", ts: "1.1" } });
    const ts = Math.floor(Date.now() / 1000).toString();
    await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(sendMock.mock.calls[0][0].input.MessageGroupId).toBe("U7");
  });

  it("groups an event with no user by its channel", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: "C5", text: "hi" } });
    const ts = Math.floor(Date.now() / 1000).toString();
    await handler(buildEvent({ body, timestamp: ts, signature: sign(body, ts) }));
    expect(sendMock.mock.calls[0][0].input.MessageGroupId).toBe("C5");
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
      "&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1%2F123%2Fabc&trigger_id=TR1";
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
    expect(sendMock.mock.calls[0][0].input.MessageGroupId).toBe("U1");
    expect(enqueued).toEqual({
      type: "slash_command",
      command: "/refresh-genders",
      user_id: "U1",
      channel_id: "C1",
      team_id: "T1",
      response_url: "https://hooks.slack.com/commands/T1/123/abc",
      text: "",
      trigger_id: "TR1",
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

  it("enqueues a block_actions envelope from an interactivity payload", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const interactivity = {
      type: "block_actions",
      user: { id: "U1" },
      actions: [{ action_id: "submit_maintenance_form" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(interactivity))}`;
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
    const sent = JSON.parse(sendMock.mock.calls[0][0].input.MessageBody);
    expect(sent.type).toBe("block_actions");
    expect(sendMock.mock.calls[0][0].input.MessageGroupId).toBe("U1");
    expect(sent.payload.actions[0].action_id).toBe("submit_maintenance_form");
  });

  it("acks and drops interactivity payloads nothing handles", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = `payload=${encodeURIComponent(JSON.stringify({ type: "view_closed" }))}`;
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
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enqueues a view_submission, grouped by user", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const submission = { type: "view_submission", user: { id: "U1" }, view: { callback_id: "other_modal" } };
    const body = `payload=${encodeURIComponent(JSON.stringify(submission))}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler({
      body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(body, ts),
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    expect(res).toEqual({ statusCode: 200, body: "" });
    expect(JSON.parse(sendMock.mock.calls[0][0].input.MessageBody)).toEqual({ type: "view_submission", payload: submission });
    expect(sendMock.mock.calls[0][0].input.MessageGroupId).toBe("U1");
  });

  it("400s a malformed interactivity payload", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = `payload=${encodeURIComponent("{not json")}`;
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

  it("no longer enqueues every message in the old OneStop channel", async () => {
    process.env.ONESTOP_CHANNEL_ID = "Cnew";
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "Cnew", user: "U1", ts: "1.1", text: "what's the door code?" } })).toBe(false);
    delete process.env.ONESTOP_CHANNEL_ID;
  });
});

describe("Slack retry handling", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.EVENT_QUEUE_URL = "https://sqs.example/q";
  });

  function retryEvent(body, retryHeaders) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const event = buildEvent({ body, timestamp: ts, signature: sign(body, ts) });
    Object.assign(event.headers, retryHeaders);
    return event;
  }

  const mentionBody = JSON.stringify({
    type: "event_callback",
    event: { type: "app_mention", channel: "C1", user: "U1", ts: "1.1", text: "<@U_BOT> sink leaking" },
  });

  const submitBody = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      actions: [{ action_id: "submit_maintenance_form" }],
    }),
  }).toString();

  it("acks a timed-out retry without enqueuing it again", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const res = await handler(
      retryEvent(mentionBody, {
        "x-slack-retry-num": "1",
        "x-slack-retry-reason": "http_timeout",
      })
    );
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("drops the retry of a form submission too", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const event = retryEvent(submitBody, {
      "x-slack-retry-num": "2",
      "x-slack-retry-reason": "http_timeout",
    });
    event.headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still enqueues a retry we never successfully handled", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    for (const reason of ["http_error", "connection_failed"]) {
      sendMock.mockClear();
      await handler(
        retryEvent(mentionBody, {
          "x-slack-retry-num": "1",
          "x-slack-retry-reason": reason,
        })
      );
      expect(sendMock, reason).toHaveBeenCalledTimes(1);
    }
  });

  it("enqueues a first delivery, retry headers absent", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    await handler(retryEvent(mentionBody, {}));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("checks the signature before honouring retry headers", async () => {
    const { handler } = await import("../../src/lambda/receiver.js");
    const ts = Math.floor(Date.now() / 1000).toString();
    const event = buildEvent({ body: mentionBody, timestamp: ts, signature: "v0=bad" });
    event.headers["x-slack-retry-num"] = "1";
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });
});

describe("isDuplicateSlackRetry", () => {
  it("is false without a retry header", async () => {
    const { isDuplicateSlackRetry } = await import("../../src/lambda/receiver.js");
    expect(isDuplicateSlackRetry({})).toBe(false);
    expect(isDuplicateSlackRetry(undefined)).toBe(false);
  });

  it("matches the header case-insensitively", async () => {
    const { isDuplicateSlackRetry } = await import("../../src/lambda/receiver.js");
    expect(
      isDuplicateSlackRetry({ "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" })
    ).toBe(true);
  });

  it("treats a retry with no stated reason as a duplicate", async () => {
    const { isDuplicateSlackRetry } = await import("../../src/lambda/receiver.js");
    expect(isDuplicateSlackRetry({ "x-slack-retry-num": "1" })).toBe(true);
  });
});

describe("shouldEnqueueEvent — reactions", () => {
  it("enqueues only ticket-emoji reactions", async () => {
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    expect(shouldEnqueueEvent({ event: { type: "reaction_added", reaction: "ticket" } })).toBe(true);
    expect(shouldEnqueueEvent({ event: { type: "reaction_added", reaction: "admission_tickets" } })).toBe(true);
    expect(shouldEnqueueEvent({ event: { type: "reaction_added", reaction: "thumbsup" } })).toBe(false);
  });
});

describe("shouldEnqueueEvent for #reservations", () => {
  beforeEach(() => {
    process.env.RESERVATIONS_CHANNEL_ID = "CRES";
  });
  afterEach(() => {
    delete process.env.RESERVATIONS_CHANNEL_ID;
  });

  it("enqueues every top-level human message there", async () => {
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    expect(shouldEnqueueEvent({ event: { type: "message", channel: "CRES", user: "U1", text: "book the MPR", ts: "1.1" } })).toBe(true);
    expect(shouldEnqueueEvent({ event: { type: "message", subtype: "file_share", channel: "CRES", user: "U1", text: "book this", ts: "1.1" } })).toBe(true);
  });

  it("drops thread replies, bot posts and edits there", async () => {
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    const base = { type: "message", channel: "CRES", user: "U1", text: "Saturday", ts: "1.2" };
    expect(shouldEnqueueEvent({ event: { ...base, thread_ts: "1.1" } })).toBe(false);
    expect(shouldEnqueueEvent({ event: { ...base, bot_id: "B1" } })).toBe(false);
    expect(shouldEnqueueEvent({ event: { ...base, subtype: "message_changed" } })).toBe(false);
  });
});

describe("shouldEnqueueEvent — DMs", () => {
  it("drops DMs: reservations no longer talk in DMs", async () => {
    const { shouldEnqueueEvent } = await import("../../src/lambda/receiver.js");
    expect(shouldEnqueueEvent({ event: { type: "message", channel_type: "im", text: "Saturday" } })).toBe(false);
    expect(shouldEnqueueEvent({ event: { type: "message", channel_type: "im", text: "Saturday", thread_ts: "1.1" } })).toBe(false);
  });
});

describe("reservation card interactions in the receiver", () => {
  const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
  const REQ = { intent: "book", items: [SET2], ambiguous: [], unmatched: [], date: "2026-10-17", toDate: null, start: 840, end: 960, title: "Youth night", ministry: null, appliances: {} };
  let fetchSpy;

  beforeEach(async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.EVENT_QUEUE_URL = "https://sqs.example/q";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.RESERVATIONS_CHANNEL_ID = "CRES";
    process.env.RESOURCE_CALENDARS = JSON.stringify({ "DMV Tech Equipment-G-Tech Set 2": "t2" });
    const { _resetReceiverCatalogForTests } = await import("../../src/lambda/receiver.js");
    _resetReceiverCatalogForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.RESERVATIONS_CHANNEL_ID;
    delete process.env.RESOURCE_CALENDARS;
  });

  async function post(payload) {
    const { handler } = await import("../../src/lambda/receiver.js");
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    return handler({ body, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sign(body, ts), "content-type": "application/x-www-form-urlencoded" } });
  }

  it("opens the Edit modal itself for the requester and enqueues nothing", async () => {
    const { cardMessage } = await import("../../src/lib/reservation-card.js");
    const card = cardMessage({ user: "U9", req: REQ, assessment: { state: "free" } });
    const edit = card.blocks[1].elements[1];
    const res = await post({ type: "block_actions", trigger_id: "TRIG", user: { id: "U9" }, channel: { id: "CRES" }, container: { message_ts: "200.2" }, message: { ts: "200.2", thread_ts: "200.1" }, actions: [edit] });
    expect(res).toEqual({ statusCode: 200, body: "" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith("https://slack.com/api/views.open", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ Authorization: "Bearer xoxb-test" }),
    }));
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sent.trigger_id).toBe("TRIG");
    expect(sent.view.callback_id).toBe("reservation_edit_modal");
  });

  it("tells the member privately when the form can't open", async () => {
    fetchSpy.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: false, error: "expired_trigger_id" }) });
    const { cardMessage } = await import("../../src/lib/reservation-card.js");
    const edit = cardMessage({ user: "U9", req: REQ, assessment: { state: "free" } }).blocks[1].elements[1];
    await post({ type: "block_actions", trigger_id: "TRIG", response_url: "https://hooks.slack/a", user: { id: "U9" }, channel: { id: "CRES" }, container: { message_ts: "200.2" }, message: { ts: "200.2" }, actions: [edit] });
    expect(fetchSpy.mock.calls[1][0]).toBe("https://hooks.slack/a");
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ response_type: "ephemeral", replace_original: false, text: "I couldn't open the edit form. Please press Edit again." });
  });

  it("answers the item typeahead", async () => {
    const res = await post({ type: "block_suggestion", action_id: "reservation_items", value: "set" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ options: [{ text: { type: "plain_text", text: "Tech Set 2" }, value: "Tech Set 2" }] });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enqueues a Book press", async () => {
    const { cardMessage } = await import("../../src/lib/reservation-card.js");
    const book = cardMessage({ user: "U9", req: REQ, assessment: { state: "free" } }).blocks[1].elements[0];
    await post({ type: "block_actions", user: { id: "U9" }, actions: [book] });
    expect(JSON.parse(sendMock.mock.calls[0][0].input.MessageBody).type).toBe("block_actions");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
