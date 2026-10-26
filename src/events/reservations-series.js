// src/events/reservations-series.js
// Cancelling from the combined public post that Reserve all makes: one line
// (a single date), a whole repeat series, or one date of a series. "What do I
// have booked?" opens the same series chooser.
//
// Only the member who booked may cancel; dates that have ended are never
// touched; a series is read back from the member's own ledger, never from
// the button, so a press can only cancel that member's own bookings. The
// public post is updated last and never decides whether a cancel happens.
import { log } from "../lib/logger.js";
import { nyToday, fmtDay, periodCovering } from "../lib/reservation-time.js";
import { BOT_PERSONA } from "../lib/reservation-format.js";
import { repeatText } from "../lib/reservation-tray.js";
import { refKey, sameRef } from "../lib/reservation-owner.js";
import { POST_CANCEL_ACTION, SERIES_ALL_ACTION, SERIES_ONE_ACTION, markLineCancelled, seriesChooser } from "../lib/reservation-combined.js";
import { MINE_SERIES_ACTION } from "../lib/reservation-mine.js";

const ENDED_TEXT = "That booking has already ended.";
const NO_DATES_TEXT = "That series has no dates left to cancel.";
const NOT_BOOKED_TEXT = "That date isn't booked in this series any more.";
// RMS cancels are calendar calls that can be slow; the sheets have write
// quotas, so their rows go one at a time. A series is at most this many
// dates per press, which keeps a run inside the worker's time.
const RMS_AT_ONCE = 4;
const SERIES_MAX = 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GONE = new Set(["cancelled", "already"]);

const parse = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// The real document client rejects undefined values in the pending row.
const defined = (v) => JSON.parse(JSON.stringify(v));

export function createSeriesFlow({
  adapters, ledger = null, connect = null, livingDigest = null, now = () => new Date(),
  cancelOne, memberClients, promptConnect, hasEnded, requesterFor, cancelText,
}) {
  const ACTIONS = new Set([POST_CANCEL_ACTION, SERIES_ALL_ACTION, SERIES_ONE_ACTION, MINE_SERIES_ACTION]);

  function ephemeral(client, { channel, user }, text, blocks) {
    return client.chat.postEphemeral({ channel, user, text, ...(blocks ? { blocks } : {}), ...BOT_PERSONA });
  }

  // Replaces the private message the press came from (the chooser, or the
  // "mine" list); without a response_url, or if it fails, a new ephemeral.
  async function replacePrivately(client, where, responseUrl, message) {
    if (responseUrl) {
      try {
        const res = await fetch(responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ replace_original: true, ...message }),
        });
        if (res.ok) return;
        log.warn("replacing a private message failed", { status: res.status });
      } catch (error) {
        log.warn("replacing a private message failed", { error });
      }
    }
    return client.chat.postEphemeral({ channel: where.channel, user: where.user, ...BOT_PERSONA, ...message });
  }

  async function liveSeries(user, seriesId) {
    if (!ledger) return { series: null, live: [] };
    const series = (await ledger.seriesFor(user, { today: nyToday(now()) })).find((s) => s.id === seriesId) || null;
    return { series, live: (series?.refs || []).filter((r) => adapters[r.backend] && !hasEnded(r)) };
  }

  // The post as it is now. Null when it can't be read: the cancel still
  // goes ahead, only the post is left as it was.
  async function readPost(client, channel, ts) {
    if (!channel || !ts) return null;
    try {
      const res = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1, include_all_metadata: true });
      const m = (res.messages || [])[0];
      return m && m.ts === ts && Array.isArray(m.blocks) ? m : null;
    } catch (error) {
      log.warn("reading the reserved post failed", { channel, ts, error });
      return null;
    }
  }

  const buttonOn = (post, index) => parse(post?.blocks?.[index + 1]?.accessory?.value);

  // Whether line `index` still carries this member's Cancel for this ref.
  function lineHasRef(post, index, ref, user) {
    const v = buttonOn(post, index);
    return !!(v && v.u === user && v.r && sameRef(ref, v.r));
  }

  function seriesLineIndex(post, seriesId, user) {
    for (let i = 0; i + 1 < (post?.blocks?.length ?? 0); i++) {
      const v = buttonOn(post, i);
      if (v && v.u === user && v.s === seriesId) return i;
    }
    return -1;
  }

  // Appends `text` to line `index`; its Cancel stays only while `keep`.
  async function markLine(client, { channel, ts, post, index, text, keep }) {
    const message = markLineCancelled(post, index, text, { done: !keep });
    const accessory = post.blocks[index + 1]?.accessory;
    if (keep && accessory) message.blocks[index + 1] = { ...message.blocks[index + 1], accessory };
    try {
      await client.chat.update({ channel, ts, ...message });
      return true;
    } catch (error) {
      log.warn("updating the reserved post failed", { channel, ts, error });
      return false;
    }
  }

  // Each affected digest period once.
  async function refreshDigest(dates) {
    const periods = new Map();
    for (const d of [...new Set(dates)].sort()) {
      const { from } = periodCovering(d);
      if (!periods.has(from)) periods.set(from, d);
    }
    for (const date of periods.values()) {
      try {
        await livingDigest?.refresh(date);
      } catch (error) {
        log.error("digest refresh failed", { date, error });
      }
    }
  }

  // Whose account the cancels use. Null means the member was asked to
  // connect first; the pending row carries `request` to resume from.
  async function accountFor({ client, user, refs, where, request }) {
    if (refs.every((r) => r.backend === "rms" && r.organizerSelf)) return { clients: null };
    const member = await memberClients(user);
    if (member.status === "active") return { clients: member.clients };
    if (member.status === "bot") return { clients: null };
    await promptCancel({ client, user, where, request, link: adapters[refs[0].backend]?.link, revoked: member.status === "revoked" });
    return null;
  }

  async function promptCancel({ client, user, where, request, link, revoked }) {
    const what = request.which === "all" ? "this series" : request.which === "one" ? "this date" : "this booking";
    const requester = await requesterFor(client, user);
    const tell = (text, blocks) => ephemeral(client, where, text, blocks);
    return promptConnect({
      request: defined({ kind: "series-cancel", user, ...request }), requester,
      say: { channel: where.channel, threadTs: null, cardTs: null, prompt: tell, done: tell },
      text: revoked
        ? `Your Google connection has expired. Connect again and I'll finish cancelling ${what} as you.`
        : `To cancel as you, connect your acts2.network Google account once. I'll cancel ${what} as soon as you approve.`,
      noEmail: (text) => tell(`${text} You can cancel it directly: ${link}`),
    });
  }

  async function forgetGrant(user) {
    if (!connect) return;
    try {
      await connect.authStore.markRevoked(user);
    } catch (error) {
      log.error("marking a grant revoked failed", { error });
    }
    connect.memberGoogle.forget(user);
  }

  async function safeCancel(ref, user, clients) {
    try {
      return await cancelOne({ ref, user, clients });
    } catch (error) {
      log.error("reservation cancel failed", { backend: ref.backend, error });
      return { status: "error", link: adapters[ref.backend]?.link ?? null, error };
    }
  }

  // Sheet rows one at a time; calendar events up to RMS_AT_ONCE at a time.
  // A revoked grant stops whatever hasn't started.
  async function cancelMany({ refs, user, clients }) {
    const results = new Map();
    let stopped = false;
    const one = async (ref) => {
      if (stopped) return;
      const out = await safeCancel(ref, user, clients);
      results.set(ref, out);
      if (out.status === "revoked") stopped = true;
    };
    const rms = refs.filter((r) => r.backend === "rms");
    const sheets = refs.filter((r) => r.backend !== "rms");
    await Promise.all([
      (async () => {
        for (const r of sheets) await one(r);
      })(),
      ...Array.from({ length: Math.min(RMS_AT_ONCE, rms.length) }, async () => {
        while (rms.length) await one(rms.shift());
      }),
    ]);
    return refs.filter((r) => results.has(r)).map((ref) => ({ ref, ...results.get(ref) }));
  }

  // A single date's Cancel on the post (it already had Slack's confirm).
  async function cancelLine({ client, user, channel, postTs, index, ref, where }) {
    if (!adapters[ref?.backend]) return;
    if (hasEnded(ref)) return ephemeral(client, where, ENDED_TEXT);
    const post = await readPost(client, channel, postTs);
    // A second press, or a redelivery after the line was marked: its Cancel is gone.
    if (post && !lineHasRef(post, index, ref, user)) {
      log.info("stale reserved-post cancel press", { channel, postTs, index });
      return;
    }
    const account = await accountFor({ client, user, refs: [ref], where, request: { which: "line", ref, index, channel, postTs } });
    if (!account) return;
    const out = await safeCancel(ref, user, account.clients);
    if (out.status === "revoked") {
      await forgetGrant(user);
      return promptCancel({ client, user, where, request: { which: "line", ref, index, channel, postTs }, link: adapters[ref.backend].link, revoked: true });
    }
    if (out.status !== "cancelled") return ephemeral(client, where, cancelText(ref, out, user));
    // Cancelled: a failed post edit or reply is logged, so an SQS retry
    // doesn't run the cancel again.
    const marked = post ? await markLine(client, { channel, ts: postTs, post, index, text: `🚫 Cancelled by <@${user}>.`, keep: false }) : false;
    if (!marked) {
      try {
        await ephemeral(client, where, cancelText(ref, out, user));
      } catch (error) {
        log.error("cancel confirmation failed", { error });
      }
    }
    await refreshDigest([ref.date]);
  }

  // A series line's Cancel (on the post, or Cancel… in "mine"): the
  // chooser, privately. From "mine" it replaces the list.
  async function offerChooser({ client, user, seriesId, channel, postTs, where, responseUrl }) {
    const { series, live } = await liveSeries(user, seriesId);
    if (!live.length) return ephemeral(client, where, NO_DATES_TEXT);
    const chooser = seriesChooser({
      user, series: { ...series, refs: live }, today: nyToday(now()),
      postTs: postTs ?? series.postTs ?? null, channel: channel ?? series.channel ?? where.channel,
    });
    if (responseUrl) return replacePrivately(client, where, responseUrl, chooser);
    return client.chat.postEphemeral({ channel: where.channel, user, ...BOT_PERSONA, ...chooser });
  }

  // Whole series (which "all") or one date of it (which "one"). `done` is
  // how many dates an earlier run cancelled before the grant was revoked.
  async function cancelSeries({ client, user, seriesId, which, date = null, channel, postTs, where, responseUrl, done = 0 }) {
    const tell = (text) => replacePrivately(client, where, responseUrl, { text });
    const { series, live } = await liveSeries(user, seriesId);
    if (!live.length) return tell(NO_DATES_TEXT);
    let targets = live;
    if (which === "one") {
      targets = live.filter((r) => r.date === date);
      if (!targets.length) return tell(series.refs.some((r) => r.date === date) ? ENDED_TEXT : NOT_BOOKED_TEXT);
    }
    const left = Math.max(0, targets.length - SERIES_MAX);
    targets = targets.slice(0, SERIES_MAX);
    const request = { seriesId, which, date, channel, postTs };
    const account = await accountFor({ client, user, refs: targets, where, request });
    if (!account) return;

    const results = await cancelMany({ refs: targets, user, clients: account.clients });
    const gone = results.filter((r) => GONE.has(r.status));
    const revoked = results.some((r) => r.status === "revoked");
    const failed = results.filter((r) => !GONE.has(r.status) && r.status !== "revoked");
    if (gone.length) {
      try {
        await ledger.dropSeriesRefs(user, seriesId, gone.map((r) => refKey(r.ref)));
      } catch (error) {
        log.error("series ledger write failed", { seriesId, error });
      }
    }
    const cancelledDates = gone.filter((r) => r.status === "cancelled").map((r) => r.ref.date);

    // Stop here; once connected again the rest is cancelled and the post
    // marked once, counting these dates too.
    if (revoked) {
      await forgetGrant(user);
      await promptCancel({ client, user, where, request: { ...request, done: done + gone.length }, link: adapters[targets[0].backend]?.link, revoked: true });
      return refreshDigest(cancelledDates);
    }

    const remaining = live.length - gone.length;
    const post = gone.length ? await readPost(client, channel, postTs) : null;
    const index = post ? seriesLineIndex(post, seriesId, user) : -1;
    const failNote = failed.length ? ` ${failed.length} couldn't be cancelled; check ${failed[0].link || adapters[failed[0].ref.backend]?.link}.` : "";

    let summary;
    if (which === "one") {
      const [out] = results;
      if (gone.length && index >= 0) {
        await markLine(client, { channel, ts: postTs, post, index, text: `🚫 ${fmtDay(date)} cancelled.`, keep: remaining > 0 });
      }
      summary = out.status === "cancelled" ? `🚫 ${esc(series.item)} · ${fmtDay(date)} cancelled.` : cancelText(out.ref, out, user);
    } else {
      const n = done + gone.length;
      if (n && index >= 0) {
        // Dates past this run's cap are still booked: the note must not read as complete.
        const note = left
          ? `🚫 ${plural(n, "date")} cancelled by <@${user}> so far; press Cancel again for the rest.${failNote}`
          : `🚫 Series cancelled by <@${user}> (${plural(n, "date")}).${failNote}`;
        await markLine(client, { channel, ts: postTs, post, index, text: note, keep: remaining > 0 });
      }
      summary = n
        ? `🚫 Cancelled ${plural(n, "date")} of ${esc(series.item)} · ${repeatText(series.repeat)}.${failNote}`
        : `⚠️ ${plural(failed.length, "date")} couldn't be cancelled; check ${failed[0].link || adapters[failed[0].ref.backend]?.link}.`;
      if (left) summary += ` ${plural(left, "more date")} left; press Whole series again for them.`;
    }
    try {
      await tell(summary);
    } catch (error) {
      log.error("series cancel summary failed", { error });
    }
    await refreshDigest(cancelledDates);
  }

  async function handleAction({ payload, action, client }) {
    const user = payload.user?.id;
    const where = { channel: payload.channel?.id || payload.container?.channel_id, user };
    const responseUrl = payload.response_url ?? null;
    const refuse = (owner) => ephemeral(client, where, `Only <@${owner}> can cancel this.`);

    if (action.action_id === POST_CANCEL_ACTION) {
      const v = parse(action.value);
      if (!v?.u) return;
      if (user !== v.u) return refuse(v.u);
      const postTs = payload.container?.message_ts || payload.message?.ts;
      if (v.r && Number.isInteger(v.i)) return cancelLine({ client, user, channel: where.channel, postTs, index: v.i, ref: v.r, where });
      if (typeof v.s === "string") return offerChooser({ client, user, seriesId: v.s, channel: where.channel, postTs, where, responseUrl: null });
      return;
    }
    if (action.action_id === MINE_SERIES_ACTION) {
      const v = parse(action.value);
      if (!v?.u || typeof v.s !== "string") return;
      if (user !== v.u) return refuse(v.u);
      return offerChooser({ client, user, seriesId: v.s, channel: null, postTs: null, where, responseUrl });
    }
    // The chooser: who and which series ride in its actions block's id.
    const ctx = parse(action.block_id);
    if (!ctx?.u || typeof ctx.s !== "string") return;
    if (user !== ctx.u) return refuse(ctx.u);
    const base = { client, user, seriesId: ctx.s, channel: ctx.c ?? null, postTs: ctx.pt ?? null, where, responseUrl };
    if (action.action_id === SERIES_ALL_ACTION) return cancelSeries({ ...base, which: "all" });
    if (action.action_id === SERIES_ONE_ACTION) {
      const date = parse(action.selected_option?.value)?.d;
      if (typeof date !== "string" || !ISO_DATE.test(date)) return;
      return cancelSeries({ ...base, which: "one", date });
    }
  }

  // After the member connects Google. There is no response_url, so every
  // private reply is a new ephemeral.
  async function resume(pending, client) {
    const r = pending.request || {};
    const user = r.user || pending.slackUserId;
    const where = { channel: pending.channel || r.channel, user };
    try {
      if (r.which === "line") {
        return await cancelLine({ client, user, channel: r.channel, postTs: r.postTs, index: r.index, ref: r.ref, where });
      }
      if (r.which !== "all" && r.which !== "one") return;
      return await cancelSeries({
        client, user, seriesId: r.seriesId, which: r.which, date: r.date ?? null, channel: r.channel, postTs: r.postTs,
        where, responseUrl: null, done: r.done || 0,
      });
    } catch (error) {
      // The pending row is gone; a rethrow would retry into nothing.
      log.error("resuming a series cancel failed", { error });
      try {
        await ephemeral(client, where, `⚠️ I couldn't finish cancelling after you connected (${error.message}). Please press Cancel again.`);
      } catch (replyError) {
        log.error("resume failure reply failed", { error: replyError });
      }
    }
  }

  return { handleAction, resume, ACTIONS };
}
