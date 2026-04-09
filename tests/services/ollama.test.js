import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOllamaService } from "../../src/services/ollama.js";

describe("OllamaService", () => {
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
    service = createOllamaService(mockClient);
  });

  describe("suggestFix", () => {
    it("returns the AI suggestion for an issue", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "Try restarting the printer." } }],
      });

      const result = await service.suggestFix("Lobby printer is jammed");
      expect(result).toBe("Try restarting the printer.");
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith({
        model: "gemma4:27b",
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

    it("returns true when API fails (fail-open)", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.isMaintenanceRequest("something");
      expect(result).toBe(true);
    });
  });

  describe("generateDigest", () => {
    it("returns a summary of open issues", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "Weekly summary: 2 open issues..." } }],
      });

      const result = await service.generateDigest([
        { id: "1", description: "Printer jammed", status: "open" },
        { id: "2", description: "AC broken", status: "open" },
      ]);

      expect(result).toBe("Weekly summary: 2 open issues...");
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.generateDigest([]);
      expect(result).toBeNull();
    });
  });
});
