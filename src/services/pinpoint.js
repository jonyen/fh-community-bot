export function createPinpointService(pinpointClient, applicationId, originationNumber) {
  async function sendSms(destinationNumber, body) {
    try {
      await pinpointClient.sendMessages({
        ApplicationId: applicationId,
        MessageRequest: {
          Addresses: {
            [destinationNumber]: { ChannelType: "SMS" },
          },
          MessageConfiguration: {
            SMSMessage: {
              Body: body,
              MessageType: "TRANSACTIONAL",
              OriginationNumber: originationNumber,
            },
          },
        },
      });
    } catch (err) {
      console.error("Failed to send SMS:", err.message);
    }
  }

  return { sendSms };
}
