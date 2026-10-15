// src/events/reservations.js
// #reservations: members ask in plain English, the bot books first come
// first served. The conversation is stateless: a thread reply re-reads the
// thread and re-parses it whole, and a finished thread carries
// CLOSED_METADATA on the bot's last reply so it is never acted on twice.
import { log, metric } from "../lib/logger.js";
import { nyToday, weekdayName, fmtDay, fmtRange } from "../lib/reservation-time.js";
import { catalogPromptText, CATEGORY_OWNERS } from "../lib/reservation-catalog.js";
import { isInvalidGrant, isForbidden } from "../services/memberGoogle.js";
import { normalizeRequest, missingFields } from "../lib/reservation-request.js";
import { reservationLine, BOT_PERSONA, CLOSED_METADATA } from "../lib/reservation-format.js";

const TECH_NOTE = "Reminder: the booking covers the ENTIRE time you hold the set. Return it to the tech room and charge the speaker and mic receivers after.";
const DISCONNECT = /\bdisconnect\b.*\bgoogle\b/i;

export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date(), connect = null }) {
  const catalogText = catalogPromptText(catalog);

  async function transcriptFor(event, client) {
    if (!event.thread_ts || event.thread_ts === event.ts) return { text: `Member: ${event.text}`, closed: false };
    const res = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 50, include_all_metadata: true });
    const messages = res.messages || [];
    if (!messages.some((m) => m.bot_id)) return null;
    // A finished booking thread: only the newest message is read, and only to
    // point a new request at a new message. It is never booked from.
    if (messages.some((m) => m.bot_id && m.metadata?.event_type === CLOSED_METADATA.event_type)) {
      return { text: `Member: ${event.text}`, closed: true };
    }
    return { text: messages.map((m) => `${m.bot_id ? "Bot" : "Member"}: ${m.text || ""}`).join("\n"), closed: false };
  }

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

  function makeReply(client, channel, rootTs) {
    return (text, { closed = false, broadcast = false } = {}) =>
      client.chat.postMessage({
        channel, thread_ts: rootTs, text, ...BOT_PERSONA,
        ...(broadcast ? { reply_broadcast: true } : {}),
        ...(closed ? { metadata: CLOSED_METADATA } : {}),
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
    return `Google Calendar won't let your account book ${names}. Ask ${CATEGORY_OWNERS[req.items[0].category] || "the equipment team"}.`;
  }

  async function promptConnect({ req, adapter, requester, reply, client, channel, rootTs, revoked }) {
    if (!requester.slackEmail) {
      return reply(`I can't see an email on your Slack profile, so I can't connect your Google account. You can book directly: ${adapter.link}`);
    }
    const { nonce } = await connect.authStore.createPending({
      slackUserId: requester.requesterUserId, slackEmail: requester.slackEmail,
      request: { req, requester, backend: adapter.backend }, channel, threadTs: rootTs,
    });
    const url = connect.consentUrl({ state: nonce, loginHint: requester.slackEmail });
    const text = revoked
      ? "Your Google connection has expired. Connect again and I'll finish this booking as you."
      : "To book as you, connect your Google account once. I'll finish this booking as soon as you approve.";
    await client.chat.postEphemeral({
      channel, user: requester.requesterUserId, thread_ts: rootTs, text, ...BOT_PERSONA,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "actions", elements: [{ type: "button", action_id: "reservations_connect_google", style: "primary", text: { type: "plain_text", text: "Connect Google" }, url }] },
      ],
    });
  }

  async function finishBooking({ req, adapter, requester, reply, client, channel, rootTs }) {
    let clients;
    if (connect) {
      const member = await connect.memberGoogle.clientsFor(requester.requesterUserId);
      if (member.status !== "active") {
        return promptConnect({ req, adapter, requester, reply, client, channel, rootTs, revoked: member.status === "revoked" });
      }
      clients = member.clients;
    }
    const booking = {
      date: req.date, start: req.start, end: req.end, items: req.items, title: req.title, ministry: req.ministry,
      requesterName: requester.requesterName, requesterUserId: requester.requesterUserId, phone: requester.phone,
      permalink: requester.permalink, appliances: req.appliances,
    };
    let result;
    try {
      result = clients ? await adapter.book(booking, { clients }) : await adapter.book(booking);
    } catch (error) {
      if (clients && isInvalidGrant(error)) {
        await connect.authStore.markRevoked(requester.requesterUserId);
        connect.memberGoogle.forget(requester.requesterUserId);
        return promptConnect({ req, adapter, requester, reply, client, channel, rootTs, revoked: true });
      }
      if (clients && isForbidden(error)) return reply(forbiddenText(adapter, req));
      metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
      log.error("reservation write failed", { backend: adapter.backend, error });
      return reply(`⚠️ I couldn't save that booking (${error.message}). Please book it directly: ${adapter.link}`);
    }
    if (result.status !== "booked") {
      return reply(`${result.reason} You can book it here: ${result.link}`);
    }
    metric("ReservationBooked", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend, asMember: !!clients } });
    const names = req.items.map((i) => i.label).join(", ");
    const note = req.items.some((i) => i.category === "tech") ? `\n${TECH_NOTE}` : "";
    // The booking is written. Failing the event now would make SQS retry it
    // and book again, so a failed confirmation is logged, never rethrown.
    try {
      await reply(
        `✅ ${names} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)} · ${req.title} · <@${requester.requesterUserId}>\n<${result.link}|Open the booking>${note}`,
        { closed: true, broadcast: true }
      );
    } catch (error) {
      log.error("reservation confirmation failed", { backend: adapter.backend, error });
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
    const reply = makeReply(client, pending.channel, pending.threadTs);
    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    if (conflicts.length) return reply(conflictText(req, conflicts));
    return finishBooking({ req, adapter, requester, reply, client, channel: pending.channel, rootTs: pending.threadTs });
  }

  async function disconnect({ userId, channel, client, responseUrl }) {
    if (!connect) return;
    const had = await connect.memberGoogle.revoke(userId);
    const text = had ? "Disconnected your Google account. Bookings will ask you to connect again." : "Your Google account wasn't connected.";
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

  async function handleQuery(req, reply, client) {
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
      return reply(hits.length
        ? `${names} is taken ${fmtDay(req.date)}:\n${hits.map(reservationLine).join("\n")}`
        : `${names} is free ${fmtDay(req.date)}, ${fmtRange(req.start, req.end)}.`);
    }
    const from = req.date || nyToday(now());
    const to = req.toDate || from;
    const found = [];
    for (const backend of groups) {
      if (!adapters[backend]) continue;
      const { reservations } = await adapters[backend].listReservations({ from, to, items: req.items.filter((i) => i.backend === backend) });
      found.push(...reservations);
    }
    if (found.length === 0) return reply(`Nothing booked ${from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`}.`);
    const people = await withMentions(client, found);
    const days = [...new Set(people.map((r) => r.date))].sort();
    const text = days.map((d) => [`*${fmtDay(d)}*`, ...people.filter((r) => r.date === d).sort((a, b) => (a.start ?? -1) - (b.start ?? -1)).map(reservationLine)].join("\n")).join("\n\n");
    return reply(text);
  }

  async function handleMessage({ event, client }) {
    if (event.channel !== channelId || event.bot_id || event.subtype || !String(event.text || "").trim()) return;
    const rootTs = event.thread_ts || event.ts;
    const reply = makeReply(client, event.channel, rootTs);
    if (connect && DISCONNECT.test(event.text)) return disconnect({ userId: event.user, channel: event.channel, client });

    const thread = await transcriptFor(event, client);
    if (!thread) return;

    const today = nyToday(now());
    const raw = await llm.parseReservationRequest(thread.text, { catalogText, today, weekday: weekdayName(today) });
    if (thread.closed) {
      if (raw && ["book", "check", "list"].includes(raw.intent)) {
        return reply("That booking is done. Please start a new message for a new request.");
      }
      return;
    }
    if (!raw) return reply("Sorry, I couldn't read that. Please try again.");
    const req = normalizeRequest(raw, catalog);
    if (req.intent === "other") return;
    // "Sat 2-4" is afternoon. The model is told so, but a small-hours time
    // nobody wrote "am" for is asked about rather than booked at 2 AM.
    if (req.start != null && req.start < 7 * 60 && !/\d\s*(am|a\.m\.)|morning|sunrise/i.test(thread.text)) {
      req.start = null;
      req.end = null;
    }

    if (req.ambiguous.length) {
      const a = req.ambiguous[0];
      return reply(`Which one did you mean by "${a.phrase}": ${a.options.map((o) => o.label).join(", ")}?`);
    }
    if (req.unmatched.length && req.items.length === 0) {
      return reply(`I don't know "${req.unmatched.join('", "')}". I can book rooms, the kitchen, tech sets, and sports, outreach and accessories equipment.`);
    }
    if (req.intent === "check" || req.intent === "list") return handleQuery(req, reply, client);

    if (req.date && req.date < today) {
      return reply(`${fmtDay(req.date)} has already passed. Which date did you mean?`);
    }
    const missing = missingFields(req);
    if (missing.length) {
      const what = req.items.length ? req.items.map((i) => i.label).join(", ") : "that";
      return reply(`Happy to book ${what}. I still need: ${missing.join(", ")}.`);
    }
    const backends = [...new Set(req.items.map((i) => i.backend))];
    if (backends.length > 1) {
      return reply("Please send one request per kind of booking (rooms, kitchen, or equipment).");
    }
    const adapter = adapters[backends[0]];
    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    if (conflicts.length) {
      return reply(conflictText(req, conflicts));
    }

    const info = await client.users.info({ user: event.user });
    const profile = info.user?.profile || {};
    const { permalink } = await client.chat.getPermalink({ channel: event.channel, message_ts: rootTs });
    const requester = {
      requesterName: profile.display_name || info.user?.real_name || "Someone",
      requesterUserId: event.user,
      phone: profile.phone || "",
      permalink,
      slackEmail: profile.email || null,
    };
    return finishBooking({ req, adapter, requester, reply, client, channel: event.channel, rootTs });
  }

  return { channelId, handleMessage, resume, disconnect };
}
