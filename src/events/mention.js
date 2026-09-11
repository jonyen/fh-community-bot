import { buildMaintenanceFormBlocks } from "../lib/maintenance-form.js";
import { classifyIssue } from "../lib/issue-classify.js";

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

export function createMentionHandler({ sheetsService, dedupService, issueClassifier, channelIds, spreadsheetId, photoService }) {
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

    // Only act when directly invoked. Un-mentioned thread replies are other
    // people's conversation, even inside an issue's thread.
    if (!/<@[A-Z0-9_]+>/.test(event.text || "")) return;

    const description = stripMention(event.text || "");
    const threadKey = event.thread_ts || event.ts;
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

    // A mention in a logged issue's thread that isn't a command appends the
    // text as a note and/or attaches any photos.
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
          const lines = openIssues.map(
            (i) => `• *${i.description}* — submitted by ${i.submitter} on ${i.date} (Status: ${i.status})`
          );
          await say({
            text: `*Open Requests (${openIssues.length}):*\n${lines.join("\n")}`,
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
    async function checkForDuplicate() {
      if (!description || !dedupService) return null;
      try {
        const openIssues = await sheetsService.getOpenIssues();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentIssues = openIssues.filter((issue) => {
          const parsed = new Date(issue.date);
          return !isNaN(parsed) && parsed >= sevenDaysAgo;
        });
        const match = await dedupService.findDuplicate(description, recentIssues);
        if (!match) return null;
        const issue = recentIssues.find((i) => i.id === match.id);
        return issue ? { id: issue.id, description: issue.description } : null;
      } catch (err) {
        console.error("form dedup check failed:", err.message);
        return null;
      }
    }

    // Ask the model for the type and severity. It answers with a null for
    // anything the report doesn't make clear, which leaves that dropdown empty
    // rather than putting a wrong answer in front of the reporter — the submit
    // path still requires both to be set.
    async function classifyForPrefill() {
      if (!issueClassifier) return classifyIssue(description);
      try {
        return await issueClassifier.classify(description);
      } catch (err) {
        console.error("form classification failed:", err.message);
        return { type: null, severity: null };
      }
    }

    // Both are model round-trips over the same sentence, and the form can't be
    // posted until both are back — so start them together rather than paying
    // for them one after the other.
    const [duplicate, prefill] = await Promise.all([
      checkForDuplicate(),
      classifyForPrefill(),
    ]);

    await say({
      text: "Report a maintenance issue",
      // Scope the form's block_ids to this mention so the Slack client cannot
      // surface another form's typed-in state (see formBlockId).
      blocks: buildMaintenanceFormBlocks(description, duplicate, event.user, prefill, event.ts),
      thread_ts: threadKey,
    });
  };
}
