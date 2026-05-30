import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPendingStore } from "../../src/services/pendingStore.js";

// Minimal fake DocumentClient that records the commands it receives. The AWS
// SDK command objects expose their payload on `.input`, and carry a
// constructor name we can switch on.
function makeDocClient(store = new Map()) {
  const send = vi.fn(async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "GetCommand") {
      return { Item: store.get(input.Key.pk) };
    }
    if (name === "PutCommand") {
      store.set(input.Item.pk, input.Item);
      return {};
    }
    if (name === "DeleteCommand") {
      store.delete(input.Key.pk);
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  });
  return { send, _store: store };
}

describe("createPendingStore", () => {
  let docClient;
  let store;

  beforeEach(() => {
    docClient = makeDocClient();
    store = createPendingStore({ docClient, tableName: "Pending" });
  });

  it("returns undefined for a missing key", async () => {
    expect(await store.get("C1:1")).toBeUndefined();
  });

  it("round-trips a value through set/get", async () => {
    await store.set("C1:1", { user: "U1", issueDescription: "printer jammed" });
    expect(await store.get("C1:1")).toEqual({
      user: "U1",
      issueDescription: "printer jammed",
    });
  });

  it("writes a numeric ttl in the future", async () => {
    const before = Math.floor(Date.now() / 1000);
    await store.set("C1:1", { user: "U1" }, );
    const item = docClient._store.get("C1:1");
    expect(typeof item.ttl).toBe("number");
    expect(item.ttl).toBeGreaterThanOrEqual(before + 23 * 3600);
  });

  it("honors a custom ttlSeconds", async () => {
    const custom = createPendingStore({ docClient, tableName: "Pending", ttlSeconds: 60 });
    const before = Math.floor(Date.now() / 1000);
    await custom.set("C1:2", { user: "U1" });
    const item = docClient._store.get("C1:2");
    expect(item.ttl).toBeLessThanOrEqual(before + 61);
  });

  it("deletes a value", async () => {
    await store.set("C1:1", { user: "U1" });
    await store.delete("C1:1");
    expect(await store.get("C1:1")).toBeUndefined();
  });

  it("targets the configured table name", async () => {
    await store.get("C1:1");
    expect(docClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ TableName: "Pending" }) })
    );
  });
});
