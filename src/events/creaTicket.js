import {
  CREA_CLAIM_REACTION,
  CREA_SEND_ACTION_ID,
  CREA_CANCEL_ACTION_ID,
  isCreaTicketReaction,
  buildCreaTitle,
  buildCreaDraftBlocks,
  extractCreaDraftValues,
} from "../lib/crea-ticket.js";
import { findFormBlock } from "../lib/maintenance-form.js";
import { portalPhotoSource, toJpeg } from "../lib/portal-photo.js";
import { log, metric } from "../lib/logger.js";

const DIMENSIONS = { Flow: "creaTicket" };

function imageFiles(files) {
  return (files || []).filter((f) => (f.mimetype || "").startsWith("image/"));
}

function textBlocks(text) {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}

// Files a logged maintenance report with CREA, in two steps. Reacting to the
// report with a ticket emoji posts a draft in its thread; pressing Send on the
// draft files it. The report is read back from the sheet row keyed by the
// thread ts, so whatever facilities edited in the sheet is what the draft
// starts from.
//
// `ticketWriter` (anything with writeLandlordTicket) rewrites the report into
// something fit for the landlord to read. When it's missing or fails, the
// draft starts from the report as written.
//
// Returns { handleReaction, handleDraftAction }: the first takes
// reaction_added events, the second block_actions payloads.
export function createCreaTicketHandler({ twaService, sheetsService, ticketWriter, channelIds, allowedUserIds, slackBotToken, fetchImpl = fetch }) {
  async function landlordWording(issue) {
    if (ticketWriter?.writeLandlordTicket) {
      try {
        const written = await ticketWriter.writeLandlordTicket(issue.description, { type: issue.type });
        if (written) return written;
      } catch (err) {
        console.error("CREA rewrite failed:", err.message);
      }
    }
    log.info("CREA: drafting from the report as written", { id: issue.id });
    return { title: buildCreaTitle(issue.description), description: issue.description };
  }

  // Photos go to the portal as raw bytes, so they're downloaded from Slack
  // rather than taken from the Drive copies made when the report was logged.
  // Ones the portal won't take as-is (HEIC, oversized) go as JPEG previews.
  async function downloadPhotos(files) {
    const photos = [];
    for (const file of imageFiles(files)) {
      try {
        const source = portalPhotoSource(file);
        if (!source) throw new Error(`no portal-compatible version of ${file.mimetype}`);
        const resp = await fetchImpl(source.url, {
          headers: { Authorization: `Bearer ${slackBotToken}` },
        });
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
        const bytes = Buffer.from(await resp.arrayBuffer());
        if (source.convert) {
          const fetchedType = (resp.headers.get("content-type") || "").split(";")[0].trim();
          photos.push({ buffer: Buffer.from(toJpeg(bytes, fetchedType)), name: source.name, mimeType: "image/jpeg" });
        } else {
          photos.push({ buffer: bytes, name: source.name, mimeType: file.mimetype });
        }
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

  async function ephemeral(client, args) {
    try {
      await client.chat.postEphemeral(args);
    } catch (err) {
      console.error("CREA ephemeral failed:", err.message);
    }
  }

  async function releaseClaim(client, channel, rootTs) {
    try {
      await client.reactions.remove({ channel, timestamp: rootTs, name: CREA_CLAIM_REACTION });
    } catch (err) {
      console.error("CREA claim removal failed:", err.message);
    }
  }

  async function readThreadRoot(client, channel, ts) {
    // conversations.replies accepts any ts in a thread and always returns the
    // thread root first.
    const res = await client.conversations.replies({ channel, ts, limit: 1 });
    return res.messages?.[0];
  }

  // Only a few people may open tickets with the landlord. Anyone else gets a
  // private note and is otherwise ignored.
  async function rejectIfNotAllowed(client, channel, userId, threadTs) {
    if (allowedUserIds?.has(userId)) return false;
    await ephemeral(client, {
      channel,
      user: userId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: "Only the facilities leads can send reports to CREA. Ask one of them to add the :ticket:.",
    });
    return true;
  }

  async function handleReaction({ event, client }) {
    if (!isCreaTicketReaction(event.reaction)) return;
    if (event.item?.type !== "message") return;
    const channel = event.item.channel;
    if (channelIds && !channelIds.has(channel)) return;
    const userId = event.user;

    if (await rejectIfNotAllowed(client, channel, userId)) return;

    let root;
    try {
      root = await readThreadRoot(client, channel, event.item.ts);
    } catch (err) {
      log.error("CREA: couldn't read the reacted message", { error: err });
      return;
    }
    if (!root) return;
    const threadTs = root.thread_ts || root.ts;

    const issue = await sheetsService.findIssueByRef(threadTs);
    if (!issue) {
      await ephemeral(client, {
        channel,
        user: userId,
        ...(root.thread_ts ? { thread_ts: threadTs } : {}),
        text: "That message isn't a logged maintenance report, so there's nothing to send to CREA.",
      });
      return;
    }

    // The claim marks the report as drafted or sent. Slack refuses a second
    // identical reaction (already_reacted), so a second :ticket: or a
    // redelivered event can't post a second draft.
    try {
      await client.reactions.add({ channel, timestamp: root.ts, name: CREA_CLAIM_REACTION });
    } catch (err) {
      if (err.data?.error === "already_reacted") {
        log.info("CREA: report already drafted or sent", { threadTs });
        return;
      }
      // Without the claim a duplicate draft is possible, but a missing
      // reaction scope shouldn't block filing entirely.
      console.error("CREA claim reaction failed:", err.message);
    }

    const wording = await landlordWording(issue);
    const blocks = buildCreaDraftBlocks({
      ...wording,
      type: issue.type,
      photoCount: imageFiles(root.files).length,
      requesterId: userId,
      draftKey: threadTs,
    });
    try {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "Draft ticket for CREA", blocks });
      metric("CreaDraftPosted", 1, { dimensions: DIMENSIONS });
    } catch (err) {
      log.error("CREA: couldn't post the draft", { error: err });
      await releaseClaim(client, channel, root.ts);
    }
  }

  async function handleDraftAction({ payload, client }) {
    const actionId = payload.actions?.[0]?.action_id;
    if (actionId !== CREA_SEND_ACTION_ID && actionId !== CREA_CANCEL_ACTION_ID) return;

    const channel = payload.channel?.id;
    const draftTs = payload.message?.ts;
    const threadTs = payload.message?.thread_ts || draftTs;
    const userId = payload.user?.id;

    // A click on a draft whose buttons are gone is a late duplicate: the first
    // click already replaced the draft.
    if (!findFormBlock(payload.message?.blocks, "crea_actions")) return;
    if (await rejectIfNotAllowed(client, channel, userId, threadTs)) return;

    if (actionId === CREA_CANCEL_ACTION_ID) {
      try {
        await client.chat.delete({ channel, ts: draftTs });
      } catch (err) {
        console.error("CREA draft delete failed:", err.message);
        try {
          await client.chat.update({ channel, ts: draftTs, text: "CREA draft discarded.", blocks: textBlocks("CREA draft discarded.") });
        } catch (updateErr) {
          console.error("CREA draft update failed:", updateErr.message);
        }
      }
      // Free the report so a later :ticket: drafts it again.
      await releaseClaim(client, channel, threadTs);
      return;
    }

    const edited = extractCreaDraftValues(payload.state?.values);
    if (!edited.description) {
      await ephemeral(client, {
        channel,
        user: userId,
        thread_ts: threadTs,
        text: "The description is empty. Fill it in, then hit Send to CREA again.",
      });
      return;
    }

    // Claim the draft before the slow work: with the buttons gone, a second
    // click carries a snapshot without crea_actions and is dropped above.
    try {
      await client.chat.update({ channel, ts: draftTs, text: "Sending to CREA…", blocks: textBlocks("Sending to CREA…") });
    } catch (err) {
      console.error("CREA sending-placeholder update failed:", err.message);
    }

    let issue = null;
    let root = null;
    try {
      issue = await sheetsService.findIssueByRef(threadTs);
      root = await readThreadRoot(client, channel, threadTs);
    } catch (err) {
      log.error("CREA: couldn't reload the report", { error: err });
    }

    // The type comes from the sheet at send time; the wording comes from the
    // draft as edited, and goes as-is.
    const type = issue?.type || "Other";
    const title = edited.title || buildCreaTitle(edited.description);
    const description = edited.description;

    let result;
    if (!issue) {
      result = { status: "failed", reason: "the report is no longer in the sheet" };
    } else {
      try {
        result = await twaService.submitServiceIssue({ type, title, description, photos: await downloadPhotos(root?.files) });
      } catch (err) {
        result = { status: "failed", reason: err.message };
      }
    }

    if (result.status === "failed") {
      metric("CreaTicketFailed", 1, { dimensions: DIMENSIONS });
      log.error("CREA ticket failed", { reason: result.reason, type });
      // Put the draft back with the edits kept, so Send can be pressed again.
      // A fresh key stops Slack carrying stale input state into it.
      const blocks = buildCreaDraftBlocks({
        title: edited.title,
        description: edited.description,
        type: issue?.type,
        photoCount: imageFiles(root?.files).length,
        draftKey: `${threadTs}.${Date.now()}`,
      });
      try {
        await client.chat.update({ channel, ts: draftTs, text: "Draft ticket for CREA", blocks });
      } catch (err) {
        console.error("CREA draft restore failed:", err.message);
      }
      await postInThread(
        client,
        channel,
        threadTs,
        `Couldn't send this to CREA (${result.reason}). Hit Send to CREA on the draft to retry, or file it in the tenant portal.`
      );
      return;
    }

    const created = result.status === "created";
    metric(created ? "CreaTicketCreated" : "CreaTicketUnconfirmed", 1, { dimensions: DIMENSIONS });
    log.info("CREA ticket submitted", { status: result.status, type, photos: result.attachedPhotos });

    // Replace the draft with a record of exactly what CREA received.
    const quoted = description.split("\n").map((l) => `> ${l}`).join("\n");
    let text = created
      ? `Sent to CREA as a service issue by <@${userId}>.`
      : `Sent to CREA by <@${userId}>, but the portal's reply wasn't recognised. Check Service Issues in the tenant portal before sending again.`;
    if (result.skippedPhotos) text += ` ${result.skippedPhotos} photo(s) couldn't be attached.`;
    text += `\n*${type === "Other" ? title : type}*\n${quoted}`;
    try {
      await client.chat.update({ channel, ts: draftTs, text, blocks: textBlocks(text) });
    } catch (err) {
      console.error("CREA sent-record update failed:", err.message);
      await postInThread(client, channel, threadTs, text);
    }

    // Best-effort audit trail in the sheet's NOTES column.
    try {
      const today = new Date().toLocaleDateString("en-US");
      await sheetsService.appendNote(issue.id, `${today}: sent to CREA portal${created ? "" : " (unconfirmed)"}`);
    } catch (err) {
      console.error("CREA sheet note failed:", err.message);
    }
  }

  return { handleReaction, handleDraftAction };
}
