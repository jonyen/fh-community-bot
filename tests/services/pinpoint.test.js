import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinpointService } from "../../src/services/pinpoint.js";

describe("PinpointService", () => {
  let mockClient;
  let service;

  beforeEach(() => {
    mockClient = {
      sendMessages: vi.fn(),
    };
    service = createPinpointService(mockClient, "test-app-id", "+12125551234");
  });

  describe("sendSms", () => {
    it("sends SMS with correct params", async () => {
      mockClient.sendMessages.mockResolvedValue({
        MessageResponse: { Result: {} },
      });

      await service.sendSms("+19876543210", "Test message");

      expect(mockClient.sendMessages).toHaveBeenCalledWith({
        ApplicationId: "test-app-id",
        MessageRequest: {
          Addresses: {
            "+19876543210": { ChannelType: "SMS" },
          },
          MessageConfiguration: {
            SMSMessage: {
              Body: "Test message",
              MessageType: "TRANSACTIONAL",
              OriginationNumber: "+12125551234",
            },
          },
        },
      });
    });

    it("logs error but does not throw on send failure", async () => {
      const testError = new Error("Network error");
      mockClient.sendMessages.mockRejectedValue(testError);
      const consoleErrorSpy = vi.spyOn(console, "error");

      await expect(
        service.sendSms("+19876543210", "Test message")
      ).resolves.not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to send SMS:",
        testError.message
      );

      consoleErrorSpy.mockRestore();
    });
  });
});
