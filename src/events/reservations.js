// src/events/reservations.js
// Reservations: members post plain messages in #reservations and the bot
// replies in each message's thread, first come first served. Questions get an
// answer. A booking request gets a card (what the bot understood, free or not,
// Book and Edit); the request rides in the card's buttons, so nothing is
// stored. Book writes; Edit's modal only updates the card. A booked or refused
// card is replaced by its outcome, with no buttons left.
import { log, metric } from "../lib/logger.js";
import { nyToday, nyParts, addDaysIso, weekdayName, fmtDay, fmtRange } from "../lib/reservation-time.js";
import { catalogPromptText, categoryCounts, CATEGORY_NAMES, CATEGORY_OWNERS, ownerFor } from "../lib/reservation-catalog.js";
import { isInvalidGrant, isForbidden, isScopeMissing } from "../services/memberGoogle.js";
import { normalizeRequest, missingFields, isIgnorableChatter } from "../lib/reservation-request.js";
import { reservationLine, BOT_PERSONA } from "../lib/reservation-format.js";
import { cardMessage, closedMessage, decodeCard, openBookValue, isOpenCard, BOOK_ACTION, EDIT_ACTION } from "../lib/reservation-card.js";
import { readEditModal, MODAL_CALLBACK } from "../lib/reservation-modal.js";

const TECH_NOTE = "Reminder: the booking covers the ENTIRE time you hold the set. Return it to the tech room and charge the speaker and mic receivers after.";
export const FIND_CAP = 25;

export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date(), connect = null, livingDigest = null, claimBooking = null }) {
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
      prompt: (text, blocks) => client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text, blocks, ...BOT_PERSONA }),
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

  function forbiddenText(adapter, req) {
    if (adapter.backend === "rooms") return `You don't have edit access to the room request sheet. Ask ${CATEGORY_OWNERS.rooms} to share it with you: ${adapter.link}`;
    if (adapter.backend === "kitchen") return `You don't have edit access to the kitchen sheet. Ask ${CATEGORY_OWNERS.kitchen} to share it with you: ${adapter.link}`;
    const names = req.items.map((i) => i.label).join(", ");
    return `Google Calendar won't let your account book ${names}. Ask ${ownerFor(req.items[0])}.`;
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

  async function promptConnect({ req, adapter, requester, say, revoked }) {
    if (!requester.slackEmail) {
      return say.done(`I can't see an email on your Slack profile, so I can't connect your Google account. You can book directly: ${adapter.link}`);
    }
    const { nonce } = await connect.authStore.createPending({
      slackUserId: requester.requesterUserId, slackEmail: requester.slackEmail,
      request: { req, requester, backend: adapter.backend, cardTs: say.cardTs }, channel: say.channel, threadTs: say.threadTs,
    });
    const url = connect.consentUrl({ state: nonce, loginHint: requester.slackEmail });
    const text = revoked
      ? "Your Google connection has expired. Connect again and I'll finish this booking as you."
      : "To book as you, connect your Google account once. I'll finish this booking as soon as you approve.";
    await say.prompt(text, [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [{ type: "button", action_id: "reservations_connect_google", style: "primary", text: { type: "plain_text", text: "Connect Google" }, url }] },
    ]);
  }

  async function finishBooking({ req, adapter, requester, say, bookingKey = null }) {
    let clients;
    if (connect) {
      const member = await connect.memberGoogle.clientsFor(requester.requesterUserId);
      if (member.status !== "active") {
        return promptConnect({ req, adapter, requester, say, revoked: member.status === "revoked" });
      }
      clients = member.clients;
    }
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
      if (clients && (isInvalidGrant(error) || isScopeMissing(error))) {
        await connect.authStore.markRevoked(requester.requesterUserId);
        connect.memberGoogle.forget(requester.requesterUserId);
        return promptConnect({ req, adapter, requester, say, revoked: true });
      }
      if (clients && isForbidden(error)) return say.done(forbiddenText(adapter, req));
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
    try {
      await say.done(
        `✅ ${names} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)} · ${req.title} · <@${requester.requesterUserId}>\n<${result.link}|Open the booking>${note}`
      );
    } catch (error) {
      log.error("reservation confirmation failed", { backend: adapter.backend, error });
    }
    try {
      await livingDigest?.refresh(req.date);
    } catch (error) {
      log.error("digest refresh failed", { date: req.date, error });
    }
  }

  async function resume({ pendingId, client }) {
    if (!connect) return;
    const pending = await connect.authStore.getPending(pendingId);
    if (!pending) return;
    // Deleted before booking: an SQS retry of this message finds nothing and
    // can never book twice.
    await connect.authStore.deletePending(pendingId);
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
    const raw = await parse(text);
    if (!raw) return say.done("Sorry, I couldn't read that. Please try again.");
    const req = normalizeRequest(raw, catalog);
    if (req.intent === "other") return;
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

    const assessment = await assess(req, client);
    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, ...BOT_PERSONA, ...cardMessage({ user: event.user, req, assessment }) });
  }

  // Book on a card, or anyone but the requester pressing Book or Edit. The
  // requester's Edit is opened by the receiver, which has the trigger_id.
  async function handleCardAction({ payload, client }) {
    const action = (payload.actions || []).find((a) => a.action_id === BOOK_ACTION || a.action_id === EDIT_ACTION);
    if (!action) return;
    const card = decodeCard(action.value, catalog);
    if (!card) return;
    const channel = payload.channel?.id || payload.container?.channel_id;
    const cardTs = payload.container?.message_ts || payload.message?.ts;
    const threadTs = payload.message?.thread_ts || cardTs;
    const userId = payload.user?.id;
    if (userId !== card.user) {
      return client.chat.postEphemeral({ channel, user: userId, thread_ts: threadTs, text: `Only <@${card.user}> can book this.`, ...BOT_PERSONA });
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

  return { channelId, handleMessage, handleCardAction, handleModalSubmit, resume, disconnect };
}
