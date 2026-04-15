import crypto from "crypto";

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function getKeywords(text) {
  const stopWords = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "not", "it", "my", "our", "this", "that", "again", "still", "very", "just", "been", "has", "have", "was", "are", "but", "with"]);
  return normalize(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function keywordOverlap(a, b) {
  const setA = new Set(getKeywords(a));
  const wordsB = getKeywords(b);
  if (setA.size === 0 || wordsB.length === 0) return 0;
  const matches = wordsB.filter((w) => setA.has(w)).length;
  return matches / Math.min(setA.size, wordsB.length);
}

function findMatchingIssues(description, openIssues) {
  return openIssues
    .map((issue) => ({ issue, score: keywordOverlap(description, issue.description) }))
    .filter(({ score }) => score > 0.3)
    .sort((a, b) => b.score - a.score);
}

export function createSlackHandler({ issueProcessor, conversationService, slackClient, sheetsService, channelIds, spreadsheetId, signingSecret }) {
  return async function handleSlackEvent(apiGatewayEvent) {
    // 1. Signature verification (must come before any request handling)
    if (signingSecret) {
      const timestamp = apiGatewayEvent.headers["x-slack-request-timestamp"];
      const slackSignature = apiGatewayEvent.headers["x-slack-signature"];

      if (!timestamp || !slackSignature) {
        return { statusCode: 401, body: "Missing signature headers" };
      }

      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 300) {
        return { statusCode: 401, body: "Request too old" };
      }

      const sigBasestring = `v0:${timestamp}:${apiGatewayEvent.body}`;
      const mySignature = "v0=" + crypto.createHmac("sha256", signingSecret).update(sigBasestring).digest("hex");
      const expected = Buffer.from(mySignature);
      const actual = Buffer.from(slackSignature);
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return { statusCode: 401, body: "Invalid signature" };
      }
    }

    const body = JSON.parse(apiGatewayEvent.body);

    // 2. URL verification challenge
    if (body.type === "url_verification") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: body.challenge }),
      };
    }

    // 3. Non-event_callback
    if (body.type !== "event_callback") {
      return { statusCode: 200, body: "ok" };
    }

    const event = body.event;

    // 4. Filter: wrong channel, bot messages, subtypes
    if (!channelIds.includes(event.channel) || event.bot_id || event.subtype) {
      return { statusCode: 200, body: "ok" };
    }

    // 5. Strip @mentions
    const text = (event.text || "").replace(/<@[A-Z0-9_]+>/g, "").trim();

    // 6. Thread key and conversation key
    const threadKey = event.thread_ts || event.ts;
    const conversationKey = `SLACK#${threadKey}`;

    // 7. Add eyes reaction
    try {
      await slackClient.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" });
    } catch (err) {
      console.error("Failed to add reaction:", err.message);
    }

    // 8. Helper say function
    async function say(msg) {
      await slackClient.chat.postMessage({ channel: event.channel, text: msg, thread_ts: threadKey });
    }

    // 9. Empty text
    if (!text) {
      await say("Please describe the issue you'd like to report.");
      return { statusCode: 200, body: "ok" };
    }

    // 10. List command
    if (/\b(list|show|what are|open requests|open issues|status)\b/i.test(text)) {
      try {
        const openIssues = await sheetsService.getOpenIssues();
        if (openIssues.length === 0) {
          await say("No open requests right now.");
        } else {
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          const recentIssues = openIssues.filter((i) => {
            const parsed = new Date(i.date);
            return !isNaN(parsed) && parsed >= sevenDaysAgo;
          });
          const issuesToShow = recentIssues.length > 0 ? recentIssues : openIssues.slice(0, 5);
          const label = recentIssues.length > 0 ? "Requests from the Past 7 Days" : "5 Most Recent Requests";
          const lines = issuesToShow.map(
            (i) => `\u2022 *${i.description}* \u2014 submitted by ${i.submitter} on ${i.date} (Status: ${i.status})`
          );
          await say(`*${label} (${issuesToShow.length}):*\n${lines.join("\n")}`);
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say("Couldn't fetch requests right now.");
      }
      return { statusCode: 200, body: "ok" };
    }

    // 11. Close by ID
    const closeMatch = text.match(/^(?:close|resolve|mark as resolved)\s+#?(\d+)$/i);
    if (closeMatch) {
      const rowId = closeMatch[1];
      try {
        const allIssues = await sheetsService.getOpenIssues();
        const issue = allIssues.find((i) => i.id === rowId);
        if (!issue) {
          await say(`No open issue found with ID #${rowId}.`);
          return { statusCode: 200, body: "ok" };
        }
        await sheetsService.updateIssueStatus(rowId, "Resolved");
        await say(`Issue #${rowId} (*${issue.description}*) has been marked as resolved.`);
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say("Couldn't update the issue right now.");
      }
      return { statusCode: 200, body: "ok" };
    }

    // 12. Close by description
    const closeByDesc = text.match(/^(?:close|resolve|mark as resolved)\s+(.+)$/i);
    if (closeByDesc && !/^\d+$/.test(closeByDesc[1].trim())) {
      const searchDesc = closeByDesc[1].trim();
      try {
        const openIssues = await sheetsService.getOpenIssues();
        const matches = findMatchingIssues(searchDesc, openIssues);

        if (matches.length === 0) {
          await say(`No open issue matching "${searchDesc}" was found.`);
        } else if (matches.length === 1) {
          const { issue } = matches[0];
          await sheetsService.updateIssueStatus(issue.id, "Resolved");
          await say(`Issue #${issue.id} (*${issue.description}*) has been marked as resolved.`);
        } else {
          const lines = matches.slice(0, 5).map(
            ({ issue }) => `\u2022 #${issue.id} \u2014 *${issue.description}* (${issue.status})`
          );
          await say(`Multiple issues match that description. Which one should I close?\n${lines.join("\n")}\n\nReply with \`close #<ID>\` to specify.`);
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say("Couldn't update the issue right now.");
      }
      return { statusCode: 200, body: "ok" };
    }

    // 13. Check conversation state
    const conversation = await conversationService.getConversation(conversationKey);
    const state = conversation && conversation.state;

    if (state === "awaiting_severity") {
      const result = await issueProcessor.processSeverityReply({ conversationKey, severity: text });
      await say(formatReply(result));
      return { statusCode: 200, body: "ok" };
    }

    if (state === "issue_created" && event.thread_ts) {
      // Thread reply for existing issue — treat as follow-up note (not a command since commands are handled above)
      const result = await issueProcessor.processFollowUp({ conversationKey, text });
      await say(formatReply(result));
      return { statusCode: 200, body: "ok" };
    }

    // 14. "create new:" prefix
    let description = text;
    let forceCreate = false;
    const createNewMatch = text.match(/^create new:\s*(.+)$/i);
    if (createNewMatch) {
      description = createNewMatch[1];
      forceCreate = true;
    }

    // 15. Get reporter name
    let reporterName = event.user;
    try {
      const userInfo = await slackClient.users.info({ user: event.user });
      reporterName = userInfo.user.real_name || userInfo.user.name || event.user;
    } catch (err) {
      console.error("Failed to fetch user info:", err.message);
    }

    // 16. Process new report
    const result = await issueProcessor.processNewReport({
      description,
      reporterName,
      conversationKey,
      forceCreate,
    });

    // 17. Format and send reply
    await say(formatReply(result));
    return { statusCode: 200, body: "ok" };
  };

  function formatReply(result) {
    switch (result.action) {
      case "awaiting_severity":
        return "How severe is this issue? Please reply with one of: *minor*, *medium*, or *critical*.";

      case "not_maintenance":
        return "I'm not sure that's a maintenance request. Could you describe a specific facilities or maintenance issue you'd like to report?";

      case "duplicate_found": {
        const { existingIssue, issueDescription } = result;
        const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        return `This looks like an existing issue (row ${existingIssue.id}, submitted by ${existingIssue.submitter} on ${existingIssue.date}). Current status: *${existingIssue.status}*\n\n<${docLink}|View in Google Sheets>\n\nIf this is a new issue, reply with \`create new: ${issueDescription}\``;
      }

      case "issue_created": {
        const { severity, suggestion, duplicate, issueRowId } = result;
        const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        let responseText = `Logged your issue (severity: *${severity}*). <${docLink}|View in Google Sheets>`;
        if (duplicate && !duplicate.confident) {
          responseText += ` This might be related to issue #${duplicate.id}.`;
        }
        if (suggestion) {
          responseText += `\n\n*Suggested fix:* ${suggestion}`;
        } else {
          responseText += `\nCouldn't generate a suggestion right now.`;
        }
        responseText += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
        if (severity === "Medium" || severity === "Critical") {
          responseText += `\n\ncc <@U0000000000>`;
        }
        return responseText;
      }

      case "invalid_severity":
        return "Please reply with one of: *Minor*, *Medium*, or *Critical*.";

      case "note_added":
        return "Got it, added that to the notes.";

      case "sheets_error":
        return "Couldn't log this issue right now \u2014 please try again in a few minutes.";

      default:
        return "Something went wrong. Please try again.";
    }
  }
}
