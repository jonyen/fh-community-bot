// src/events/reservations.js
// #reservations: members ask in plain English, the bot books first come
// first served. The conversation is stateless: a thread reply re-reads the
// thread and re-parses it whole, and a finished thread carries
// CLOSED_METADATA on the bot's last reply so it is never acted on twice.
import { log, metric } from "../lib/logger.js";
import { nyToday, weekdayName, fmtDay, fmtRange } from "../lib/reservation-time.js";
import { catalogPromptText } from "../lib/reservation-catalog.js";
import { normalizeRequest, missingFields } from "../lib/reservation-request.js";
import { reservationLine, BOT_PERSONA, CLOSED_METADATA } from "../lib/reservation-format.js";

const TECH_NOTE = "Reminder: the booking covers the ENTIRE time you hold the set. Return it to the tech room and charge the speaker and mic receivers after.";

export function createReservationsHandler({ llm, adapters, catalog, channelId, now = () => new Date() }) {
  const catalogText = catalogPromptText(catalog);

  async function transcriptFor(event, client) {
    if (!event.thread_ts || event.thread_ts === event.ts) return `Member: ${event.text}`;
    const res = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 50, include_all_metadata: true });
    const messages = res.messages || [];
    if (!messages.some((m) => m.bot_id)) return null;
    if (messages.some((m) => m.bot_id && m.metadata?.event_type === CLOSED_METADATA.event_type)) return null;
    return messages.map((m) => `${m.bot_id ? "Bot" : "Member"}: ${m.text || ""}`).join("\n");
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

  async function handleQuery(req, reply, client) {
    const groups = req.items.length ? [...new Set(req.items.map((i) => i.backend))] : Object.keys(adapters);
    if (req.intent === "check" && req.items.length && req.date && req.start != null) {
      const backend = groups[0];
      const hits = await withMentions(client, await adapters[backend].findConflicts({
        date: req.date, start: req.start, end: req.end, items: req.items.filter((i) => i.backend === backend),
      }));
      const names = req.items.map((i) => i.label).join(", ");
      return reply(hits.length
        ? `${names} is taken ${fmtDay(req.date)}:\n${hits.map(reservationLine).join("\n")}`
        : `${names} is free ${fmtDay(req.date)}, ${fmtRange(req.start, req.end)}.`, { closed: true });
    }
    const from = req.date || nyToday(now());
    const to = req.toDate || from;
    const found = [];
    for (const backend of groups) {
      if (!adapters[backend]) continue;
      const { reservations } = await adapters[backend].listReservations({ from, to, items: req.items.filter((i) => i.backend === backend) });
      found.push(...reservations);
    }
    if (found.length === 0) return reply(`Nothing booked ${from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`}.`, { closed: true });
    const people = await withMentions(client, found);
    const days = [...new Set(people.map((r) => r.date))].sort();
    const text = days.map((d) => [`*${fmtDay(d)}*`, ...people.filter((r) => r.date === d).sort((a, b) => (a.start ?? -1) - (b.start ?? -1)).map(reservationLine)].join("\n")).join("\n\n");
    return reply(text, { closed: true });
  }

  async function handleMessage({ event, client }) {
    if (event.channel !== channelId || event.bot_id || event.subtype || !String(event.text || "").trim()) return;
    const rootTs = event.thread_ts || event.ts;
    const reply = (text, { closed = false, broadcast = false } = {}) =>
      client.chat.postMessage({
        channel: event.channel, thread_ts: rootTs, text, ...BOT_PERSONA,
        ...(broadcast ? { reply_broadcast: true } : {}),
        ...(closed ? { metadata: CLOSED_METADATA } : {}),
      });

    const transcript = await transcriptFor(event, client);
    if (!transcript) return;

    const today = nyToday(now());
    const raw = await llm.parseReservationRequest(transcript, { catalogText, today, weekday: weekdayName(today) });
    if (!raw) return reply("Sorry, I couldn't read that. Please try again.");
    const req = normalizeRequest(raw, catalog);
    if (req.intent === "other") return;

    if (req.ambiguous.length) {
      const a = req.ambiguous[0];
      return reply(`Which one did you mean by "${a.phrase}": ${a.options.map((o) => o.label).join(", ")}?`);
    }
    if (req.unmatched.length && req.items.length === 0) {
      return reply(`I don't know "${req.unmatched.join('", "')}". I can book rooms, the kitchen, tech sets, and sports, outreach and accessories equipment.`);
    }
    if (req.intent === "check" || req.intent === "list") return handleQuery(req, reply, client);

    const missing = missingFields(req);
    if (missing.length) {
      const what = req.items.length ? req.items.map((i) => i.label).join(", ") : "that";
      return reply(`Happy to book ${what}. I still need: ${missing.join(", ")}.`);
    }
    const backends = [...new Set(req.items.map((i) => i.backend))];
    if (backends.length > 1) {
      return reply("Please send one request per kind of booking (rooms, kitchen, or equipment).", { closed: true });
    }
    const adapter = adapters[backends[0]];
    const names = req.items.map((i) => i.label).join(", ");

    const conflicts = await withMentions(client, await adapter.findConflicts({ date: req.date, start: req.start, end: req.end, items: req.items }));
    if (conflicts.length) {
      return reply(`❌ ${names} is taken ${fmtDay(req.date)}:\n${conflicts.map(reservationLine).join("\n")}\nPlease check with them.`, { closed: true });
    }

    const info = await client.users.info({ user: event.user });
    const profile = info.user?.profile || {};
    const requesterName = profile.display_name || info.user?.real_name || "Someone";
    const { permalink } = await client.chat.getPermalink({ channel: event.channel, message_ts: rootTs });

    let result;
    try {
      result = await adapter.book({
        date: req.date, start: req.start, end: req.end, items: req.items, title: req.title, ministry: req.ministry,
        requesterName, requesterUserId: event.user, phone: profile.phone || "", permalink, appliances: req.appliances,
      });
    } catch (error) {
      metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
      log.error("reservation write failed", { backend: adapter.backend, error });
      return reply(`⚠️ I couldn't save that booking (${error.message}). Please book it directly: ${adapter.link}`, { closed: true });
    }
    if (result.status !== "booked") {
      return reply(`${result.reason} You can book it here: ${result.link}`, { closed: true });
    }
    metric("ReservationBooked", 1, { dimensions: { Flow: "reservations" }, fields: { backend: adapter.backend } });
    const note = req.items.some((i) => i.category === "tech") ? `\n${TECH_NOTE}` : "";
    return reply(
      `✅ ${names} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)} · ${req.title} · <@${event.user}>\n<${result.link}|Open the booking>${note}`,
      { closed: true, broadcast: true }
    );
  }

  return { channelId, handleMessage };
}
