import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn().mockResolvedValue(["ok"]);
const createPostMessageRunner = vi.fn(() => runMock);

vi.mock("../../src/events/post.js", () => ({ createPostMessageRunner }));
vi.mock("@slack/web-api", () => ({ WebClient: vi.fn(function () { this.tag = "client"; }) }));

describe("postMessage lambda handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_BOT_USER_ID = "UBOT";
    process.env.BBALL_CHANNEL_IDS = "C1,C2";
  });

  it("builds a runner from env and invokes it", async () => {
    const { handler, _resetForTests } = await import("../../src/lambda/postMessage.js");
    _resetForTests();
    await handler();
    expect(createPostMessageRunner).toHaveBeenCalledTimes(1);
    const args = createPostMessageRunner.mock.calls[0][0];
    expect(args.channels).toEqual(["C1", "C2"]);
    expect(args.botUserId).toBe("UBOT");
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
