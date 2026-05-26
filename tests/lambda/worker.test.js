import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchMock = vi.fn().mockResolvedValue();
const handlerMock = vi.fn().mockResolvedValue();
const genderHandlerMock = vi.fn().mockResolvedValue();
const fakeClient = { id: "slack" };

vi.mock("../../src/lambda/dispatch.js", () => ({
  dispatchSlackEvent: dispatchMock,
}));

vi.mock("../../src/lambda/clients.js", () => ({
  getDeps: () => ({ client: fakeClient, handler: handlerMock, genderHandler: genderHandlerMock }),
}));

describe("worker.handler", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    handlerMock.mockClear();
    genderHandlerMock.mockClear();
  });

  it("calls dispatchSlackEvent for each SQS record and passes both handlers", async () => {
    const { handler } = await import("../../src/lambda/worker.js");

    const body1 = JSON.stringify({ event: { type: "app_mention", channel: "C1", ts: "1" } });
    const body2 = JSON.stringify({ event: { type: "message", channel: "C1", text: "!bros", user: "U1", ts: "1" } });

    await handler({ Records: [{ body: body1 }, { body: body2 }] });

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[0][0].slackEnvelope.event.type).toBe("app_mention");
    expect(dispatchMock.mock.calls[1][0].slackEnvelope.event.type).toBe("message");
    expect(dispatchMock.mock.calls[0][0].handler).toBe(handlerMock);
    expect(dispatchMock.mock.calls[0][0].genderHandler).toBe(genderHandlerMock);
    expect(dispatchMock.mock.calls[0][0].client).toBe(fakeClient);
  });

  it("propagates errors so SQS can retry", async () => {
    const { handler } = await import("../../src/lambda/worker.js");
    dispatchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      handler({ Records: [{ body: JSON.stringify({ event: { type: "app_mention" } }) }] })
    ).rejects.toThrow("boom");
  });
});
