function stripMention(text) {
  return text.replace(/<@[A-Z0-9_]+>/g, "").trim();
}

export function createMentionHandler({ sheetsService, ollamaService, dedupService, channelId }) {
  return async function handleMention({ event, say, client }) {
    if (event.channel !== channelId) return;

    const description = stripMention(event.text);

    if (!description) {
      await say({
        text: "Please describe the issue you'd like to report.",
        thread_ts: event.ts,
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
          const lines = openIssues.map(
            (i) => `• *${i.description}* — submitted by ${i.submitter} on ${i.date} (Status: ${i.status})`
          );
          await say({
            text: `*Open Requests (${openIssues.length}):*\n${lines.join("\n")}`,
            thread_ts: event.ts,
          });
        }
      } catch (err) {
        console.error("Sheets error:", err.message);
        await say({ text: "Couldn't fetch requests right now.", thread_ts: event.ts });
      }
      return;
    }

    let openIssues;
    try {
      openIssues = await sheetsService.getOpenIssues();
    } catch (err) {
      console.error("Sheets error:", err.message);
      await say({
        text: "Couldn't log this issue right now — please try again in a few minutes.",
        thread_ts: event.ts,
      });
      return;
    }

    const duplicate = await dedupService.findDuplicate(description, openIssues);

    if (duplicate && duplicate.confident) {
      const existing = openIssues.find((i) => i.id === duplicate.id);
      await say({
        text: `This looks like an existing issue (row ${duplicate.id}, submitted by ${existing.submitter} on ${existing.date}). Current status: *${existing.status}*`,
        thread_ts: event.ts,
      });
      return;
    }

    const suggestion = await ollamaService.suggestFix(description);

    let id;
    try {
      id = await sheetsService.appendIssue({
        reporter: event.user,
        description,
      });
    } catch {
      await say({
        text: "Couldn't log this issue right now — please try again in a few minutes.",
        thread_ts: event.ts,
      });
      return;
    }

    let responseText = `Logged as issue #${id}.`;

    if (duplicate && !duplicate.confident) {
      responseText += ` This might be related to issue #${duplicate.id}.`;
    }

    if (suggestion) {
      responseText += `\n\n*Suggested fix:* ${suggestion}`;
    } else {
      responseText += `\nCouldn't generate a suggestion right now.`;
    }

    await say({
      text: responseText,
      thread_ts: event.ts,
    });
  };
}
