import { buildMaintenanceFormBlocks } from "../lib/maintenance-form.js";

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

export function createMentionHandler({ sheetsService, dedupService, channelIds, spreadsheetId, photoService }) {
  async function collectPhotos(files) {
    if (!photoService || !files || files.length === 0) return [];
    try {
      return await photoService.collectPhotos(files);
    } catch (err) {
      console.error("collectPhotos failed:", err.message);
      return [];
    }
  }

  return async function handleMention({ event, say, client }) {
    console.log(`[mention] user=${event.user} channel=${event.channel} text="${event.text}"`);

    if (!channelIds.has(event.channel)) return;

    const description = stripMention(event.text || "");
    const threadKey = event.thread_ts || event.ts;
    const hasMention = /<@[A-Z0-9_]+>/.test(event.text || "");
    // Rows move as humans sort the sheet and as new issues insert at the top,
    // so resolve thread -> current row via the hidden SLACK_REF column at use
    // time rather than caching row numbers.
    let issueRowId;
    if (event.thread_ts) {
      try {
        issueRowId = await sheetsService.findIssueRowByRef(threadKey);
      } catch (err) {
        console.error("findIssueRowByRef failed:", err.message);
      }
    }

    // Non-mention thread replies only matter in threads of issues we logged
    // (notes/photos). Anything else is other people's conversation — ignore.
    if (!hasMention && !issueRowId) return;

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

    // If this is a thread reply for a created issue and not a command, append the
    // text as a note and/or attach any photos.
    if (issueRowId) {
      const isCommand =
        description &&
        (/\b(list|show|what are|open requests|open issues|status)\b/i.test(description) ||
          /^(?:close|resolve|mark as resolved)\s+/i.test(description));

      if (!isCommand) {
        const photos = await collectPhotos(event.files);
        if (description || photos.length) {
          try {
            if (description) await sheetsService.appendNote(issueRowId, description);
            if (photos.length) await sheetsService.appendPhotos(issueRowId, photos);
            const text = description
              ? "Got it, added that to the notes."
              : "Got it, added that photo to the issue.";
            await say({ text, thread_ts: threadKey });
          } catch (err) {
            console.error("Sheets error:", err.message);
            await say({ text: "Couldn't update the notes right now.", thread_ts: threadKey });
          }
          return;
        }
        return;
      }
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

    // Anything else: post the report form in the thread, description pre-filled
    // from the mention text. Submission is handled by the block_actions path
    // (src/events/maintenanceForm.js) — the form message itself carries all state.
    // Warn-only dedup check against the last 7 days of open issues so the
    // reporter can bail out before filling in the form.
    let duplicate = null;
    if (description && dedupService) {
      try {
        const openIssues = await sheetsService.getOpenIssues();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentIssues = openIssues.filter((issue) => {
          const parsed = new Date(issue.date);
          return !isNaN(parsed) && parsed >= sevenDaysAgo;
        });
        const match = await dedupService.findDuplicate(description, recentIssues);
        if (match) {
          const issue = recentIssues.find((i) => i.id === match.id);
          if (issue) duplicate = { id: issue.id, description: issue.description };
        }
      } catch (err) {
        console.error("form dedup check failed:", err.message);
      }
    }

    await say({
      text: "Report a maintenance issue",
      blocks: buildMaintenanceFormBlocks(description, duplicate, event.user),
      thread_ts: threadKey,
    });
  };
}
