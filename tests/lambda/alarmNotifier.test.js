import { describe, it, expect, beforeEach, vi } from "vitest";
import { handler } from "../../src/lambda/alarmNotifier.js";

function snsEvent(...alarms) {
  return { Records: alarms.map((a) => ({ Sns: { Message: typeof a === "string" ? a : JSON.stringify(a) } })) };
}

const ALARM = {
  AlarmName: "fh-community-dlq-not-empty",
  AlarmDescription: "Messages have landed in the dead letter queue",
  NewStateValue: "ALARM",
  NewStateReason: "Threshold Crossed: 1 datapoint [3.0] was greater than 0.0",
  Trigger: { MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS" },
};

describe("alarm notifier", () => {
  let client;

  beforeEach(() => {
    process.env.ALARM_CHANNEL = "C_ALARMS";
    client = { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
  });

  it("posts the alarm to the alarm channel", async () => {
    await handler(snsEvent(ALARM), null, { client });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C_ALARMS");
    expect(arg.text).toContain("fh-community-dlq-not-empty");
    expect(arg.text).toContain("dead letter queue");
  });

  it("distinguishes firing from resolved", async () => {
    await handler(snsEvent(ALARM), null, { client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("🔴");

    client.chat.postMessage.mockClear();
    await handler(snsEvent({ ...ALARM, NewStateValue: "OK" }), null, { client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("✅");
  });

  it("includes the reason so the channel shows why", async () => {
    await handler(snsEvent(ALARM), null, { client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("was greater than 0.0");
  });

  it("handles several records in one delivery", async () => {
    await handler(snsEvent(ALARM, { ...ALARM, AlarmName: "second" }), null, { client });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("falls back to raw text when the payload is not alarm JSON", async () => {
    await handler(snsEvent("plain string alert"), null, { client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("plain string alert");
  });

  it("never throws when Slack is the thing that is down", async () => {
    client.chat.postMessage.mockRejectedValue(new Error("slack unreachable"));
    await expect(handler(snsEvent(ALARM), null, { client })).resolves.not.toThrow();
  });

  it("one failed record does not suppress the rest", async () => {
    client.chat.postMessage
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ ok: true });
    await handler(snsEvent(ALARM, { ...ALARM, AlarmName: "second" }), null, { client });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });
});
