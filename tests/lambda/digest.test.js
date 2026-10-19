// tests/lambda/digest.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getDeps = vi.fn();
vi.mock("../../src/lambda/clients.js", () => ({ getDeps: (...a) => getDeps(...a) }));

const { handler } = await import("../../src/lambda/digest.js");

describe("digest handler", () => {
  let livingDigest;
  beforeEach(() => {
    livingDigest = { post: vi.fn().mockResolvedValue({ failures: [] }) };
    getDeps.mockReturnValue({ livingDigest });
  });

  it("posts the weekday digest for the weekday period", async () => {
    await handler({ period: "weekday" });
    expect(livingDigest.post).toHaveBeenCalledWith("weekday");
  });

  it("posts the weekend digest for the weekend period", async () => {
    await handler({ period: "weekend" });
    expect(livingDigest.post).toHaveBeenCalledWith("weekend");
  });

  it("defaults to weekday with no or unknown period", async () => {
    await handler();
    await handler({ period: "bogus" });
    expect(livingDigest.post).toHaveBeenNthCalledWith(1, "weekday");
    expect(livingDigest.post).toHaveBeenNthCalledWith(2, "weekday");
  });

  it("does nothing when reservations are off", async () => {
    getDeps.mockReturnValue({ livingDigest: null });
    await expect(handler({ period: "weekday" })).resolves.toBeUndefined();
    expect(livingDigest.post).not.toHaveBeenCalled();
  });
});
