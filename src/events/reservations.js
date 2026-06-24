// src/events/reservations.js
const BOT_USERNAME = "Reservations (beta)";
const BOT_ICON_EMOJI = ":calendar:";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function fmtListDate(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function conflictText(conflicts) {
  return conflicts.map((c) => `• ${c.what || "(busy)"}`).join("\n");
}

export function createReservationHandler({ reservationsService, groqService, now }) {
  async function replyForParsed(parsed, say, thread_ts, opts = {}) {
    if (!parsed) {
      await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: "I didn't catch that — try e.g. \"reserve FH MPR Friday 7-10pm for practice\"." });
      return;
    }
    const target = reservationsService.classifyTarget(parsed.target || "");
    if (target.kind === "unmanaged") {
      await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: `I don't manage "${parsed.target}". I can only handle known rooms and resources.` });
      return;
    }
    if (target.kind === "room") {
      if (parsed.intent === "reserve") {
        const res = await reservationsService.makeRoomReservation({
          room: target.name, dateIso: parsed.date, startTime: parsed.startTime, endTime: parsed.endTime,
          what: parsed.what, who: parsed.who,
        });
        if (res.ok) {
          const who = opts.requester ? `<@${opts.requester}> ` : "";
          const purpose = parsed.what ? ` for ${parsed.what}` : "";
          const msg = {
            username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
            text: `${who}reserved ${target.name} on ${parsed.date} ${parsed.startTime}–${parsed.endTime}${purpose}.`,
          };
          try {
            if (opts.broadcast) await opts.broadcast(msg);
            else await say({ thread_ts, ...msg });
          } catch (err) {
            // Booking is already saved; a failed notification must NOT propagate
            // (it would trigger an SQS retry → duplicate sheet rows). Fall back to
            // an ephemeral reply when the public broadcast fails (e.g. the bot is
            // not in the channel), and swallow any further error.
            console.warn(`[reservations] reservation notification failed: ${err.message}`);
            if (opts.broadcast) {
              try { await say({ thread_ts, ...msg }); } catch { /* give up quietly */ }
            }
          }
        } else {
          await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
            text: res.reason === "conflict"
              ? `Can't book — conflict on ${target.name}:\n${conflictText(res.conflicts)}`
              : `Can't book: ${res.reason}.` });
        }
        return;
      }
      if (parsed.intent === "list") {
        const items = await reservationsService.listRoom({ room: target.name, fromIso: parsed.date, toIso: parsed.date });
        await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
          text: items.length
            ? `${target.name} usage:\n` + items.map((i) => `• ${i.dateIso} ${i.startTime}–${i.endTime} ${i.what}`).join("\n")
            : `Nothing booked for ${target.name}.` });
        return;
      }
      const chk = await reservationsService.checkRoom({
        room: target.name, dateIso: parsed.date, startTime: parsed.startTime, endTime: parsed.endTime,
      });
      await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: chk.available
          ? `${target.name} is available ${parsed.date} ${parsed.startTime}–${parsed.endTime}.`
          : `${target.name} has a conflict:\n${conflictText(chk.conflicts)}` });
      return;
    }
    // Resource (calendar-backed) booking is recognized but not yet live —
    // reply honestly rather than implying it worked.
    await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
      text: `"${target.name}" is a tracked resource, but resource booking isn't live yet — I can only check/book rooms for now.` });
  }

  async function replyForList(parsed, say) {
    const ref = now();
    const fromIso = (parsed && parsed.date) || isoDate(ref);
    const toIso = (parsed && parsed.date) || isoDate(addDays(ref, 7));
    let room = null;
    let note = "";
    if (parsed && parsed.target) {
      const t = reservationsService.classifyTarget(parsed.target);
      if (t.kind === "room") room = t.name;
      else note = ` (couldn't match "${parsed.target}" to a room — showing all)`;
    }
    const items = await reservationsService.listReservations({ room, fromIso, toIso });
    const scope = room || "all rooms";
    const window = fromIso === toIso ? fromIso : `${fromIso} … ${toIso}`;
    if (!items.length) {
      await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
        text: `No reservations found for ${scope}, ${window}.${note}` });
      return;
    }
    const lines = items
      .map((i) => `• ${fmtListDate(i.dateIso)} ${i.startTime}–${i.endTime} — ${i.location} — ${i.what}`)
      .join("\n");
    await say({ username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
      text: `Reservations for ${scope}, ${window}:${note}\n${lines}` });
  }

  async function handleMention({ event, say }) {
    const refIso = now().toISOString();
    const parsed = await groqService.parseReservationRequest(event.text || "", refIso);
    const thread_ts = event.thread_ts || event.ts;
    await replyForParsed(parsed, say, thread_ts);
  }

  async function handleSlash({ envelope, client }) {
    const refIso = now().toISOString();
    const parsed = await groqService.parseReservationRequest(envelope.text || "", refIso);
    const say = (msg) => client.chat.postEphemeral({
      channel: envelope.channel_id, user: envelope.user_id, ...msg,
    });
    if (envelope.command === "/list") {
      await replyForList(parsed, say);
      return;
    }
    const opts = envelope.command === "/reserve"
      ? { broadcast: (msg) => client.chat.postMessage({ channel: envelope.channel_id, ...msg }), requester: envelope.user_id }
      : {};
    await replyForParsed(parsed, say, undefined, opts);
  }

  return { handleMention, handleSlash };
}
