// src/services/livingDigest.js
// One digest message per period (Mon–Thu, Fri–Sun) that is posted on schedule
// and then edited in place as bookings land, so the channel keeps a single
// current list. A source that can't be read never stops the post; it is named
// in it and DMed to the operator, since a quietly missing source looks like a
// quiet week.
import { addDaysIso, digestPeriod, nyDateTime, periodCovering } from "../lib/reservation-time.js";
import { buildLivingDigest, BOT_PERSONA, DIGEST_EVENT_TYPE } from "../lib/reservation-format.js";
import { log, metric } from "../lib/logger.js";

const SOURCE_NAMES = { rooms: "Rooms", kitchen: "Kitchen", rms: "Equipment calendars" };

export function createLivingDigest({ client, adapters, channelId, escalationUserId }) {
  async function read(from, to) {
    const reservations = [];
    const failures = [];
    for (const [backend, adapter] of Object.entries(adapters)) {
      const name = SOURCE_NAMES[backend] || backend;
      try {
        const res = await adapter.listReservations({ from, to });
        reservations.push(...res.reservations);
        for (const e of res.errors) failures.push(`${name}: ${e}`);
      } catch (err) {
        failures.push(`${name}: ${err.message}`);
      }
    }
    return { reservations, failures };
  }

  async function render({ kind, from, to }) {
    const { reservations, failures } = await read(from, to);
    let text = buildLivingDigest({ kind, from, to, reservations });
    if (failures.length) {
      const names = [...new Set(failures.map((f) => f.split(":")[0]))];
      text = `${text}\n\n⚠️ Couldn't read: ${names.join(", ")}. This list may be incomplete.`;
    }
    return { text, failures, metadata: { event_type: DIGEST_EVENT_TYPE, event_payload: { from, to } } };
  }

  async function post(kind, now = new Date()) {
    const { text, failures, metadata } = await render(digestPeriod(kind, now));
    await client.chat.postMessage({ channel: channelId, text, ...BOT_PERSONA, metadata });

    if (failures.length) {
      metric("DigestSourceFailed", failures.length, { dimensions: { Flow: "digest" } });
      log.error("digest source failed", { failures });
      if (escalationUserId) {
        await client.chat.postMessage({
          channel: escalationUserId,
          text: `The reservations digest couldn't read some sources:\n${failures.map((f) => `• ${f}`).join("\n")}`,
          ...BOT_PERSONA,
        });
      }
    }
    return { failures };
  }

  // Rebuilds the digest covering dateIso, if one was posted; false when none.
  async function refresh(dateIso) {
    const period = periodCovering(dateIso);
    // The digest sinks under card traffic, so page back, but only as far as a
    // week before the period and never more than 5 pages.
    const oldest = String(Date.parse(nyDateTime(addDaysIso(period.from, -7), 0)) / 1000);
    let existing;
    let cursor;
    for (let page = 0; page < 5 && !existing; page++) {
      const history = await client.conversations.history({
        channel: channelId, limit: 200, include_all_metadata: true, oldest, ...(cursor && { cursor }),
      });
      const messages = history.messages || [];
      existing = messages.find(
        (m) => m.metadata?.event_type === DIGEST_EVENT_TYPE && m.metadata.event_payload?.from === period.from,
      );
      cursor = history.response_metadata?.next_cursor;
      if (!cursor || (messages.length && Number(messages[messages.length - 1].ts) < Number(oldest))) break;
    }
    if (!existing) return false;
    const { text, metadata } = await render(period);
    await client.chat.update({ channel: channelId, ts: existing.ts, text, metadata });
    return true;
  }

  return { post, refresh };
}
