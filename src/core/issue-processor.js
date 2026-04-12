export function extractSeverity(text) {
  const match = text.match(
    /[\s,\-\|]+(?:severity[:\s]+)?(minor|medium|critical)(?:\s+(?:priority|severity|issue))?\s*$|[\s,\-\|]+(minor|medium|critical)\s+(?:priority|severity)\s*$/i
  );
  if (!match) return { description: text, severity: null };
  const severity = (match[1] || match[2]).toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const description = text.slice(0, match.index).trim();
  return { description, severity };
}

const VALID_SEVERITIES = ["minor", "medium", "critical"];

export function createIssueProcessor({ sheetsService, groqService, dedupService, conversationService, spreadsheetId }) {
  async function processNewReport({ description, reporterName, conversationKey, severity: passedSeverity, forceCreate }) {
    // Extract inline severity from description
    const extracted = extractSeverity(description);
    const inlineSeverity = extracted.severity;
    const issueDescription = inlineSeverity ? extracted.description : description;

    // Determine effective severity (inline takes precedence over passed)
    const severity = inlineSeverity || passedSeverity || null;

    // Classify unless forceCreate
    if (!forceCreate) {
      const isMaintenance = await groqService.isMaintenanceRequest(issueDescription);
      if (!isMaintenance) {
        return { action: "not_maintenance" };
      }
    }

    // Fetch open issues
    let openIssues;
    try {
      openIssues = await sheetsService.getOpenIssues();
    } catch {
      return { action: "sheets_error" };
    }

    // Filter to last 7 days for dedup
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentIssues = openIssues.filter((issue) => {
      const parsed = new Date(issue.date);
      return !isNaN(parsed) && parsed >= sevenDaysAgo;
    });

    // Dedup check (skip when forceCreate)
    let duplicate = null;
    if (!forceCreate) {
      duplicate = await dedupService.findDuplicate(issueDescription, recentIssues);
      if (duplicate && duplicate.confident) {
        const existingIssue = openIssues.find((i) => i.id === duplicate.id);
        return { action: "duplicate_found", existingIssue, issueDescription };
      }
    }

    // Get AI suggestion
    const suggestion = await groqService.suggestFix(issueDescription);

    // If severity is known, create issue immediately
    if (severity) {
      let issueRowId;
      try {
        issueRowId = await sheetsService.appendIssue({
          reporter: reporterName,
          description: issueDescription,
          severity,
        });
      } catch {
        return { action: "sheets_error" };
      }

      await conversationService.saveConversation(conversationKey, {
        state: "issue_created",
        reporterName,
        issueDescription,
        issueRowId,
        severity,
        suggestion,
        duplicate,
      });

      return { action: "issue_created", issueRowId, severity, suggestion, duplicate, issueDescription };
    }

    // Ask for severity
    await conversationService.saveConversation(conversationKey, {
      state: "awaiting_severity",
      reporterName,
      issueDescription,
      suggestion,
      duplicate,
    });

    return { action: "awaiting_severity", suggestion, duplicate, issueDescription };
  }

  async function processSeverityReply({ conversationKey, severity: rawSeverity }) {
    const conversation = await conversationService.getConversation(conversationKey);
    if (!conversation || conversation.state !== "awaiting_severity") {
      return { action: "no_conversation" };
    }

    const severityLower = rawSeverity.toLowerCase();
    if (!VALID_SEVERITIES.includes(severityLower)) {
      return { action: "invalid_severity" };
    }

    const severity = severityLower.replace(/^./, (c) => c.toUpperCase());
    const { reporterName, issueDescription, suggestion, duplicate } = conversation;

    let issueRowId;
    try {
      issueRowId = await sheetsService.appendIssue({
        reporter: reporterName,
        description: issueDescription,
        severity,
      });
    } catch {
      return { action: "sheets_error" };
    }

    await conversationService.saveConversation(conversationKey, {
      ...conversation,
      state: "issue_created",
      issueRowId,
      severity,
    });

    return { action: "issue_created", issueRowId, severity, suggestion, duplicate, issueDescription };
  }

  async function processFollowUp({ conversationKey, text }) {
    const conversation = await conversationService.getConversation(conversationKey);
    if (!conversation || !conversation.issueRowId) {
      return { action: "no_conversation" };
    }

    const { issueRowId } = conversation;
    try {
      await sheetsService.appendNote(issueRowId, text);
    } catch {
      return { action: "sheets_error" };
    }

    // Refresh TTL by re-saving
    await conversationService.saveConversation(conversationKey, { ...conversation });

    return { action: "note_added" };
  }

  return { processNewReport, processSeverityReply, processFollowUp };
}
