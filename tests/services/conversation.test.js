import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConversationService } from "../../src/services/conversation.js";

describe("ConversationService", () => {
  let docClient;
  let service;
  const tableName = "test-conversations";

  beforeEach(() => {
    docClient = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    service = createConversationService(docClient, tableName);
  });

  describe("getConversation", () => {
    it("returns Item when the conversation exists", async () => {
      const item = { pk: "SLACK#abc123", severity: "high" };
      docClient.get.mockResolvedValue({ Item: item });

      const result = await service.getConversation("SLACK#abc123");

      expect(result).toEqual(item);
      expect(docClient.get).toHaveBeenCalledWith({
        TableName: tableName,
        Key: { pk: "SLACK#abc123" },
      });
    });

    it("returns null when the conversation does not exist", async () => {
      docClient.get.mockResolvedValue({});

      const result = await service.getConversation("SLACK#missing");

      expect(result).toBeNull();
    });
  });

  describe("saveConversation", () => {
    it("calls put with correct Item including TTL and updatedAt", async () => {
      const fixedTimestamp = 1700000000000;
      const expectedTtl = Math.floor(fixedTimestamp / 1000) + 86400;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fixedTimestamp);
      const isoSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2023-11-14T22:13:20.000Z");

      docClient.put.mockResolvedValue({});

      await service.saveConversation("SMS#+15551234567", { severity: "low", issueId: "42" });

      expect(docClient.put).toHaveBeenCalledWith({
        TableName: tableName,
        Item: {
          pk: "SMS#+15551234567",
          severity: "low",
          issueId: "42",
          ttl: expectedTtl,
          updatedAt: "2023-11-14T22:13:20.000Z",
        },
      });

      dateSpy.mockRestore();
      isoSpy.mockRestore();
    });
  });

  describe("deleteConversation", () => {
    it("calls delete with correct key", async () => {
      docClient.delete.mockResolvedValue({});

      await service.deleteConversation("SLACK#threadTs");

      expect(docClient.delete).toHaveBeenCalledWith({
        TableName: tableName,
        Key: { pk: "SLACK#threadTs" },
      });
    });
  });
});
