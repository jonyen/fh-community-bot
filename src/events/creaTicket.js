import {
  CREA_CLAIM_REACTION,
  isCreaTicketReaction,
  buildCreaDescription,
  buildCreaTitle,
} from "../lib/crea-ticket.js";
import { log, metric } from "../lib/logger.js";

const DIMENSIONS = { Flow: "creaTicket" };

// Files a logged maintenance report with CREA when someone reacts to it with a
// ticket emoji. The reaction can go on any message in the report's thread;
// the report itself is read back from the sheet row keyed by the thread ts,
// so whatever facilities edited in the sheet is what CREA receives.
export function createCreaTicketHandler({ twaService, sheetsService, channelIds, allowedUserIds, slackBotToken, fetchImpl = fetch }) {
  // Photos go to the portal as raw bytes, so they're downloaded from Slack
  // rather than taken from the Drive copies made when the report was logged.
  async function downloadPhotos(files) {
    const photos = [];
    for (const file of (files || []).filter((f) => (f.mimetype || "").startsWith("image/"))) {
      try {
        const resp = await fetchImpl(file.url_private_download || file.url_private, {
          headers: { Authorization: `Bearer ${slackBotToken}` },
        });
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
        photos.push({
          buffer: Buffer.from(await resp.arrayBuffer()),
          name: file.name || `${file.id}.img`,
          mimeType: file.mimetype,
        });
      } catch (err) {
        console.error("CREA photo download failed:", err.message);
      }
    }
    return photos;
  }

  async function postInThread(client, channel, threadTs, text) {
    try {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      console.error("CREA thread post failed:", err.message);
    }
  }

  return async function handleCreaReaction({ event, client }) {
    if (!isCreaTicketReaction(event.reaction)) return;
    if (event.item?.type !== "message") return;
    const channel = event.item.channel;
    if (channelIds && !channelIds.has(channel)) return;
    const userId = event.user;

    // Only a few people may open tickets with the landlord. Anyone else's
    // ticket reaction gets a private note and is otherwise ignored.
    if (!allowedUserIds?.has(userId)) {
      try {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          text: "Only the facilities leads can send reports to CREA. Ask one of them to add the :ticket:.",
        });
      } catch (err) {
        console.error("CREA not-allowed ephemeral failed:", err.message);
      }
      return;
    }

    // conversations.replies accepts any ts in a thread and always returns the
    // thread root first, so this resolves a reaction on a reply too.
    let root;
    try {
      const res = await client.conversations.replies({ channel, ts: event.item.ts, limit: 1 });
      root = res.messages?.[0];
    } catch (err) {
      log.error("CREA: couldn't read the reacted message", { error: err });
      return;
    }
    if (!root) return;
    const threadTs = root.thread_ts || root.ts;

    const issue = await sheetsService.findIssueByRef(threadTs);
    if (!issue) {
      try {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          ...(root.thread_ts ? { thread_ts: threadTs } : {}),
          text: "That message isn't a logged maintenance report, so there's nothing to send to CREA.",
        });
      } catch (err) {
        console.error("CREA ephemeral failed:", err.message);
      }
      return;
    }

    try {
      await client.reactions.add({ channel, timestamp: root.ts, name: CREA_CLAIM_REACTION });
    } catch (err) {
      if (err.data?.error === "already_reacted") {
        log.info("CREA: report already sent or in flight", { threadTs });
        return;
      }
      // Without the claim a duplicate is possible, but a missing reaction
      // scope shouldn't block filing entirely.
      console.error("CREA claim reaction failed:", err.message);
    }

    let result;
    try {
      result = await twaService.submitServiceIssue({
        type: issue.type || "Other",
        title: buildCreaTitle(issue.description),
        description: buildCreaDescription({
          description: issue.description,
          severity: issue.priority,
          reporter: issue.submitter,
        }),
        photos: await downloadPhotos(root.files),
      });
    } catch (err) {
      result = { status: "failed", reason: err.message };
    }

    if (result.status === "failed") {
      metric("CreaTicketFailed", 1, { dimensions: DIMENSIONS });
      log.error("CREA ticket failed", { reason: result.reason, type: issue.type });
      // Drop the claim so another :ticket: retries.
      try {
        await client.reactions.remove({ channel, timestamp: root.ts, name: CREA_CLAIM_REACTION });
      } catch (err) {
        console.error("CREA claim removal failed:", err.message);
      }
      await postInThread(
        client,
        channel,
        threadTs,
        `Couldn't send this to CREA (${result.reason}). React with :ticket: again to retry, or file it in the tenant portal.`
      );
      return;
    }

    const created = result.status === "created";
    metric(created ? "CreaTicketCreated" : "CreaTicketUnconfirmed", 1, { dimensions: DIMENSIONS });
    log.info("CREA ticket submitted", { status: result.status, type: issue.type, photos: result.attachedPhotos });

    let text = created
      ? `Sent to CREA as a service issue (requested by <@${userId}>).`
      : `Sent to CREA (requested by <@${userId}>), but the portal's reply wasn't recognised. Check Service Issues in the tenant portal before sending again.`;
    if (result.skippedPhotos) text += ` ${result.skippedPhotos} photo(s) couldn't be attached.`;
    await postInThread(client, channel, threadTs, text);

    // Best-effort audit trail in the sheet's NOTES column.
    try {
      const today = new Date().toLocaleDateString("en-US");
      await sheetsService.appendNote(issue.id, `${today}: sent to CREA portal${created ? "" : " (unconfirmed)"}`);
    } catch (err) {
      console.error("CREA sheet note failed:", err.message);
    }
  };
}
