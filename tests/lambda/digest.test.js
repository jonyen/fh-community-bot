// tests/lambda/digest.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDigest } from "../../src/lambda/digest.js";

const RES = { category: "rooms", item: "MPR", date: "2026-10-13", start: 1140, end: 1320, title: "Equipping", holder: "John", holderUserId: null, holderEmail: null };

function makeAdapter(backend, result) {
  return { backend, listReservations: vi.fn().mockImplementation(async () => (result instanceof Error ? Promise.reject(result) : result)) };
}

describe("runDigest", () => {
  let client;
  beforeEach(() => {
    client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: "500.1" }) } };
  });
  const now = () => new Date("2026-10-12T12:00:00Z");

  it("reads the Monday–Sunday week from every adapter and posts one message", async () => {
    const adapters = { rooms: makeAdapter("rooms", { reservations: [RES], errors: [] }), kitchen: makeAdapter("kitchen", { reservations: [], errors: [] }) };
    const out = await runDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS", now });
    expect(adapters.rooms.listReservations).toHaveBeenCalledWith({ from: "2026-10-12", to: "2026-10-18" });
    expect(out).toEqual({ posted: 1, failures: [] });
    const p = client.chat.postMessage.mock.calls[0][0];
    expect(p).toMatchObject({ channel: "CRES", username: "FH Reservations", metadata: { event_type: "reservation_closed", event_payload: {} } });
    expect(p.text).toContain("• 7:00–10:00 PM · MPR · Equipping (John)");
  });

  it("still posts when a source fails, and DMs the operator", async () => {
    const adapters = {
      rooms: makeAdapter("rooms", { reservations: [RES], errors: [] }),
      kitchen: makeAdapter("kitchen", new Error("The caller does not have permission")),
      rms: makeAdapter("rms", { reservations: [], errors: ["Kiddie Pool: 404"] }),
    };
    const out = await runDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS", now });
    expect(out.failures).toEqual(["Kitchen: The caller does not have permission", "Equipment calendars: Kiddie Pool: 404"]);
    const calls = client.chat.postMessage.mock.calls.map((c) => c[0]);
    expect(calls[0].channel).toBe("CRES");
    expect(calls[0].text).toContain("⚠️ Couldn't read: Kitchen, Equipment calendars");
    expect(calls[1]).toMatchObject({ channel: "UOPS" });
    expect(calls[1].text).toBe("The weekly reservations digest couldn't read some sources:\n• Kitchen: The caller does not have permission\n• Equipment calendars: Kiddie Pool: 404");
  });

  it("posts extra parts as thread replies", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...RES, date: i < 100 ? "2026-10-13" : "2026-10-14", title: `Event number ${i}` }));
    const adapters = { rooms: makeAdapter("rooms", { reservations: many, errors: [] }) };
    const out = await runDigest({ client, adapters, channelId: "CRES", escalationUserId: "UOPS", now });
    expect(out.posted).toBeGreaterThan(1);
    expect(client.chat.postMessage.mock.calls[1][0].thread_ts).toBe("500.1");
  });
});
