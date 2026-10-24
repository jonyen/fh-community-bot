// src/events/reservations.js
// Reservations: members post plain messages in #reservations and the bot
// replies in each message's thread, first come first served. Questions get an
// answer. A booking request gets a card (what the bot understood, free or not,
// Book and Edit); the request rides in the card's buttons, so nothing is
// stored. Book writes; Edit's modal only updates the card; Cancel closes it. A
// refused card is replaced by its outcome; a booked one keeps a Cancel booking
// button, whose value says where the booking lives. "What do I have
// booked?" gets a private list, each line with its own Cancel.
import { randomBytes } from "node:crypto";
import { log, metric } from "../lib/logger.js";
import { nyToday, nyParts, addDaysIso, weekdayName, fmtDay, fmtRange } from "../lib/reservation-time.js";
import { catalogPromptText, categoryCounts, CATEGORY_NAMES, CATEGORY_OWNERS, ownerFor } from "../lib/reservation-catalog.js";
import { isInvalidGrant, isForbidden, isScopeMissing } from "../services/memberGoogle.js";
import { normalizeRequest, missingFields, isIgnorableChatter } from "../lib/reservation-request.js";
import { reservationLine, BOT_PERSONA } from "../lib/reservation-format.js";
import {
  cardMessage, closedMessage, bookedMessage, decodeCard, decodeRef, openBookValue, isOpenCard, cancelBookingValue, cardSummaryLine,
  BOOK_ACTION, EDIT_ACTION, CANCEL_ACTION, CANCEL_BOOKING_ACTION,
} from "../lib/reservation-card.js";
import { readEditModal, MODAL_CALLBACK } from "../lib/reservation-modal.js";
import { mineMessage, MINE_CANCEL_ACTION } from "../lib/reservation-mine.js";
import { isMine, refKey, hasRefKey } from "../lib/reservation-owner.js";
import { calendarLink } from "../lib/rms-catalog.js";
import { createListingFlow } from "./reservations-listing.js";
import { createReserveAll } from "./reservations-reserve-all.js";
import { createSeriesFlow } from "./reservations-series.js";
import { TRAY_RESERVE_ACTION } from "../lib/reservation-listing.js";

const TECH_NOTE = "Reminder: the booking covers the ENTIRE time you hold the set. Return it to the tech room and charge the speaker and mic receivers after.";
export const FIND_CAP = 25;
const ENDED_TEXT = "That booking has already ended.";
const COMMAND_HELP = "Ask me privately, for example `/reserve what are my reservations`, `/reserve what can I reserve`, `/reserve is the MPR free Saturday 2-4` or `/reserve who has the Transit`.";
const COMMAND_BOOK_TEXT = "To book, post it in the channel without /reserve, or open `/reserve what can I reserve` and add it there.";
// Shown privately to each member when they join #reservations.
export const WELCOME_TEXT = [
  "*Welcome to #reservations!* I book rooms, the kitchen, tech sets, vehicles, and sports, outreach and accessories equipment.",
  "• *To book*, post what you need here, for example `Tech Set 2 Sat 2-4pm for youth night`. I reply in the thread with a card; press *Book* to confirm.",
  "• *To ask privately*, use `/reserve`, for example `/reserve is the MPR free Saturday 2-4` or `/reserve what do I have booked?`. Only you see the question and the answer.",
  "• `/reserve` on its own lists everything you can reserve.",
].join("\n");
// After a question asked in the open, at most once a week per member.
export const COMMAND_TIP = "Tip: only you can see this. Next time, you can ask with `/reserve`, for example `/reserve is the MPR free Saturday 2-4`, and nobody else sees the question or the answer.";
export const WELCOME_TTL_S = 365 * 86400;
export const TIP_TTL_S = 7 * 86400;
const QUESTION_INTENTS = new Set(["mine", "browse", "find", "check", "list"]);
const CARD_ACTIONS = new Set([BOOK_ACTION, EDIT_ACTION, CANCEL_ACTION, CANCEL_BOOKING_ACTION, MINE_CANCEL_ACTION]);
const MINE_DAYS = 60;
const MINE_CAP = 20;
// What a failed write as the member means: their grant is gone, their account
// may not write there, or something else went wrong. A bare message (no
// status code) can still be told revoked by its words, never forbidden.
export function classifyWriteError(error) {
  const err = typeof error === "string" ? { message: error } : error;
  // Failed after the write went out: it may exist, so never "try again later".
  if (err?.maybeWritten) return "error";
  if (isInvalidGrant(err) || isScopeMissing(err)) return "revoked";
  if (isForbidden(err)) return "forbidden";
  return "error";
}

export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date(), connect = null, livingDigest = null, claimBooking = null, ledger = null, trayStore = null, claimOnce = null }) {
  const catalogText = catalogPromptText(catalog);

  async function withMentions(client, reservations) {
    return Promise.all(reservations.map(async (r) => {
      if (r.holderUserId || !r.holderEmail) return r;
      try {
        const res = await client.users.lookupByEmail({ email: r.holderEmail });
        return { ...r, holderUserId: res.user?.id || null };
      } catch {
        return r;
      }
    }));
  }

  // The private listing card and tray ("list items to reserve").
  const listing = createListingFlow({ catalog, adapters, llm, catalogText, trayStore, now, withMentions });

  // Replies in the thread under the member's message.
  function threadSay(client, channel, threadTs) {
    const post = (text, extra = {}) => client.chat.postMessage({ channel, text, ...BOT_PERSONA, ...(threadTs ? { thread_ts: threadTs } : {}), ...extra });
    return { channel, threadTs, cardTs: null, done: (text) => post(text), prompt: (text, blocks) => post(text, { blocks }) };
  }

  // A card's outcome replaces the card. The connect prompt is for the
  // requester alone, so it is ephemeral.
  function cardSay(client, { channel, threadTs, cardTs, user }) {
    return {
      channel, threadTs, cardTs,
      done: (text) => client.chat.update({ channel, ts: cardTs, ...closedMessage(text) }),
      booked: (text, ref, req) => client.chat.update({ channel, ts: cardTs, ...bookedMessage({ user, text, ref, req }) }),
      prompt: (text, blocks) => client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text, blocks, ...BOT_PERSONA }),
    };
  }

  // A booked card's cancel outcomes keep its ✅ summary line above them, for
  // the record. A passing failure leaves the card and its button as they are.
  function bookedCardSay(client, { channel, threadTs, cardTs, user, summary }) {
    const say = cardSay(client, { channel, threadTs, cardTs, user });
    return {
      ...say,
      done: (text) => say.done(summary ? `${summary}\n${text}` : text),
      failed: (text) => client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text, ...BOT_PERSONA }),
    };
  }

  function updateCard(client, { channel, cardTs, user, req, assessment }) {
    return client.chat.update({ channel, ts: cardTs, ...cardMessage({ user, req, assessment }) });
  }

  // The card as it stands now, not as it was when the button was pressed.
  async function readCard(client, channel, threadTs, cardTs) {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
    return (res.messages || []).find((m) => m.ts === cardTs) || null;
  }

  function conflictText(req, conflicts) {
    const names = req.items.map((i) => i.label).join(", ");
    return `❌ ${names} is taken ${fmtDay(req.date)}:\n${conflicts.map(reservationLine).join("\n")}\nPlease check with them.`;
  }

  function forbiddenText(adapter, req, verb = "book") {
    if (adapter.backend === "rooms") return `You don't have edit access to the room request sheet. Ask ${CATEGORY_OWNERS.rooms} to share it with you: ${adapter.link}`;
    if (adapter.backend === "kitchen") return `You don't have edit access to the kitchen sheet. Ask ${CATEGORY_OWNERS.kitchen} to share it with you: ${adapter.link}`;
    const names = req.items.map((i) => i.label).join(", ");
    return `Google Calendar won't let your account ${verb} ${names || "that booking"}. Ask ${req.items[0] ? ownerFor(req.items[0]) : "the equipment team"}.`;
  }

  // What a card shows: whether the request can be booked as it stands.
  async function assess(req, client) {
    if (req.ambiguous.length) return { state: "ambiguous", ambiguous: req.ambiguous };
    if (req.date && req.date < nyToday(now())) return { state: "past" };
    const missing = missingFields(req);
    if (missing.length) return { state: "missing", missing };
    const backends = [...new Set(req.items.map((i) => i.backend))];
    if (backends.length > 1) return { state: "mixed" };
    const adapter = adapters[backends[0]];
    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    return conflicts.length ? { state: "taken", conflicts, adapter } : { state: "free", adapter };
  }

  async function requesterFor(client, user) {
    const info = await client.users.info({ user });
    const profile = info.user?.profile || {};
    return {
      requesterName: profile.display_name || info.user?.real_name || "Someone",
      requesterUserId: user,
      phone: profile.phone || "",
      slackEmail: profile.email || null,
    };
  }

  // The pending row holds what to do once the member approves; resume reads it.
  async function promptConnect({ request, requester, say, text, noEmail }) {
    if (!requester.slackEmail) return noEmail(`I can't see an email on your Slack profile, so I can't connect your Google account.`);
    const { nonce } = await connect.authStore.createPending({
      slackUserId: requester.requesterUserId, slackEmail: requester.slackEmail,
      request, channel: say.channel, threadTs: say.threadTs,
    });
    const url = connect.consentUrl({ state: nonce, loginHint: requester.slackEmail });
    await say.prompt(text, [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [{ type: "button", action_id: "reservations_connect_google", style: "primary", text: { type: "plain_text", text: "Connect Google" }, url }] },
    ]);
  }

  function promptBookConnect({ req, adapter, requester, say, revoked }) {
    return promptConnect({
      request: { req, requester, backend: adapter.backend, cardTs: say.cardTs }, requester, say,
      text: revoked
        ? "Your Google connection has expired. Connect again and I'll finish this booking as you."
        : "To book as you, connect your Google account once. I'll finish this booking as soon as you approve.",
      noEmail: (text) => say.done(`${text} You can book directly: ${adapter.link}`),
    });
  }

  async function promptCancelConnect({ ref, adapter, user, say, client, revoked }) {
    const requester = await requesterFor(client, user);
    return promptConnect({
      request: { kind: "cancel", ref, requester, cardTs: say.cardTs, responseUrl: say.responseUrl ?? null }, requester, say,
      text: revoked
        ? "Your Google connection has expired. Connect again and I'll cancel this booking as you."
        : "To cancel as you, connect your Google account once. I'll cancel this booking as soon as you approve.",
      noEmail: (text) => (say.failed || say.done)(`${text} You can cancel it directly: ${adapter.link}`),
    });
  }

  // Whose Google account a write uses: the bot's when connect isn't set up,
  // otherwise the member's, who may first need to connect (again).
  async function memberClients(user) {
    if (!connect) return { status: "bot" };
    const member = await connect.memberGoogle.clientsFor(user);
    if (member.status === "active") return { status: "active", clients: member.clients };
    return { status: member.status === "revoked" ? "revoked" : "none" };
  }

  async function finishBooking({ req, adapter, requester, say, bookingKey = null }) {
    const member = await memberClients(requester.requesterUserId);
    if (member.status === "none" || member.status === "revoked") {
      return promptBookConnect({ req, adapter, requester, say, revoked: member.status === "revoked" });
    }
    const { clients } = member;
    const booking = {
      date: req.date, start: req.start, end: req.end, items: req.items, title: req.title, ministry: req.ministry,
      requesterName: requester.requesterName, requesterUserId: requester.requesterUserId, phone: requester.phone,
      appliances: req.appliances,
    };
    // An earlier delivery of this same press already started writing: it
    // timed out or crashed after book began. Writing again could book twice.
    if (bookingKey && claimBooking && !(await claimBooking(bookingKey))) {
      log.warn("booking already attempted", { bookingKey, backend: adapter.backend });
      return say.done(`I may already have booked this. Please check before booking again: ${adapter.link}`);
    }
    let result;
    try {
      result = clients ? await adapter.book(booking, { clients }) : await adapter.book(booking);
    } catch (error) {
      const kind = clients ? classifyWriteError(error) : "error";
      if (kind === "revoked") {
        await connect.authStore.markRevoked(requester.requesterUserId);
        connect.memberGoogle.forget(requester.requesterUserId);
        return promptBookConnect({ req, adapter, requester, say, revoked: true });
      }
      if (kind === "forbidden") return say.done(forbiddenText(adapter, req));
      metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
      log.error("reservation write failed", { backend: adapter.backend, error });
      return say.done(`⚠️ I couldn't save that booking (${error.message}). Please book it directly: ${adapter.link}`);
    }
    if (result.status !== "booked") {
      return say.done(`${result.reason} You can book it here: ${result.link}`);
    }
    metric("ReservationBooked", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend, asMember: !!clients } });
    const names = req.items.map((i) => i.label).join(", ");
    const note = req.items.some((i) => i.category === "tech") ? `\n${TECH_NOTE}` : "";
    // The booking is written. Failing the event now would make SQS retry it
    // and book again, so a failed confirmation or digest edit is logged, never rethrown.
    const text = `✅ ${names} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)} · ${req.title} · <@${requester.requesterUserId}>\n<${result.link}|Open the booking>${note}`;
    try {
      await (result.ref && say.booked ? say.booked(text, result.ref, req) : say.done(text));
    } catch (error) {
      log.error("reservation confirmation failed", { backend: adapter.backend, error });
    }
    if (result.ref) {
      try {
        await ledger?.recordBooking(requester.requesterUserId, result.ref, { today: nyToday(now()) });
      } catch (error) {
        log.error("booking ledger write failed", { backend: adapter.backend, error });
      }
    }
    try {
      await livingDigest?.refresh(req.date);
    } catch (error) {
      log.error("digest refresh failed", { date: req.date, error });
    }
  }

  function hasEnded(ref) {
    const today = nyToday(now());
    if (ref.date !== today) return ref.date < today;
    return (ref.end ?? 1440) <= nyParts(now().toISOString()).min;
  }

  // One cancel as `clients` (the member's), or as the bot when there are
  // none. A calendar event the bot organized is always the bot's to cancel;
  // one on a member's calendar can't be without their account. Never throws:
  // the outcome is { status: cancelled|already|changed|revoked|forbidden|
  // unsupported|error, link, error? }.
  async function cancelOne({ ref, user, clients = null }) {
    const adapter = adapters[ref?.backend];
    if (!adapter) return { status: "error", link: null, error: new Error(`no ${ref?.backend} backend`) };
    const botsOwnEvent = ref.backend === "rms" && ref.organizerSelf;
    const as = botsOwnEvent ? null : clients;
    if (ref.backend === "rms" && !botsOwnEvent && !as) return { status: "unsupported", link: adapter.link };
    let result;
    try {
      result = as ? await adapter.cancel(ref, { clients: as }) : await adapter.cancel(ref);
    } catch (error) {
      const kind = as ? classifyWriteError(error) : "error";
      if (kind === "error") {
        metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend, stage: "cancel" } });
        log.error("reservation cancel failed", { backend: adapter.backend, user, error });
      }
      return { status: kind, link: adapter.link, error };
    }
    if (result.status === "cancelled") {
      metric("ReservationCancelled", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
      return { status: "cancelled", link: result.link };
    }
    return { status: result.status === "already" ? "already" : "changed", link: result.link };
  }

  // What a cancel's outcome tells the member.
  function cancelText(ref, out, user) {
    const adapter = adapters[ref.backend];
    switch (out.status) {
      case "cancelled": return `🚫 Booking cancelled by <@${user}>.`;
      case "already": return "That booking was already cancelled.";
      case "changed": return `I couldn't find that booking as it was; it may have been changed. Please check it here: ${out.link}`;
      case "unsupported": return `I can't cancel that one from here. Please cancel it in Google Calendar: ${adapter.link}`;
      case "forbidden": {
        const items = (Array.isArray(ref.resources) ? ref.resources : []).map((id) => catalog.find((e) => e.calendarId === id)).filter(Boolean);
        return forbiddenText(adapter, { items }, "cancel");
      }
      default: return `⚠️ I couldn't cancel that (${out.error?.message}). Please try again, or cancel it here: ${adapter.link}`;
    }
  }

  // Undo a booking the bot made. Shared by the booked card and the "mine"
  // list: say.done takes the outcome, say.failed (if given) a passing failure.
  async function cancelBooking({ ref, user, say, client }) {
    const adapter = adapters[ref.backend];
    if (!adapter) return;
    if (hasEnded(ref)) return say.done(ENDED_TEXT);
    const botsOwnEvent = ref.backend === "rms" && ref.organizerSelf;
    // An event on the member's own calendar needs their account; the bot's can't delete it.
    if (ref.backend === "rms" && !botsOwnEvent && !connect) return say.done(cancelText(ref, { status: "unsupported" }, user));
    let clients = null;
    if (connect && !botsOwnEvent) {
      const member = await memberClients(user);
      if (member.status !== "active") {
        return promptCancelConnect({ ref, adapter, user, say, client, revoked: member.status === "revoked" });
      }
      clients = member.clients;
    }
    const out = await cancelOne({ ref, user, clients });
    if (out.status === "revoked") {
      await connect.authStore.markRevoked(user);
      connect.memberGoogle.forget(user);
      return promptCancelConnect({ ref, adapter, user, say, client, revoked: true });
    }
    if (out.status === "error") return (say.failed || say.done)(cancelText(ref, out, user));
    if (out.status !== "cancelled") return say.done(cancelText(ref, out, user));
    // Cancelled. As after a booking, a failed reply or digest edit is logged,
    // so an SQS retry doesn't run the cancel again.
    try {
      await say.done(cancelText(ref, out, user));
    } catch (error) {
      log.error("cancel confirmation failed", { backend: adapter.backend, error });
    }
    try {
      await livingDigest?.refresh(ref.date);
    } catch (error) {
      log.error("digest refresh failed", { date: ref.date, error });
    }
  }

  async function resumeCancel(pending, client) {
    const { ref, requester, cardTs } = pending.request;
    if (!adapters[ref?.backend]) return;
    const user = requester.requesterUserId;
    const { channel } = pending;
    const threadTs = pending.threadTs || null;
    try {
      const card = cardTs ? await readCard(client, channel, threadTs, cardTs).catch(() => null) : null;
      // No card means the cancel came from the private "mine" list: the
      // outcome is for the member alone, never posted in public.
      const say = cardTs
        ? bookedCardSay(client, { channel, threadTs, cardTs, user, summary: cardSummaryLine(card) })
        : privateSay(client, { channel, user, responseUrl: pending.request.responseUrl ?? null });
      await cancelBooking({ ref, user, say, client });
    } catch (error) {
      // The pending row is gone; a rethrow would retry into nothing.
      log.error("resuming a cancel failed", { backend: ref.backend, error });
    }
  }

  // Private answers in the channel, with no thread: for the "mine" list.
  function privateSay(client, { channel, user, responseUrl = null }) {
    const tell = (text, blocks) => client.chat.postEphemeral({ channel, user, text, ...(blocks ? { blocks } : {}), ...BOT_PERSONA });
    return { channel, threadTs: null, cardTs: null, responseUrl, done: (text) => tell(text), failed: (text) => tell(text), prompt: tell };
  }

  function mineLinks() {
    return { rooms: adapters.rooms?.link, kitchen: adapters.kitchen?.link, calendar: adapters.rms?.link };
  }

  async function memberFor(client, user) {
    const info = await client.users.info({ user });
    const profile = info.user?.profile || {};
    return { userId: user, realName: info.user?.real_name || "", displayName: profile.display_name || "", email: profile.email || "", phone: profile.phone || "" };
  }

  // The asker's upcoming bookings across every backend, today through 60
  // days out. A backend that fails leaves the rest standing, flagged partial.
  async function listMine({ user, client }) {
    const today = nyToday(now());
    const member = await memberFor(client, user);
    let ledgerKeys = new Set();
    try {
      ledgerKeys = new Set(((await ledger?.bookingsFor(user, { today })) ?? []).map(refKey));
    } catch (error) {
      log.error("booking ledger read failed", { error });
    }
    // A booked repeat series is one entry, whatever its span; its dates
    // aren't listed again one by one.
    let series = [];
    try {
      series = (await ledger?.seriesFor?.(user, { today })) ?? [];
    } catch (error) {
      log.error("series ledger read failed", { error });
    }
    const seriesKeys = new Set(series.flatMap((s) => s.refs.map(refKey)));
    const seriesEntries = series
      .map((s) => ({ s, live: s.refs.filter((r) => !hasEnded(r)) }))
      .filter(({ live }) => live.length)
      .map(({ s, live }) => ({
        series: true, seriesId: s.id, item: s.item, repeat: s.repeat, count: live.length, start: s.start, end: s.end, title: s.title,
      }));
    let partial = false;
    const lists = await Promise.all(Object.values(adapters).map(async (adapter) => {
      try {
        const { reservations, errors } = await adapter.listReservations({ from: today, to: addDaysIso(today, MINE_DAYS) });
        if (errors?.length) partial = true;
        return reservations;
      } catch (error) {
        partial = true;
        log.warn("listing my reservations failed", { backend: adapter.backend, error });
        return [];
      }
    }));
    // RMS lists an event once per resource calendar; one event is one line.
    const byEvent = new Map();
    const entries = [];
    for (const r of lists.flat()) {
      if (!r.ref || hasEnded(r) || hasRefKey(seriesKeys, r.ref) || !isMine(r, member, ledgerKeys)) continue;
      const { backend } = r.ref;
      const same = backend === "rms" ? byEvent.get(r.ref.eventId) : null;
      if (same) {
        for (const id of r.ref.resources || []) if (!same.ref.resources.includes(id)) same.ref.resources.push(id);
        if (!same.items.includes(r.item)) same.items.push(r.item);
        continue;
      }
      const entry = {
        items: [r.item], date: r.date, start: r.start, end: r.end, title: r.title, holderName: r.holderName,
        ref: backend === "rms" ? { ...r.ref, resources: [...(r.ref.resources || [])] } : r.ref,
        matchedBy: (backend === "rooms" || backend === "kitchen") && !hasRefKey(ledgerKeys, r.ref) ? backend : null,
        // Without connect, the bot can't touch an event on the member's own calendar.
        openLink: !connect && backend === "rms" && !r.ref.organizerSelf ? calendarLink(r.ref.resources?.[0] ?? "") : null,
      };
      if (backend === "rms") byEvent.set(r.ref.eventId, entry);
      entries.push(entry);
    }
    const sorted = entries
      .map(({ items, ...e }) => ({ ...e, item: items.join(", ") }))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? -1) - (b.start ?? -1));
    const all = [...seriesEntries, ...sorted];
    return { entries: all.slice(0, MINE_CAP), more: Math.max(0, all.length - MINE_CAP), partial };
  }

  async function postMine({ channel, user, client }) {
    const mine = await listMine({ user, client });
    return client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, ...mineMessage({ user, ...mine, links: mineLinks() }) });
  }

  // Ephemeral messages can't be chat.update'd; the list is replaced through
  // the press's response_url, rebuilt fresh with the outcome on top.
  async function replaceMine({ responseUrl, user, client, notice }) {
    let message;
    try {
      message = mineMessage({ user, ...(await listMine({ user, client })), links: mineLinks(), notice });
    } catch (error) {
      log.error("refreshing my reservations failed", { error });
      message = { text: notice };
    }
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replace_original: true, ...message }),
    });
    if (!res.ok) log.warn("replacing my reservations failed", { status: res.status });
  }

  // Cancel on a line of the "mine" list. Only the member it was built for
  // may press it; the list has no thread, so every answer is private.
  async function cancelFromList({ payload, action, client }) {
    const picked = decodeRef(action.value);
    if (!picked || !adapters[picked.ref.backend]) return;
    const channel = payload.channel?.id || payload.container?.channel_id;
    const userId = payload.user?.id;
    const say = privateSay(client, { channel, user: userId, responseUrl: payload.response_url ?? null });
    if (userId !== picked.user) return say.done(`Only <@${picked.user}> can cancel this.`);
    if (hasEnded(picked.ref)) return say.done(ENDED_TEXT);
    if (say.responseUrl) {
      const replace = (notice) => replaceMine({ responseUrl: say.responseUrl, user: userId, client, notice });
      say.done = replace;
      say.failed = replace;
    }
    return cancelBooking({ ref: picked.ref, user: userId, say, client });
  }

  // Reserve all: books the member's whole tray in one press.
  const reserveAll = createReserveAll({
    adapters, catalog, connect, ledger, trayStore, livingDigest, now, requesterFor, promptConnect, withMentions,
    memberClients, classifyWriteError, forbiddenText, renderListing: listing.listingFor,
  });

  // Cancel from the combined post: one line, a whole series, or one date.
  const seriesFlow = createSeriesFlow({
    adapters, ledger, connect, livingDigest, now, cancelOne, memberClients, promptConnect, hasEnded, requesterFor, cancelText,
  });

  async function resume({ pendingId, client }) {
    if (!connect) return;
    const pending = await connect.authStore.getPending(pendingId);
    if (!pending) return;
    // Deleted before booking: an SQS retry of this message finds nothing and
    // can never book twice.
    await connect.authStore.deletePending(pendingId);
    if (pending.request.kind === "cancel") return resumeCancel(pending, client);
    if (pending.request.kind === "series-cancel") return seriesFlow.resume(pending, client);
    if (pending.request.kind === "tray") {
      try {
        return await reserveAll.resume({ ...pending, pendingId }, client);
      } catch (error) {
        // The pending row is gone; a rethrow would retry into nothing.
        log.error("resuming reserve all failed", { error });
        try {
          await client.chat.postEphemeral({
            channel: pending.request.channel || pending.channel, user: pending.request.user || pending.slackUserId, ...BOT_PERSONA,
            text: `⚠️ I couldn't reserve your tray after you connected (${error.message}). Please press Reserve all again.`,
          });
        } catch (replyError) {
          log.error("resume failure reply failed", { error: replyError });
        }
        return;
      }
    }
    const { req, requester, backend, cardTs } = pending.request;
    const adapter = adapters[backend];
    if (!adapter) return;
    // Rows saved before cards (DM requests) have no card to update.
    const say = cardTs
      ? cardSay(client, { channel: pending.channel, threadTs: pending.threadTs, cardTs, user: requester.requesterUserId })
      : threadSay(client, pending.channel, pending.threadTs || null);
    // The pending row is gone, so a thrown error here would be retried into
    // nothing. The member was told "booking is being made", so say so instead.
    try {
      const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
      if (conflicts.length) {
        if (!cardTs) return say.done(conflictText(req, conflicts));
        const full = { ambiguous: [], unmatched: [], toDate: null, ...req };
        return updateCard(client, { channel: pending.channel, cardTs, user: requester.requesterUserId, req: full, assessment: { state: "taken", conflicts } });
      }
      return await finishBooking({ req, adapter, requester, say });
    } catch (error) {
      metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend, stage: "resume" } });
      log.error("resuming a booking failed", { backend: adapter.backend, error });
      try {
        await say.done(`⚠️ I couldn't finish this booking after you connected (${error.message}). Please send it again, or book directly: ${adapter.link}`);
      } catch (replyError) {
        log.error("resume failure reply failed", { error: replyError });
      }
    }
  }

  // Private reply to /reservations-disconnect; falls back to response_url
  // when the command came from a channel or DM the bot can't post in.
  async function tellPrivately({ userId, channel, client, responseUrl, text }) {
    try {
      await client.chat.postEphemeral({ channel, user: userId, text, ...BOT_PERSONA });
    } catch (error) {
      if (!responseUrl) throw error;
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", text }),
      });
    }
  }

  async function disconnect({ userId, channel, client, responseUrl }) {
    if (!connect) return;
    const had = await connect.memberGoogle.revoke(userId);
    const text = had ? "Disconnected your Google account. Bookings will ask you to connect again." : "Your Google account wasn't connected.";
    return tellPrivately({ userId, channel, client, responseUrl, text });
  }

  // "Who has the Transit?" with no period: each item's next booking that
  // hasn't finished yet, up to six months out.
  async function nextUpcoming(req, say, client, today) {
    const nowMin = nyParts(now().toISOString()).min;
    const horizon = addDaysIso(today, 180);
    const blocks = [];
    for (const item of req.items) {
      const adapter = adapters[item.backend];
      if (!adapter) continue;
      const { reservations } = await adapter.listReservations({ from: today, to: horizon, items: [item] });
      const upcoming = reservations
        .filter((r) => r.date > today || (r.end ?? 1440) > nowMin)
        .sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? -1) - (b.start ?? -1));
      if (upcoming.length === 0) {
        blocks.push(`No upcoming reservations for ${item.label}.`);
        continue;
      }
      const [next] = await withMentions(client, [upcoming[0]]);
      blocks.push(`Next up for ${item.label}, ${fmtDay(next.date)}:\n${reservationLine(next)}`);
    }
    return say.done(blocks.join("\n\n"));
  }

  // "What speakers are there?": the model names the fitting items; they are
  // checked against the catalog, grouped, and capped so the reply stays short.
  function find(req, say) {
    if (req.items.length === 0) {
      return say.done(`Nothing matches that. I can book: ${categoryCounts(catalog)}. Try describing it another way.`);
    }
    const shown = req.items.slice(0, FIND_CAP);
    const lines = Object.entries(CATEGORY_NAMES)
      .map(([id, name]) => [name, shown.filter((i) => i.category === id).map((i) => i.label)])
      .filter(([, labels]) => labels.length > 0)
      .map(([name, labels]) => `${name}: ${labels.join(", ")}`);
    const more = req.items.length > FIND_CAP ? `\n+${req.items.length - FIND_CAP} more. Try a narrower word.` : "";
    return say.done(`${lines.join("\n")}${more}\nTo book one, post its name, the day, the time and what it's for.`);
  }

  async function handleQuery(req, say, client) {
    const groups = req.items.length ? [...new Set(req.items.map((i) => i.backend))] : Object.keys(adapters);
    if (req.intent === "check" && req.items.length && req.date && req.start != null) {
      const found = [];
      for (const backend of groups) {
        found.push(...await adapters[backend].findConflicts({
          date: req.date, start: req.start, end: req.end, items: req.items.filter((i) => i.backend === backend),
        }));
      }
      const hits = await withMentions(client, found);
      const names = req.items.map((i) => i.label).join(", ");
      return say.done(hits.length
        ? `${names} is taken ${fmtDay(req.date)}:\n${hits.map(reservationLine).join("\n")}`
        : `${names} is free ${fmtDay(req.date)}, ${fmtRange(req.start, req.end)}.`);
    }
    const today = nyToday(now());
    if (!req.date && !req.toDate && req.items.length) return nextUpcoming(req, say, client, today);
    // A named day means that day; nothing named and no items means the next two weeks.
    const from = req.date || today;
    const to = req.toDate || (req.date ? from : addDaysIso(today, 13));
    const found = [];
    for (const backend of groups) {
      if (!adapters[backend]) continue;
      const { reservations } = await adapters[backend].listReservations({ from, to, items: req.items.filter((i) => i.backend === backend) });
      found.push(...reservations);
    }
    if (found.length === 0) {
      const span = from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
      const what = req.items.length ? ` for ${req.items.map((i) => i.label).join(", ")},` : "";
      return say.done(`Nothing booked${what} ${span}.`);
    }
    const people = await withMentions(client, found);
    const days = [...new Set(people.map((r) => r.date))].sort();
    const text = days.map((d) => [`*${fmtDay(d)}*`, ...people.filter((r) => r.date === d).sort((a, b) => (a.start ?? -1) - (b.start ?? -1)).map(reservationLine)].join("\n")).join("\n\n");
    return say.done(text);
  }

  function parse(text) {
    const today = nyToday(now());
    return llm.parseReservationRequest(`Member: ${text}`, { catalogText, today, weekday: weekdayName(today) });
  }

  // A top-level message in #reservations. Thread replies belong to people.
  async function handleMessage({ event, client }) {
    // file_share is a message posted with an attachment; its text still counts.
    if (event.channel !== channelId || event.thread_ts || event.bot_id || (event.subtype && event.subtype !== "file_share")) return;
    const text = String(event.text || "").trim();
    if (isIgnorableChatter(text)) return;
    // An SQS redelivery: the bot already answered in this message's thread.
    // If this read fails, the event fails and SQS retries it, rather than risk a second card.
    const thread = await client.conversations.replies({ channel: event.channel, ts: event.ts, limit: 20 });
    if ((thread.messages || []).some((m) => m.bot_id && m.ts !== event.ts)) {
      log.info("reservation message already answered", { channel: event.channel, ts: event.ts });
      return;
    }
    const say = threadSay(client, event.channel, event.ts);
    return answer({ text, user: event.user, channel: event.channel, say, client, threadTs: event.ts });
  }

  // Someone joined #reservations: tell them, privately, how it works. Once per
  // member a year, so a redelivery or leaving and rejoining doesn't repeat it.
  async function handleMemberJoined({ event, client }) {
    if (event.channel !== channelId || !event.user || !claimOnce) return;
    if (!(await claimOnce(`welcome:${event.user}`, WELCOME_TTL_S))) return;
    try {
      await client.chat.postEphemeral({ channel: channelId, user: event.user, text: WELCOME_TEXT, ...BOT_PERSONA });
      metric("ReservationsWelcomed", 1, { dimensions: { Flow: "reservations" } });
    } catch (error) {
      log.warn("reservations welcome failed", { user: event.user, error });
    }
  }

  // A question asked in the open could have been asked privately. Never
  // fails the event: the answer is already posted and must not be repeated.
  async function tipCommand({ user, channel, threadTs, client }) {
    if (!claimOnce) return;
    try {
      if (!(await claimOnce(`tip:${user}`, TIP_TTL_S))) return;
      await client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text: COMMAND_TIP, ...BOT_PERSONA });
    } catch (error) {
      log.warn("reservations /reserve tip failed", { user, error });
    }
  }

  // /reserve: the same questions as chatting in the channel, but nobody else
  // sees them and every answer is private. Booking itself stays in the
  // channel (a public card) or on the listing card.
  async function handleCommand({ userId, channel, text, client, responseUrl }) {
    const tell = (t) => tellPrivately({ userId, channel, client, responseUrl, text: t });
    if (channel !== channelId) return tell(`Use /reserve in <#${channelId}>.`);
    const asked = String(text || "").trim();
    if (!asked) return listing.post({ channel, user: userId, search: null, client });
    const say = privateSay(client, { channel, user: userId, responseUrl });
    return answer({ text: asked, user: userId, channel, say, client, threadTs: null });
  }

  // threadTs is the member's message for a chat; null for /reserve, which
  // answers questions only.
  async function answer({ text, user, channel, say, client, threadTs }) {
    const raw = await parse(text);
    if (!raw) return say.done("Sorry, I couldn't read that. Please try again.");
    const req = normalizeRequest(raw, catalog);
    const result = await route({ req, text, user, channel, say, client, threadTs });
    if (threadTs && QUESTION_INTENTS.has(req.intent)) await tipCommand({ user, channel, threadTs, client });
    return result;
  }

  async function route({ req, text, user, channel, say, client, threadTs }) {
    if (req.intent === "other") return threadTs ? undefined : say.done(COMMAND_HELP);
    if (req.intent === "mine") return postMine({ channel, user, client });
    if (req.intent === "browse") return listing.post({ channel, user, search: req.search, client });
    // "Sat 2-4" is afternoon. The model is told so, but a small-hours time
    // nobody wrote "am" for is asked about rather than booked at 2 AM.
    if (req.start != null && req.start < 7 * 60 && !/\d\s*(am|a\.m\.)|morning|sunrise/i.test(text)) {
      req.start = null;
      req.end = null;
    }

    if (req.intent === "find") return find(req, say);
    if (req.unmatched.length && req.items.length === 0 && req.ambiguous.length === 0) {
      return say.done(`I don't know "${req.unmatched.join('", "')}". I can book rooms, the kitchen, tech sets, vehicles, and sports, outreach and accessories equipment.`);
    }
    if (req.intent === "check" || req.intent === "list") {
      if (req.ambiguous.length) {
        const a = req.ambiguous[0];
        return say.done(`Which one did you mean by "${a.phrase}": ${a.options.map((o) => o.label).join(", ")}? Ask again with its name.`);
      }
      return handleQuery(req, say, client);
    }
    if (!threadTs) return say.done(COMMAND_BOOK_TEXT);

    const assessment = await assess(req, client);
    await client.chat.postMessage({ channel, thread_ts: threadTs, ...BOT_PERSONA, ...cardMessage({ user, req, assessment }) });
  }

  // Book, Cancel or Cancel booking on a card, or anyone but the requester
  // pressing a card button. The requester's Edit is opened by the receiver,
  // which has the trigger_id.
  async function handleCardAction({ payload, client }) {
    const reserve = (payload.actions || []).find((a) => a.action_id === TRAY_RESERVE_ACTION);
    if (reserve) {
      // The press's action_ts names the run: an SQS redelivery of this press carries the same one.
      return reserveAll.run({
        user: payload.user?.id, channel: payload.channel?.id || payload.container?.channel_id, client,
        runId: String(reserve.action_ts || payload.trigger_id || `gen-${randomBytes(8).toString("hex")}`), responseUrl: payload.response_url ?? null,
      });
    }
    const listed = (payload.actions || []).find((a) => listing.ACTIONS.has(a.action_id));
    if (listed) return listing.handleAction({ payload, action: listed, client });
    const seriesAction = (payload.actions || []).find((a) => seriesFlow.ACTIONS.has(a.action_id));
    if (seriesAction) return seriesFlow.handleAction({ payload, action: seriesAction, client });
    const action = (payload.actions || []).find((a) => CARD_ACTIONS.has(a.action_id));
    if (!action) return;
    if (action.action_id === MINE_CANCEL_ACTION) return cancelFromList({ payload, action, client });
    const channel = payload.channel?.id || payload.container?.channel_id;
    const cardTs = payload.container?.message_ts || payload.message?.ts;
    const threadTs = payload.message?.thread_ts || cardTs;
    const userId = payload.user?.id;
    const privately = (text) => client.chat.postEphemeral({ channel, user: userId, thread_ts: threadTs, text, ...BOT_PERSONA });

    if (action.action_id === CANCEL_BOOKING_ACTION) {
      const booked = decodeRef(action.value);
      if (!booked || !adapters[booked.ref.backend]) return;
      if (userId !== booked.user) return privately(`Only <@${booked.user}> can cancel this.`);
      if (hasEnded(booked.ref)) return privately(ENDED_TEXT);
      // As with Book: a second press, or a redelivery after the card was
      // updated, finds the button gone.
      const current = await readCard(client, channel, threadTs, cardTs);
      if (cancelBookingValue(current) !== action.value) {
        log.info("stale reservation cancel press", { channel, cardTs });
        return;
      }
      const say = bookedCardSay(client, { channel, threadTs, cardTs, user: userId, summary: cardSummaryLine(current) });
      return cancelBooking({ ref: booked.ref, user: userId, say, client });
    }

    const card = decodeCard(action.value, catalog);
    if (!card) return;
    if (userId !== card.user) {
      return privately(`Only <@${card.user}> can ${action.action_id === CANCEL_ACTION ? "cancel" : "book"} this.`);
    }
    if (action.action_id === CANCEL_ACTION) {
      if (!isOpenCard(await readCard(client, channel, threadTs, cardTs))) return;
      return cardSay(client, { channel, threadTs, cardTs, user: userId }).done(`🚫 Cancelled by <@${userId}>.`);
    }
    if (action.action_id !== BOOK_ACTION) return;
    if (card.lost.length) {
      return cardSay(client, { channel, threadTs, cardTs, user: card.user })
        .done(`I can't book "${card.lost.join('", "')}" any more. Please post the request again.`);
    }
    // A member's presses run one at a time, so a second press finds the card
    // already closed. A press on a card since edited carries an old value.
    const current = await readCard(client, channel, threadTs, cardTs);
    if (openBookValue(current) !== action.value) {
      log.info("stale reservation card press", { channel, cardTs });
      return;
    }
    const assessment = await assess(card.req, client);
    if (assessment.state !== "free") {
      return updateCard(client, { channel, cardTs, user: card.user, req: card.req, assessment });
    }
    const requester = await requesterFor(client, card.user);
    const say = cardSay(client, { channel, threadTs, cardTs, user: card.user });
    return finishBooking({ req: card.req, adapter: assessment.adapter, requester, say, bookingKey: `card:${channel}:${cardTs}` });
  }

  // The Edit modal was submitted: the card shows the new details. Nothing is booked.
  async function handleModalSubmit({ payload, client }) {
    if (payload.view?.callback_id !== MODAL_CALLBACK) return;
    const { user, channel, threadTs, cardTs, req } = readEditModal(payload.view, catalog);
    if (!user || payload.user?.id !== user || !channel || !cardTs) return;
    const current = await readCard(client, channel, threadTs, cardTs);
    if (!isOpenCard(current)) {
      return client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text: "That request is already finished. Post a new message to book again.", ...BOT_PERSONA });
    }
    const assessment = await assess(req, client);
    await updateCard(client, { channel, cardTs, user, req, assessment });
  }

  return { channelId, handleMessage, handleMemberJoined, handleCommand, handleCardAction, handleModalSubmit, resume, disconnect };
}
