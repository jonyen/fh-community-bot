import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlashRefreshHandler } from "../../src/events/slashRefresh.js";

function makeService({ count = 5, error = null } = {}) {
  return {
    invalidate: vi.fn().mockImplementation(async () => {
      if (error) throw error;
      return count;
    }),
  };
}

describe("createSlashRefreshHandler", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;
  });

  it("invalidates the map and POSTs success text to response_url as ephemeral", async () => {
    const service = makeService({ count: 42 });
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await handler({
      envelope: {
        type: "slash_command",
        command: "/refresh-genders",
        user_id: "U1",
        response_url: "https://hooks.slack.com/commands/T1/123/abc",
      },
    });
    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/commands/T1/123/abc");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      response_type: "ephemeral",
      text: "Refreshed gender map. 42 entries loaded.",
    });
  });

  it("POSTs an error text when invalidate throws", async () => {
    const service = makeService({ error: new Error("sheets down") });
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await handler({
      envelope: { response_url: "https://hooks.slack.com/commands/T/1/x" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      response_type: "ephemeral",
      text: "Refresh failed: sheets down",
    });
  });

  it("does not throw when response_url POST fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const service = makeService();
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await expect(
      handler({ envelope: { response_url: "https://hooks.slack.com/commands/T/1/x" } })
    ).resolves.toBeUndefined();
  });
});
