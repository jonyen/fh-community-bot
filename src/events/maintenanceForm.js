import { extractFormValues, SUBMIT_ACTION_ID, CANCEL_ACTION_ID } from "../lib/maintenance-form.js";
import { log, metric } from "../lib/logger.js";

const DIMENSIONS = { Flow: "maintenanceForm" };

export function createMaintenanceFormHandler({ sheetsService, dedupService, photoService, spreadsheetId }) {
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
    // Slack fires block_actions for every element interaction (dropdown
    // selections, text input dispatches) — only the buttons mean anything.
    const actionId = payload.actions?.[0]?.action_id;
    if (actionId !== SUBMIT_ACTION_ID && actionId !== CANCEL_ACTION_ID) return;

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

    if (actionId === CANCEL_ACTION_ID) {
      try {
        await client.chat.delete({ channel, ts: formTs });
      } catch (err) {
        console.error("chat.delete failed:", err.message);
        const text = "Report cancelled.";
        try {
          await client.chat.update({
            channel,
            ts: formTs,
            text,
            blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
          });
        } catch (updateErr) {
          console.error("chat.update fallback failed:", updateErr.message);
        }
      }
      return;
    }

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

    // Claim the form before any slow work: strip the submit buttons so a
    // second click (double-click, impatient retry) carries a message snapshot
    // without submit_actions and is dropped by the guard above. Without this,
    // every click during the multi-second logging window appends a duplicate
    // row. Best-effort — if the update fails we're no worse off than before.
    const submittingText = "Submitting your report…";
    try {
      await client.chat.update({
        channel,
        ts: formTs,
        text: submittingText,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: submittingText } }],
      });
    } catch (err) {
      console.error("submitting-placeholder update failed:", err.message);
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

    const appendStartedAt = Date.now();
    try {
      await sheetsService.appendIssue({
        reporter: reporterName,
        description,
        severity,
        type,
        slackRef: threadTs,
        ...(photos.length ? { photos } : {}),
      });
      // The SLI. An issue only counts as reported once it is in the sheet —
      // the Lambda succeeding says nothing about whether facilities will see it.
      metric("IssueLogged", 1, { dimensions: DIMENSIONS, fields: { severity, type } });
      metric("SheetWriteMs", Date.now() - appendStartedAt, {
        unit: "Milliseconds",
        dimensions: DIMENSIONS,
      });
      log.info("issue logged", { severity, type, photos: photos.length });
    } catch (err) {
      metric("IssueFailed", 1, { dimensions: DIMENSIONS });
      log.error("appendIssue failed", { error: err, severity, type });
      // Put the form back (we replaced it with the placeholder) so the user
      // can hit Submit again once the sheet is reachable.
      try {
        await client.chat.update({
          channel,
          ts: formTs,
          text: payload.message?.text || "Report a maintenance issue",
          blocks: payload.message?.blocks,
        });
      } catch (restoreErr) {
        console.error("form restore failed:", restoreErr.message);
      }
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

    const docLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    let text = `Logged your issue (severity: *${severity}*, type: *${type}*). <${docLink}|View in Google Sheets>`;
    if (duplicate) {
      text += `\nThis might be related to issue #${duplicate.id}.`;
    }
    text += `\n\nFeel free to add more details in this thread and I'll include them in the notes.`;
    // Escalation contact for Medium/Critical issues. Set ESCALATION_USER_ID in
    // the environment; without it the cc line is simply omitted.
    const escalationUser = process.env.ESCALATION_USER_ID;
    if (escalationUser && (severity === "Medium" || severity === "Critical")) {
      text += `\n\ncc <@${escalationUser}>`;
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
