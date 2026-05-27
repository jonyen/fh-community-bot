import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchMock = vi.fn().mockResolvedValue();
const handlerMock = vi.fn().mockResolvedValue();
const genderHandlerMock = vi.fn().mockResolvedValue();
const slashRefreshHandlerMock = vi.fn().mockResolvedValue();
const fakeClient = { id: "slack" };

vi.mock("../../src/lambda/dispatch.js", () => ({
  dispatchSlackEvent: dispatchMock,
}));

vi.mock("../../src/lambda/clients.js", () => ({
  getDeps: () => ({
    client: fakeClient,
    handler: handlerMock,
    genderHandler: genderHandlerMock,
    slashRefreshHandler: slashRefreshHandlerMock,
  }),
}));

describe("worker.handler", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    handlerMock.mockClear();
    genderHandlerMock.mockClear();
    slashRefreshHandlerMock.mockClear();
  });

  it("calls dispatchSlackEvent for each SQS record and passes all handlers", async () => {
    const { handler } = await import("../../src/lambda/worker.js");

    const body1 = JSON.stringify({ event: { type: "app_mention", channel: "C1", ts: "1" } });
    const body2 = JSON.stringify({ event: { type: "message", channel: "C1", text: "!bros", user: "U1", ts: "1" } });
    const body3 = JSON.stringify({ type: "slash_command", command: "/refresh-genders" });

    await handler({ Records: [{ body: body1 }, { body: body2 }, { body: body3 }] });

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    expect(dispatchMock.mock.calls[0][0].slackEnvelope.event.type).toBe("app_mention");
    expect(dispatchMock.mock.calls[1][0].slackEnvelope.event.type).toBe("message");
    expect(dispatchMock.mock.calls[2][0].slackEnvelope.type).toBe("slash_command");
    expect(dispatchMock.mock.calls[0][0].handler).toBe(handlerMock);
    expect(dispatchMock.mock.calls[0][0].genderHandler).toBe(genderHandlerMock);
    expect(dispatchMock.mock.calls[0][0].slashRefreshHandler).toBe(slashRefreshHandlerMock);
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
