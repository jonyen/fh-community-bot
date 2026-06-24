import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGroqService } from "../../src/services/groq.js";

describe("GroqService", () => {
  let mockClient;
  let service;

  beforeEach(() => {
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    service = createGroqService(mockClient);
  });

  describe("suggestFix", () => {
    it("returns the AI suggestion for an issue", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "Try restarting the printer." } }],
      });

      const result = await service.suggestFix("Lobby printer is jammed");
      expect(result).toBe("Try restarting the printer.");
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: expect.stringContaining("facilities/maintenance"),
          },
          {
            role: "user",
            content: "Lobby printer is jammed",
          },
        ],
        max_tokens: 256,
      });
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.suggestFix("Something broke");
      expect(result).toBeNull();
    });
  });

  describe("checkDuplicate", () => {
    it("returns matching issue ID when duplicate found", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "3" } }],
      });

      const result = await service.checkDuplicate("printer broken", [
        { id: "3", description: "Lobby printer jammed" },
        { id: "5", description: "AC broken in room 3" },
      ]);

      expect(result).toBe("3");
    });

    it("returns null when no duplicate found", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "none" } }],
      });

      const result = await service.checkDuplicate("new issue", [
        { id: "1", description: "Printer jammed" },
      ]);

      expect(result).toBeNull();
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.checkDuplicate("test", []);
      expect(result).toBeNull();
    });
  });

  describe("isMaintenanceRequest", () => {
    it("returns true for a maintenance request", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "yes" } }],
      });

      const result = await service.isMaintenanceRequest("The lobby printer is jammed");
      expect(result).toBe(true);
    });

    it("returns false for a non-maintenance message", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "no" } }],
      });

      const result = await service.isMaintenanceRequest("What's for lunch?");
      expect(result).toBe(false);
    });

    it("returns false for junk messages without calling the API", async () => {
      const junkMessages = ["test", "testing", "hello", "hi", "just a test", "ping", "asdf", "lol"];
      for (const msg of junkMessages) {
        const result = await service.isMaintenanceRequest(msg);
        expect(result, `expected false for "${msg}"`).toBe(false);
      }
      expect(mockClient.chat.completions.create).not.toHaveBeenCalled();
    });

    it("returns true when API fails (fail-open)", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.isMaintenanceRequest("something");
      expect(result).toBe(true);
    });
  });

});

describe("parseReservationRequest", () => {
  it("returns parsed JSON from the model", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"reserve","target":"FH MPR","date":"2026-06-26","startTime":"7:00 PM","endTime":"10:00 PM","what":"Practice","who":"College"}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("book the MPR friday 7-10pm for practice", "2026-06-23T12:00:00Z");
    expect(out).toMatchObject({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM" });
  });

  it("returns null on bad JSON", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    }) } } };
    const svc = createGroqService(client);
    expect(await svc.parseReservationRequest("hi", "2026-06-23T12:00:00Z")).toBeNull();
  });

  it("returns null when the API throws", async () => {
    const client = { chat: { completions: { create: vi.fn().mockRejectedValue(new Error("boom")) } } };
    const svc = createGroqService(client);
    expect(await svc.parseReservationRequest("x", "2026-06-23T12:00:00Z")).toBeNull();
  });

  it("passes through a 'none' intent for non-reservation chatter", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"none","target":null,"date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("lol that meeting was wild", "2026-06-24T12:00:00Z");
    expect(out.intent).toBe("none");
  });

  it("passes through a 'history' intent for last-used questions", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"history","target":"speaker set","date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("who used the speaker set last?", "2026-06-24T12:00:00Z");
    expect(out).toMatchObject({ intent: "history", target: "speaker set" });
  });
});
