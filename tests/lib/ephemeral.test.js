import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendEphemeral } from "../../src/lib/ephemeral.js";

function makeClient({ error = null } = {}) {
  return {
    chat: {
      postEphemeral: vi.fn().mockImplementation(async () => {
        if (error) throw error;
        return { ok: true };
      }),
    },
  };
}

describe("sendEphemeral", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;
  });

  it("prefers postEphemeral when client + channel + user are present", async () => {
    const client = makeClient();
    await sendEphemeral({ client, channel: "C1", user: "U1", responseUrl: "https://h/x", text: "hi" });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({ channel: "C1", user: "U1", text: "hi" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to response_url when postEphemeral throws", async () => {
    const client = makeClient({ error: Object.assign(new Error("e"), { data: { error: "channel_not_found" } }) });
    await sendEphemeral({ client, channel: "C1", user: "U1", responseUrl: "https://h/x", text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ response_type: "ephemeral", text: "hi" });
  });

  it("uses response_url directly when no client is given", async () => {
    await sendEphemeral({ responseUrl: "https://h/x", text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when response_url POST fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(sendEphemeral({ responseUrl: "https://h/x", text: "hi" })).resolves.toBeUndefined();
  });
});
