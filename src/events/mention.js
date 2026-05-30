import { extractSeverity, parseSeverityReply } from "../lib/severity.js";

function stripMention(text) {
  return text.replace(/<@[A-Z0-9_]+>/g, "").trim();
}

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
  const scored = openIssues
    .map((issue) => ({ issue, score: keywordOverlap(description, issue.description) }))
    .filter(({ score }) => score > 0.3)
    .sort((a, b) => b.score - a.score);
  return scored;
}


export function createMentionHandler({ sheetsService, groqService, dedupService, channelIds, spreadsheetId, pendingStore }) {
  // pendingStore persists issues awaiting a severity reply across Lambda
  // containers (e.g. when the "How severe?" prompt and the reply land on
  // different invocations). Falls back to an in-memory Map for tests/local use.
  const pendingIssues = pendingStore || new Map();
  const createdIssues = new Map();
  const engagedThreads = new Set();
  let botUserIdPromise = null;

  async function getBotUserId(client) {
    if (!botUserIdPromise) {
      botUserIdPromise = client.auth.test().then((r) => r.user_id).catch((err) => {
        console.error("auth.test failed:", err.message);
        botUserIdPromise = null;
        return null;
      });
    }
    return botUserIdPromise;
  }

  async function threadHasBotMention(client, channel, threadTs) {
    const botUserId = await getBotUserId(client);
    if (!botUserId) return false;
    const needle = `<@${botUserId}>`;
    let cursor;
    try {
      do {
        const res = await client.conversations.replies({
          channel,
          ts: threadTs,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const m of res.messages || []) {
          if ((m.text || "").includes(needle)) return true;
        }
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
    } catch (err) {
      console.error("conversations.replies failed:", err.message);
      return false;
    }
    return false;
  }

  return async function handleMention({ event, say, client }) {
    console.log(`[mention] user=${event.user} channel=${event.channel} text="${event.text}"`);

    if (!channelIds.has(event.channel)) return;

    const threadKeyEarly = event.thread_ts || event.ts;
    const hasMention = /<@[A-Z0-9_]+>/.test(event.text || "");
    if (hasMention) {
      engagedThreads.add(threadKeyEarly);
    } else if (event.thread_ts && !engagedThreads.has(threadKeyEarly)) {
      const engaged = await threadHasBotMention(client, event.channel, event.thread_ts);
      if (!engaged) return;
      engagedThreads.add(threadKeyEarly);
    }

    // Acknowledge receipt immediately
    try {
      await client.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: "eyes",
      });
    } catch (err) {
      console.error("Failed to add reaction:", err.message);
    }

    const description = stripMention(event.text || "");
    const threadKey = event.thread_ts || event.ts;
    // Channel-scoped key for the persistent pending store: thread timestamps
    // are only unique within a channel, so namespace by channel to avoid
    // cross-channel collisions in the shared table.
    const pendingKey = `${event.channel}:${threadKey}`;

    // Check if this is a severity reply for a pending issue. Accept the answer
    // from anyone in the thread (not just the original reporter) and tolerate
    // extra words around the keyword, e.g. "Medium but important to do it soon".
    const pending = await pendingIssues.get(pendingKey);
    if (pending) {
      const severity = parseSeverityReply(description);
      if (!severity) {
        await say({
          text: "Please reply with one of: *Minor*, *Medium*, or *Critical*.",
          thread_ts: threadKey,
        });
        return;
      }

      await pendingIssues.delete(pendingKey);

      let id;
      try {
        id = await sheetsService.appendIssue({
          reporter: pending.reporterName,
          description: pending.issueDescription,
          severity,
        });
      } catch {
        await say({
          text: "Couldn't log this issue right now — please try again in a few minutes.",
          thread_ts: threadKey,
        });
        return;
      }

      createdIssues.set(threadKey, id);

      const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      let responseText = `Logged your issue (severity: *${severity}*). <${docLink}|View in Google Sheets>`;
      if (pending.duplicate && !pending.duplicate.confident) {
        responseText += ` This might be related to issue #${pending.duplicate.id}.`;
      }
      if (pending.suggestion) {
        responseText += `\n\n*Suggested fix:* ${pending.suggestion}`;
      } else {
        responseText += `\nCouldn't generate a suggestion right now.`;
      }
      responseText += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
      if (severity === "Medium" || severity === "Critical") {
        responseText += `\n\ncc <@U0000000000>`;
      }

      await say({ text: responseText, thread_ts: threadKey });
      return;
    }

    // If this is a thread reply for a created issue and not a command, append as a note
    const issueRowId = createdIssues.get(threadKey);
    if (issueRowId && event.thread_ts && description) {
      // Don't treat list/close/create commands as notes
      const isCommand = /\b(list|show|what are|open requests|open issues|status)\b/i.test(description)
        || /^(?:close|resolve|mark as resolved)\s+/i.test(description)
        || /^create new:\s*/i.test(description);
      if (!isCommand) {
        try {
          await sheetsService.appendNote(issueRowId, description);
          await say({ text: "Got it, added that to the notes.", thread_ts: threadKey });
        } catch (err) {
          console.error("Sheets error:", err.message);
          await say({ text: "Couldn't update the notes right now.", thread_ts: threadKey });
        }
        return;
      }
    }

    if (!description) {
      await say({
        text: "Please describe the issue you'd like to report.",
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }

    // Check if user is asking for a list of requests
    if (/\b(list|show|what are|open requests|open issues|status)\b/i.test(description)) {
      try {
        const openIssues = await sheetsService.getOpenIssues();
        if (openIssues.length === 0) {
          await say({ text: "No open requests right now.", thread_ts: event.ts });
        } else {
          // Show past 7 days of requests, or the 5 most recent if none in that window
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          const recentIssues = openIssues.filter((i) => {
            const parsed = new Date(i.date);
            return !isNaN(parsed) && parsed >= sevenDaysAgo;
          });
          const issuesToShow = recentIssues.length > 0 ? recentIssues : openIssues.slice(0, 5);
          const label = recentIssues.length > 0 ? "Requests from the Past 7 Days" : "5 Most Recent Requests";
          const lines = issuesToShow.map(
            (i) => `• *${i.description}* — submitted by ${i.submitter} on ${i.date} (Status: ${i.status})`
          );
          await say({
            text: `*${label} (${issuesToShow.length}):*\n${lines.join("\n")}`,
            thread_ts: event.thread_ts || event.ts,
          });
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't fetch requests right now.", thread_ts: event.ts });
      }
      return;
    }

    // Check for close/resolve command
    const closeMatch = description.match(/^(?:close|resolve|mark as resolved)\s+#?(\d+)$/i);
    const closeByDesc = description.match(/^(?:close|resolve|mark as resolved)\s+(.+)$/i);

    if (closeMatch) {
      // Direct close by ID
      const rowId = closeMatch[1];
      try {
        const allIssues = await sheetsService.getOpenIssues();
        const issue = allIssues.find((i) => i.id === rowId);
        if (!issue) {
          await say({ text: `No open issue found with ID #${rowId}.`, thread_ts: event.ts });
          return;
        }
        await sheetsService.updateIssueStatus(rowId, "Resolved");
        await say({
          text: `Issue #${rowId} (*${issue.description}*) has been marked as resolved.`,
          thread_ts: event.thread_ts || event.ts,
        });
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't update the issue right now — please try again.", thread_ts: event.ts });
      }
      return;
    }

    if (closeByDesc && !/^\d+$/.test(closeByDesc[1].trim())) {
      const searchDesc = closeByDesc[1].trim();
      try {
        const openIssues = await sheetsService.getOpenIssues();
        const matches = findMatchingIssues(searchDesc, openIssues);

        if (matches.length === 0) {
          await say({ text: `No open issue matching "${searchDesc}" was found.`, thread_ts: event.ts });
        } else if (matches.length === 1) {
          const { issue } = matches[0];
          await sheetsService.updateIssueStatus(issue.id, "Resolved");
          await say({
            text: `Issue #${issue.id} (*${issue.description}*) has been marked as resolved.`,
            thread_ts: event.thread_ts || event.ts,
          });
        } else {
          const lines = matches.slice(0, 5).map(
            ({ issue }) => `• #${issue.id} — *${issue.description}* (${issue.status})`
          );
          await say({
            text: `Multiple issues match that description. Which one should I close?\n${lines.join("\n")}\n\nReply with \`@FH Maintenance close #<ID>\` to specify.`,
            thread_ts: event.thread_ts || event.ts,
          });
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't update the issue right now — please try again.", thread_ts: event.ts });
      }
      return;
    }

    // Check for "create new:" prefix to bypass duplicate detection
    const forceCreate = description.match(/^create new:\s*(.+)$/i);
    const rawDescription = forceCreate ? forceCreate[1] : description;

    // Check if severity was provided inline (e.g. "printer jammed - critical")
    const extracted = extractSeverity(rawDescription);
    const issueDescription = extracted.severity ? extracted.description : rawDescription;
    const inlineSeverity = extracted.severity;

    // Classify whether this is actually a maintenance request
    if (!forceCreate) {
      console.log("[mention] classifying...");
      const isMaintenance = await groqService.isMaintenanceRequest(issueDescription);
      console.log("[mention] isMaintenance =", isMaintenance);
      if (!isMaintenance) {
        await say({
          text: "I'm not sure that's a maintenance request. Could you describe a specific facilities or maintenance issue you'd like to report? For example: a broken fixture, a leak, or something that needs repair.",
          thread_ts: event.thread_ts || event.ts,
        });
        return;
      }
    }

    console.log("[mention] fetching open issues...");
    let openIssues;
    try {
      openIssues = await sheetsService.getOpenIssues();
    } catch (err) {
      console.error("Sheets error:", err.message);
      await say({
        text: "Couldn't log this issue right now — please try again in a few minutes.",
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }

    // Skip duplicate check if user is forcing creation
    // Ignore issues older than 7 days for duplicate detection
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentIssues = openIssues.filter((issue) => {
      const parsed = new Date(issue.date);
      return !isNaN(parsed) && parsed >= sevenDaysAgo;
    });

    let duplicate = null;
    if (!forceCreate) {
      duplicate = await dedupService.findDuplicate(issueDescription, recentIssues);

      if (duplicate && duplicate.confident) {
        const existing = openIssues.find((i) => i.id === duplicate.id);
        const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        await say({
          text: `This looks like an existing issue (row ${duplicate.id}, submitted by ${existing.submitter} on ${existing.date}). Current status: *${existing.status}*\n\n<${docLink}|View in Google Sheets>\n\nIf this is a new issue, reply with \`@FH Maintenance create new: ${issueDescription}\``,
          thread_ts: event.thread_ts || event.ts,
        });
        return;
      }
    }

    console.log("[mention] generating suggestion...");
    const suggestion = await groqService.suggestFix(issueDescription);
    console.log("[mention] suggestion done");

    let reporterName = event.user;
    try {
      const userInfo = await client.users.info({ user: event.user });
      reporterName = userInfo.user.real_name || userInfo.user.name || event.user;
    } catch (err) {
      console.error("Failed to fetch user info:", err.message);
    }

    if (inlineSeverity) {
      // Severity provided inline — create issue immediately
      console.log("[mention] appending issue (inline severity)...");
      let id;
      try {
        id = await sheetsService.appendIssue({
          reporter: reporterName,
          description: issueDescription,
          severity: inlineSeverity,
        });
      } catch {
        await say({
          text: "Couldn't log this issue right now — please try again in a few minutes.",
          thread_ts: threadKey,
        });
        return;
      }

      createdIssues.set(threadKey, id);

      const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      let responseText = `Logged your issue (severity: *${inlineSeverity}*). <${docLink}|View in Google Sheets>`;
      if (duplicate && !duplicate.confident) {
        responseText += ` This might be related to issue #${duplicate.id}.`;
      }
      if (suggestion) {
        responseText += `\n\n*Suggested fix:* ${suggestion}`;
      } else {
        responseText += `\nCouldn't generate a suggestion right now.`;
      }
      responseText += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
      if (inlineSeverity === "Medium" || inlineSeverity === "Critical") {
        responseText += `\n\ncc <@U0000000000>`;
      }

      await say({ text: responseText, thread_ts: threadKey });
      console.log("[mention] done");
    } else {
      // Store pending issue and ask for severity
      await pendingIssues.set(pendingKey, {
        user: event.user,
        reporterName,
        issueDescription,
        suggestion,
        duplicate,
      });

      console.log("[mention] asking for severity...");
      await say({
        text: "How severe is this issue? Please reply with one of: *minor*, *medium*, or *critical*.",
        thread_ts: threadKey,
      });
      console.log("[mention] waiting for severity reply");
    }
  };
}
