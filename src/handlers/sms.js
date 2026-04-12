export function createSmsHandler({ issueProcessor, conversationService, pinpointService }) {
  async function handleSms(event) {
    let phoneNumber, body;
    try {
      const record = event.Records[0];
      const message = JSON.parse(record.Sns.Message);
      phoneNumber = message.originationNumber;
      body = (message.messageBody || "").trim();
    } catch (err) {
      console.error("Failed to parse SNS message:", err.message);
      return;
    }
    const conversationKey = `SMS#${phoneNumber}`;

    // Empty body
    if (!body) {
      await pinpointService.sendSms(phoneNumber, "Please describe the maintenance issue you'd like to report.");
      return;
    }

    // NEW prefix — start fresh
    const newMatch = body.match(/^NEW\s+(.+)$/i);
    if (newMatch) {
      await conversationService.deleteConversation(conversationKey);
      const result = await issueProcessor.processNewReport({
        description: newMatch[1],
        reporterName: phoneNumber,
        conversationKey,
      });
      await pinpointService.sendSms(phoneNumber, buildReply(result));
      return;
    }

    // Check existing conversation state
    const conversation = await conversationService.getConversation(conversationKey);
    const state = conversation && conversation.state;

    let result;
    if (state === "awaiting_severity") {
      result = await issueProcessor.processSeverityReply({ conversationKey, severity: body });
    } else if (state === "issue_created") {
      result = await issueProcessor.processFollowUp({ conversationKey, text: body });
    } else {
      result = await issueProcessor.processNewReport({
        description: body,
        reporterName: phoneNumber,
        conversationKey,
      });
    }

    await pinpointService.sendSms(phoneNumber, buildReply(result));
  }

  function buildReply(result) {
    switch (result.action) {
      case "awaiting_severity":
        return "How severe is this issue? Reply with: minor, medium, or critical";

      case "not_maintenance":
        return "That doesn't look like a maintenance request. Please describe a specific issue that needs to be repaired or fixed.";

      case "duplicate_found": {
        const { existingIssue } = result;
        return `This looks similar to an existing issue (ID: ${existingIssue.id}, submitted by ${existingIssue.submitter}, status: ${existingIssue.status}). Please check if this is the same issue.`;
      }

      case "issue_created": {
        const { severity, suggestion } = result;
        let text = `Logged your issue (severity: ${severity}).`;
        if (suggestion) {
          text += ` Suggestion: ${suggestion}`;
        }
        text += " Reply to add more details. Text NEW to report a different issue.";
        return text;
      }

      case "invalid_severity":
        return "Please reply with one of: minor, medium, or critical";

      case "note_added":
        return "Got it, added that to the issue notes.";

      case "sheets_error":
        return "Sorry, couldn't process that right now. Please try again in a few minutes.";

      case "no_conversation":
        return "Please describe the maintenance issue you'd like to report.";

      default:
        return "Sorry, something went wrong. Please try again.";
    }
  }

  return handleSms;
}
