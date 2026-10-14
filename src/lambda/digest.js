// src/lambda/digest.js
// Monday 8 AM: the week's reservations from every backend in one post, so
// bookings made straight in a doc or calendar are seen too. A source that
// can't be read never stops the post; it is named in it and DMed to the
// operator, since a quietly missing source looks like a quiet week.
import { getDeps } from "./clients.js";
import { weekOf } from "../lib/reservation-time.js";
import { buildDigest, BOT_PERSONA, CLOSED_METADATA } from "../lib/reservation-format.js";
import { log, metric } from "../lib/logger.js";

const SOURCE_NAMES = { rooms: "Rooms", kitchen: "Kitchen", rms: "Equipment calendars" };

export async function runDigest({ client, adapters, channelId, escalationUserId, now = () => new Date() }) {
  const { from, to } = weekOf(now());
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

  const parts = buildDigest({ from, to, reservations });
  if (failures.length) {
    const names = [...new Set(failures.map((f) => f.split(":")[0]))];
    parts[0] = `${parts[0]}\n\n⚠️ Couldn't read: ${names.join(", ")}. This list may be incomplete.`;
  }

  // Every digest post is closed, so replies to it are never parsed as bookings.
  const first = await client.chat.postMessage({ channel: channelId, text: parts[0], ...BOT_PERSONA, metadata: CLOSED_METADATA });
  for (const part of parts.slice(1)) {
    await client.chat.postMessage({ channel: channelId, thread_ts: first.ts, text: part, ...BOT_PERSONA, metadata: CLOSED_METADATA });
  }

  if (failures.length) {
    metric("DigestSourceFailed", failures.length, { dimensions: { Flow: "digest" } });
    log.error("digest source failed", { failures });
    if (escalationUserId) {
      await client.chat.postMessage({
        channel: escalationUserId,
        text: `The weekly reservations digest couldn't read some sources:\n${failures.map((f) => `• ${f}`).join("\n")}`,
        ...BOT_PERSONA,
      });
    }
  }
  return { posted: parts.length, failures };
}

export async function handler() {
  const { config, client, reservationAdapters } = getDeps();
  if (!config.reservations) {
    log.warn("digest skipped: RESERVATIONS_CHANNEL_ID not set");
    return;
  }
  await runDigest({
    client,
    adapters: reservationAdapters,
    channelId: config.reservations.channelId,
    escalationUserId: config.reservations.escalationUserId,
  });
}
