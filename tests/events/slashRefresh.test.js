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

function makeClient({ postEphemeralError = null } = {}) {
  return {
    chat: {
      postEphemeral: vi.fn().mockImplementation(async () => {
        if (postEphemeralError) throw postEphemeralError;
        return { ok: true };
      }),
    },
  };
}

function makeEnvelope(overrides = {}) {
  return {
    type: "slash_command",
    command: "/refresh-genders",
    user_id: "U1",
    channel_id: "C1",
    response_url: "https://hooks.slack.com/commands/T1/123/abc",
    ...overrides,
  };
}

describe("createSlashRefreshHandler", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;
  });

  it("invalidates the map and posts an ephemeral as 'Gender Aliases'", async () => {
    const service = makeService({ count: 42 });
    const client = makeClient();
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await handler({ envelope: makeEnvelope(), client });

    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C1",
      user: "U1",
      text: "Refreshed gender map. 42 entries loaded.",
      username: "Gender Aliases",
      icon_emoji: ":busts_in_silhouette:",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts an error text via ephemeral when invalidate throws", async () => {
    const service = makeService({ error: new Error("sheets down") });
    const client = makeClient();
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await handler({ envelope: makeEnvelope(), client });

    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toBe(
      "Refresh failed: sheets down"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to response_url when postEphemeral fails", async () => {
    const service = makeService({ count: 7 });
    const client = makeClient({
      postEphemeralError: Object.assign(new Error("err"), {
        data: { error: "channel_not_found" },
      }),
    });
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await handler({ envelope: makeEnvelope(), client });

    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/commands/T1/123/abc");
    expect(JSON.parse(init.body)).toEqual({
      response_type: "ephemeral",
      text: "Refreshed gender map. 7 entries loaded.",
    });
  });

  it("falls back to response_url when no client is provided", async () => {
    const service = makeService({ count: 3 });
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await handler({ envelope: makeEnvelope() });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      response_type: "ephemeral",
      text: "Refreshed gender map. 3 entries loaded.",
    });
  });

  it("does not throw when response_url POST fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const service = makeService();
    const handler = createSlashRefreshHandler({ genderMapService: service });
    await expect(
      handler({
        envelope: makeEnvelope({ channel_id: undefined }),
      })
    ).resolves.toBeUndefined();
  });
});
