import { extractFormValues } from "../lib/maintenance-form.js";

export function createMaintenanceFormHandler({ sheetsService, dedupService, photoService, spreadsheetId, createdIssues }) {
  async function collectRootPhotos(client, channel, threadTs) {
    if (!photoService || !threadTs) return [];
    try {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
      const root = res.messages?.[0];
      if (!root?.files?.length) return [];
      return await photoService.collectPhotos(root.files);
    } catch (err) {
      console.error("collectRootPhotos failed:", err.message);
      return [];
    }
  }

  return async function handleFormSubmission({ payload, client }) {
    const channel = payload.channel?.id;
    const formTs = payload.message?.ts;
    const threadTs = payload.message?.thread_ts || formTs;
    const userId = payload.user?.id;

    // A submit for a message whose form blocks are gone is a late duplicate
    // click — the first submit already replaced the form with a confirmation.
    const stillHasForm = (payload.message?.blocks || []).some(
      (b) => b.block_id === "submit_actions"
    );
    if (!stillHasForm) return;

    const { description, type, severity } = extractFormValues(payload.state?.values);
    if (!description || !type || !severity) {
      try {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          thread_ts: threadTs,
          text: "Please fill in the issue description, type, and severity, then hit Submit again.",
        });
      } catch (err) {
        console.error("postEphemeral failed:", err.message);
      }
      return;
    }

    let reporterName = userId;
    try {
      const userInfo = await client.users.info({ user: userId });
      reporterName = userInfo.user.real_name || userInfo.user.name || userId;
    } catch (err) {
      console.error("Failed to fetch user info:", err.message);
    }

    // Duplicate detection is warn-only: it never blocks logging.
    let duplicate = null;
    try {
      const openIssues = await sheetsService.getOpenIssues();
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const recentIssues = openIssues.filter((issue) => {
        const parsed = new Date(issue.date);
        return !isNaN(parsed) && parsed >= sevenDaysAgo;
      });
      duplicate = await dedupService.findDuplicate(description, recentIssues);
    } catch (err) {
      console.error("dedup check failed:", err.message);
    }

    const photos = await collectRootPhotos(client, channel, payload.message?.thread_ts);

    let id;
    try {
      id = await sheetsService.appendIssue({
        reporter: reporterName,
        description,
        severity,
        type,
        ...(photos.length ? { photos } : {}),
      });
    } catch (err) {
      console.error("appendIssue failed:", err.message);
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "Couldn't log this issue right now — please try again in a few minutes.",
        });
      } catch (postErr) {
        console.error("postMessage failed:", postErr.message);
      }
      return;
    }

    createdIssues.set(threadTs, id);

    const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    let text = `Logged your issue (severity: *${severity}*, type: *${type}*). <${docLink}|View in Google Sheets>`;
    if (duplicate) {
      text += `\nThis might be related to issue #${duplicate.id}.`;
    }
    text += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
    if (severity === "Medium" || severity === "Critical") {
      text += `\n\ncc <@U0000000000>`;
    }

    try {
      await client.chat.update({
        channel,
        ts: formTs,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    } catch (err) {
      console.error("chat.update failed:", err.message);
      try {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text });
      } catch (postErr) {
        console.error("postMessage fallback failed:", postErr.message);
      }
    }
  };
}
