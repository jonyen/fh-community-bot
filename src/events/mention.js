function stripMention(text) {
  return text.replace(/<@[A-Z0-9_]+>/g, "").trim();
}

export function createMentionHandler({ sheetsService, groqService, dedupService, channelId }) {
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

    let openIssues;
    try {
      openIssues = await sheetsService.getOpenIssues();
    } catch {
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
        text: `This issue has already been logged (issue #${duplicate.id}, reported by <@${existing.reporter}> on ${existing.timestamp}). Current status: *${existing.status}*`,
        thread_ts: event.ts,
      });
      return;
    }

    const suggestion = await groqService.suggestFix(description);

    let permalink = "";
    try {
      const res = await client.chat.getPermalink({ channel: event.channel, message_ts: event.ts });
      permalink = res.permalink;
    } catch {
      // non-critical
    }

    let id;
    try {
      id = await sheetsService.appendIssue({
        reporter: event.user,
        description,
        aiSuggestion: suggestion || "",
        messageLink: permalink,
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
