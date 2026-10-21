// tests/services/livingDigest.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLivingDigest } from "../../src/services/livingDigest.js";

const RES = { category: "rooms", item: "MPR", date: "2026-10-20", start: 1140, end: 1320, title: "Equipping", holder: "John", holderUserId: null, holderEmail: null };
const WEEKEND_RES = { ...RES, date: "2026-10-24", item: "Sanctuary" };

const makeAdapter = (backend, result) => ({
  backend,
  listReservations: vi.fn().mockImplementation(async () => (result instanceof Error ? Promise.reject(result) : result)),
});
const digestMsg = (ts, from, to) => ({ ts, bot_id: "B1", metadata: { event_type: "reservation_digest", event_payload: { from, to } } });

describe("createLivingDigest", () => {
  let client;
  beforeEach(() => {
    client = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: "500.1" }), update: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: { history: vi.fn() },
    };
  });
  const now = new Date("2026-10-19T12:00:00Z");

  it("post(weekday) posts one digest message carrying the digest metadata", async () => {
    const adapters = { rooms: makeAdapter("rooms", { reservations: [RES], errors: [] }) };
    const out = await createLivingDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS" }).post("weekday", now);
    expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-19", to: "2026-10-22" });
    expect(out).toEqual({ failures: [] });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const p = client.chat.postMessage.mock.calls[0][0];
    expect(p).toMatchObject({
      channel: "CRES",
      username: "Reservations",
      metadata: { event_type: "reservation_digest", event_payload: { from: "2026-10-19", to: "2026-10-22" } },
    });
    expect(p.text).toContain("• 7:00–10:00 PM · MPR · Equipping (John)");
  });

  it("names an unreadable source in the post and DMs the operator", async () => {
    const adapters = {
      rooms: makeAdapter("rooms", new Error("The caller does not have permission")),
      rms: makeAdapter("rms", { reservations: [], errors: ["Kiddie Pool: 404"] }),
    };
    const out = await createLivingDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS" }).post("weekday", now);
    expect(out.failures).toEqual(["Rooms: The caller does not have permission", "Equipment calendars: Kiddie Pool: 404"]);
    const calls = client.chat.postMessage.mock.calls.map((c) => c[0]);
    expect(calls[0].channel).toBe("CRES");
    expect(calls[0].text).toContain("⚠️ Couldn't read: Rooms, Equipment calendars");
    expect(calls[1]).toMatchObject({ channel: "UOPS" });
    expect(calls[1].text).toContain("• Rooms: The caller does not have permission");
  });

  it("refresh rebuilds the digest covering the date in place", async () => {
    client.conversations.history.mockResolvedValue({
      messages: [digestMsg("200.1", "2026-10-23", "2026-10-25"), digestMsg("100.1", "2026-10-19", "2026-10-22")],
    });
    const adapters = { rooms: makeAdapter("rooms", { reservations: [WEEKEND_RES], errors: [] }) };
    const ok = await createLivingDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS" }).refresh("2026-10-24");
    expect(ok).toBe(true);
    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "CRES", limit: 200, include_all_metadata: true, oldest: String(Date.parse("2026-10-16T00:00:00-04:00") / 1000),
    });
    expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-23", to: "2026-10-25" });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const u = client.chat.update.mock.calls[0][0];
    expect(u).toMatchObject({ channel: "CRES", ts: "200.1", metadata: { event_type: "reservation_digest", event_payload: { from: "2026-10-23", to: "2026-10-25" } } });
    expect(u.text).toContain("This weekend");
    expect(u.text).toContain("Sanctuary");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("refresh with no covering digest does nothing", async () => {
    client.conversations.history.mockResolvedValue({ messages: [digestMsg("100.1", "2026-10-12", "2026-10-15")] });
    const adapters = { rooms: makeAdapter("rooms", { reservations: [], errors: [] }) };
    const ok = await createLivingDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS" }).refresh("2026-10-24");
    expect(ok).toBe(false);
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("refresh pages back through history to find an older digest", async () => {
    client.conversations.history
      .mockResolvedValueOnce({ messages: [{ ts: "1792400000.1" }], response_metadata: { next_cursor: "c2" } })
      .mockResolvedValueOnce({ messages: [digestMsg("1792300000.1", "2026-10-23", "2026-10-25")], response_metadata: { next_cursor: "" } });
    const adapters = { rooms: makeAdapter("rooms", { reservations: [WEEKEND_RES], errors: [] }) };
    const ok = await createLivingDigest({ client, adapters, channelId: "CRES" }).refresh("2026-10-24");
    expect(ok).toBe(true);
    expect(client.conversations.history).toHaveBeenNthCalledWith(2, expect.objectContaining({ channel: "CRES", cursor: "c2", limit: 200, include_all_metadata: true }));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "1792300000.1" }));
  });

  it("refresh stops after 5 pages", async () => {
    client.conversations.history.mockResolvedValue({ messages: [{ ts: "1792400000.1" }], response_metadata: { next_cursor: "more" } });
    const ok = await createLivingDigest({ client, adapters: {}, channelId: "CRES" }).refresh("2026-10-24");
    expect(ok).toBe(false);
    expect(client.conversations.history).toHaveBeenCalledTimes(5);
  });

  it("refresh stops once messages are older than a week before the period", async () => {
    client.conversations.history.mockResolvedValue({ messages: [{ ts: "1.0" }], response_metadata: { next_cursor: "more" } });
    const ok = await createLivingDigest({ client, adapters: {}, channelId: "CRES" }).refresh("2026-10-24");
    expect(ok).toBe(false);
    expect(client.conversations.history).toHaveBeenCalledTimes(1);
  });
});
