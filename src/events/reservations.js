// src/events/reservations.js
const BOT_USERNAME = "Reservations (beta)";
const BOT_ICON_EMOJI = ":calendar:";

function conflictText(conflicts) {
  return conflicts.map((c) => `• ${c.what || "(busy)"}`).join("\n");
}

export function createReservationHandler({ reservationsService, groqService, now }) {
  async function replyForParsed(parsed, say, thread_ts) {
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
        await say({ thread_ts, username: BOT_USERNAME, icon_emoji: BOT_ICON_EMOJI,
          text: res.ok
            ? `Booked ${target.name} on ${parsed.date} ${parsed.startTime}–${parsed.endTime}.`
            : res.reason === "conflict"
              ? `Can't book — conflict on ${target.name}:\n${conflictText(res.conflicts)}`
              : `Can't book: ${res.reason}.` });
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
    await replyForParsed(parsed, say, undefined);
  }

  return { handleMention, handleSlash };
}
