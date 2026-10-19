// src/events/reservations.js
// Reservations: members ask in plain English, in their DM with the bot, and it
// books first come first served. /reserve (or a plain DM with nothing open)
// posts a start marker; the conversation runs from there. It is stateless: each
// DM re-reads the history back to the marker and re-parses it whole, and the
// bot's closing reply carries CLOSED_METADATA so it is never acted on twice.
// #reservations itself holds only the living digests; its threads are ignored.
import { log, metric } from "../lib/logger.js";
import { openRequest, isEscape } from "../lib/dm-conversation.js";
import { nyToday, nyParts, addDaysIso, weekdayName, fmtDay, fmtRange } from "../lib/reservation-time.js";
import { catalogPromptText, categoryCounts, CATEGORY_NAMES, CATEGORY_OWNERS, ownerFor } from "../lib/reservation-catalog.js";
import { isInvalidGrant, isForbidden, isScopeMissing } from "../services/memberGoogle.js";
import { normalizeRequest, missingFields } from "../lib/reservation-request.js";
import { reservationLine, BOT_PERSONA, CLOSED_METADATA, REQUEST_EVENT_TYPE } from "../lib/reservation-format.js";

const TECH_NOTE = "Reminder: the booking covers the ENTIRE time you hold the set. Return it to the tech room and charge the speaker and mic receivers after.";
export const FIND_CAP = 25;
const USAGE = "Try `/reserve the MPR Sat 2–4pm for youth night`, `/reserve is Tech Set 2 free Friday 7pm?`, `/reserve what's booked this weekend?` or `/reserve what speakers are there?`";

export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date(), connect = null, livingDigest = null }) {
  const catalogText = catalogPromptText(catalog);

  // The start marker is the bot's post, but it carries the member's words.
  const line = (m) => (m.metadata?.event_type === REQUEST_EVENT_TYPE
    ? `Member: ${m.metadata.event_payload?.text || ""}`
    : `${m.bot_id ? "Bot" : "Member"}: ${m.text || ""}`);

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

  // ask leaves the request open for the member's answer; done closes it.
  // threadTs is only set for connect rows saved before replies moved to the DM.
  function makeSay(client, channel, threadTs = null) {
    const post = (text, extra) => client.chat.postMessage({
      channel, text, ...BOT_PERSONA, ...(threadTs ? { thread_ts: threadTs } : {}), ...extra,
    });
    return {
      channel,
      threadTs,
      ask: (text, extra = {}) => post(text, extra),
      done: (text) => post(text, { metadata: CLOSED_METADATA }),
    };
  }

  function postStartMarker(client, channel, userId, text) {
    return client.chat.postMessage({
      channel, text: `📅 You asked: ${text}`, ...BOT_PERSONA,
      metadata: { event_type: REQUEST_EVENT_TYPE, event_payload: { user: userId, text } },
    });
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

  async function promptConnect({ req, adapter, requester, say, revoked }) {
    if (!requester.slackEmail) {
      return say.done(`I can't see an email on your Slack profile, so I can't connect your Google account. You can book directly: ${adapter.link}`);
    }
    const { nonce } = await connect.authStore.createPending({
      slackUserId: requester.requesterUserId, slackEmail: requester.slackEmail,
      request: { req, requester, backend: adapter.backend }, channel: say.channel, threadTs: say.threadTs,
    });
    const url = connect.consentUrl({ state: nonce, loginHint: requester.slackEmail });
    const text = revoked
      ? "Your Google connection has expired. Connect again and I'll finish this booking as you."
      : "To book as you, connect your Google account once. I'll finish this booking as soon as you approve.";
    // The DM is private, so the button needn't be ephemeral.
    await say.ask(text, {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "actions", elements: [{ type: "button", action_id: "reservations_connect_google", style: "primary", text: { type: "plain_text", text: "Connect Google" }, url }] },
      ],
    });
  }

  async function finishBooking({ req, adapter, requester, say }) {
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
    const { req, requester, backend } = pending.request;
    const adapter = adapters[backend];
    if (!adapter) return;
    const say = makeSay(client, pending.channel, pending.threadTs || null);
    // The pending row is gone, so a thrown error here would be retried into
    // nothing. The member was told "booking is being made", so say so instead.
    try {
      const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
      if (conflicts.length) return say.done(conflictText(req, conflicts));
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

  // Private reply to a slash command; falls back to response_url when the
  // command came from a channel or DM the bot can't post in.
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

  // /reserve <text>: always a new request, in the member's DM. Posting to the
  // user id lands in the DM, and Slack answers with the DM's channel id.
  async function handleCommand({ envelope, client }) {
    const userId = envelope.user_id;
    const text = String(envelope.text || "").trim();
    const where = { userId, channel: envelope.channel_id, client, responseUrl: envelope.response_url };
    if (!text) return tellPrivately({ ...where, text: `${USAGE}\nI can book: ${categoryCounts(catalog)}.` });
    const posted = await postStartMarker(client, userId, userId, text);
    const dmId = posted.channel;
    if (envelope.channel_id !== dmId) {
      await tellPrivately({ ...where, text: `Continuing in your DM with me: <https://slack.com/app_redirect?channel=${dmId}|open DM>` });
    }
    const transcript = `Member: ${text}`;
    const raw = await parse(transcript);
    return respond({ raw, transcript, user: userId, say: makeSay(client, dmId), client });
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
    return say.done(`${lines.join("\n")}${more}\nTo book one: \`/reserve <name> <day> <time> for <what>\``);
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

  // A DM: continues the open request, or starts one. History holds only
  // top-level messages, so a thread reply is added in by hand and treated as
  // a plain message. Everything outside the DM (#reservations threads) is ignored.
  async function handleMessage({ event, client }) {
    if (event.channel_type !== "im" || event.bot_id || event.subtype || !String(event.text || "").trim()) return;
    const res = await client.conversations.history({ channel: event.channel, limit: 50, include_all_metadata: true });
    const history = res.messages || [];
    const messages = history.some((m) => m.ts === event.ts) ? history : [event, ...history];
    const open = openRequest(messages, { currentTs: event.ts, nowMs: now().getTime() });
    const say = makeSay(client, event.channel);
    if (isEscape(event.text)) {
      if (open) await say.done("Okay, starting fresh.");
      return;
    }
    if (open) {
      const transcript = open.map(line).join("\n");
      return respond({ raw: await parse(transcript), transcript, user: event.user, say, client });
    }
    // Nothing open: chatter is ignored; anything else gets a start marker
    // (metadata can't go on the member's own message) and is handled.
    const transcript = `Member: ${event.text}`;
    const raw = await parse(transcript);
    if (raw && normalizeRequest(raw, catalog).intent === "other") return;
    await postStartMarker(client, event.channel, event.user, event.text);
    return respond({ raw, transcript, user: event.user, say, client });
  }

  function parse(transcript) {
    const today = nyToday(now());
    return llm.parseReservationRequest(transcript, { catalogText, today, weekday: weekdayName(today) });
  }

  async function respond({ raw, transcript, user, say, client }) {
    const today = nyToday(now());
    if (!raw) return say.ask("Sorry, I couldn't read that. Please try again.");
    const req = normalizeRequest(raw, catalog);
    if (req.intent === "other") return;
    // "Sat 2-4" is afternoon. The model is told so, but a small-hours time
    // nobody wrote "am" for is asked about rather than booked at 2 AM.
    if (req.start != null && req.start < 7 * 60 && !/\d\s*(am|a\.m\.)|morning|sunrise/i.test(transcript)) {
      req.start = null;
      req.end = null;
    }

    if (req.intent === "find") return find(req, say);

    if (req.ambiguous.length) {
      const a = req.ambiguous[0];
      return say.ask(`Which one did you mean by "${a.phrase}": ${a.options.map((o) => o.label).join(", ")}?`);
    }
    if (req.unmatched.length && req.items.length === 0) {
      return say.done(`I don't know "${req.unmatched.join('", "')}". I can book rooms, the kitchen, tech sets, vehicles, and sports, outreach and accessories equipment.`);
    }
    if (req.intent === "check" || req.intent === "list") return handleQuery(req, say, client);

    if (req.date && req.date < today) {
      return say.done(`${fmtDay(req.date)} has already passed. Which date did you mean?`);
    }
    const missing = missingFields(req);
    if (missing.length) {
      const what = req.items.length ? req.items.map((i) => i.label).join(", ") : "that";
      return say.ask(`Happy to book ${what}. I still need: ${missing.join(", ")}.`);
    }
    const backends = [...new Set(req.items.map((i) => i.backend))];
    if (backends.length > 1) {
      return say.done("Please send one request per kind of booking (rooms, kitchen, or equipment).");
    }
    const adapter = adapters[backends[0]];
    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    if (conflicts.length) {
      return say.done(conflictText(req, conflicts));
    }

    const info = await client.users.info({ user });
    const profile = info.user?.profile || {};
    const requester = {
      requesterName: profile.display_name || info.user?.real_name || "Someone",
      requesterUserId: user,
      phone: profile.phone || "",
      slackEmail: profile.email || null,
    };
    return finishBooking({ req, adapter, requester, say });
  }

  return { channelId, handleMessage, handleCommand, resume, disconnect };
}
