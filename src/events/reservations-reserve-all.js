// src/events/reservations-reserve-all.js
// Reserve all: one press books every free date of every line in the member's
// tray, through the same adapters, account rules, ledger and digest as a
// card's Book, then posts one combined message in the channel.
//
// Nothing may be written twice. The press's run id is stored in the tray
// while it runs, and each date is marked "started" in the stored tray
// (version-checked) before it is written and "done" (with its ref) after, so
// a redelivered or later run skips what was written and still posts it.
import { log, metric } from "../lib/logger.js";
import { nyToday, nyParts, fmtDay, fmtRange, periodCovering } from "../lib/reservation-time.js";
import { findItem } from "../lib/reservation-catalog.js";
import { BOT_PERSONA } from "../lib/reservation-format.js";
import { emptyTray, expandDates, trayProblems, repeatText } from "../lib/reservation-tray.js";
import { combinedMessage } from "../lib/reservation-combined.js";

// A run that has held the tray this long is taken to have died.
const RUN_STALE_MS = 15 * 60 * 1000;
const SAVE_TRIES = 3;
// The private notice repeats the skips; past these it says how many more.
const NOTICE_SKIPS = 12;
const NOTICE_SKIP_MAX = 200;
const BUSY_TEXT = "Already reserving your tray. One moment.";
const EMPTY_TEXT = "Your tray is empty. Add something to reserve first.";
const CONNECT_TEXT = "To book as you, connect your Google account once. I'll reserve your tray as soon as you approve.";
const RECONNECT_TEXT = "Your Google connection has expired. Connect again and I'll reserve the rest of your tray as soon as you approve.";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// What a booking is made from; a line whose fields changed mid-run is not written.
const bookingFields = (l) => JSON.stringify([l.item, l.date, l.start, l.end, l.title, l.repeat ?? null, l.onlyDates ?? null, l.appliances ?? {}]);
const errorText = (error) => (typeof error === "string" ? error : error?.message) || "unknown error";
// "10/24": the repeat's weekdays are already named before the span.
const monthDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const daysText = (dates) => (dates.length <= 3 ? dates.map(fmtDay).join(", ") : `${dates.length} dates`);

export function createReserveAll({
  adapters, catalog, connect = null, ledger = null, trayStore = null, livingDigest = null, now = () => new Date(),
  requesterFor, promptConnect, memberClients, classifyWriteError, forbiddenText, renderListing,
}) {
  function context() {
    const at = now();
    return { today: nyToday(at), nowMin: nyParts(at.toISOString()).min, catalog };
  }

  async function postPrivately(client, { channel, user }, message) {
    try {
      await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, ...message });
    } catch (error) {
      log.error("reserve all private reply failed", { error });
    }
  }

  // The listing card is replaced through the press's response_url; when that
  // has expired (or there is none, after connecting), a new private message.
  async function replyCard(client, where, message) {
    if (where.responseUrl) {
      try {
        const res = await fetch(where.responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ replace_original: true, ...message }),
        });
        if (res.ok) return;
        log.warn("replacing the listing card failed", { status: res.status });
      } catch (error) {
        log.warn("replacing the listing card failed", { error });
      }
    }
    await postPrivately(client, where, message);
  }

  // notice is mrkdwn the caller has escaped.
  async function cardWith(tray, notice, client) {
    try {
      return await renderListing({ ...emptyTray(), ...tray, editing: null }, { notice, client });
    } catch (error) {
      log.error("drawing the listing failed", { error });
      return { text: notice };
    }
  }

  // Saves a change that must survive a press elsewhere (a page turn, an
  // edit): a lost race reloads the tray and re-applies it. change edits a
  // tray in place by line id, so applying it again is harmless. Never throws.
  async function persist(state, user, change, what) {
    let tray = state.tray;
    change(tray);
    for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
      try {
        const expectVersion = tray.version;
        if (await trayStore.putTray(user, tray, { expectVersion })) {
          state.tray = { ...tray, version: expectVersion + 1 };
          return true;
        }
        const fresh = await trayStore.getTray(user);
        if (!fresh) break;
        change(fresh);
        tray = fresh;
      } catch (error) {
        log.error("saving the tray failed", { what, error });
        return false;
      }
    }
    log.error("saving the tray failed", { what, error: "lost the race" });
    return false;
  }

  // Marks a backend's dates "started" before anything is written. Returns
  // the dates this run may write, or null when another run owns the tray (or
  // another delivery already started these dates): then nothing is written.
  async function claimGroup(state, user, runId, want) {
    let tray = state.tray;
    for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
      if (!tray || tray.running?.runId !== runId) return null;
      const lines = new Map(tray.lines.map((l) => [l.id, l]));
      if (want.some(({ w, date }) => lines.get(w.line.id)?.progress?.[date])) return null;
      // A line edited or removed since the run began is left as it now is.
      const ok = want.filter(({ w }) => {
        const l = lines.get(w.line.id);
        return l && bookingFields(l) === bookingFields(w.line);
      });
      for (const { w, date } of ok) {
        const l = lines.get(w.line.id);
        l.progress = { ...(l.progress || {}), [date]: "started" };
      }
      const expectVersion = tray.version;
      if (await trayStore.putTray(user, tray, { expectVersion })) {
        state.tray = { ...tray, version: expectVersion + 1 };
        return ok;
      }
      tray = await trayStore.getTray(user);
    }
    return null;
  }

  function bookingFor(w, date, requester) {
    return {
      date, start: w.line.start, end: w.line.end, items: [w.entry], title: w.line.title, ministry: null,
      requesterName: requester.requesterName, requesterUserId: requester.requesterUserId, phone: requester.phone,
      appliances: w.line.appliances || {},
    };
  }

  function promptTray({ client, channel, user, requester, revoked }) {
    const say = {
      channel, threadTs: null, cardTs: null,
      prompt: (text, blocks) => client.chat.postEphemeral({ channel, user, text, blocks, ...BOT_PERSONA }),
    };
    return promptConnect({
      request: { kind: "tray", user, channel }, requester, say,
      text: revoked ? RECONNECT_TEXT : CONNECT_TEXT,
      noEmail: (text) => postPrivately(client, { channel, user }, { text }),
    });
  }

  // The line's dates that are already written (by an earlier delivery), still
  // to check, or uncertain; then the ones to check are re-checked.
  async function prepareLine(line) {
    const skipped = [];
    const entry = findItem(catalog, line.item);
    const adapter = entry && adapters[entry.backend];
    if (!adapter?.bookMany) return { skipped: [{ text: `${line.item} can no longer be booked.` }] };
    const w = { line, entry, adapter, booked: new Map(), free: [] };
    const progress = line.progress || {};
    const prior = line.booked || {};
    const dates = [];
    for (const d of expandDates(line)) {
      if (progress[d] === "done" && prior[d]) w.booked.set(d, prior[d]);
      else if (progress[d]) skipped.push({ text: `${line.item} · ${fmtDay(d)} · may already be booked, please check before booking again` });
      else dates.push(d);
    }
    if (!dates.length) return { w, skipped };
    let result;
    try {
      result = await adapter.checkDates({ dates, start: line.start, end: line.end, items: [entry] });
    } catch (error) {
      log.warn("re-checking a tray line failed", { backend: adapter.backend, error });
      result = {};
    }
    for (const d of dates) {
      const r = result?.[d];
      if (!r) skipped.push({ text: `${line.item} · ${fmtDay(d)} · couldn't check it, please try again` });
      else if (r.unavailable) skipped.push({ text: `${line.item} · ${fmtDay(d)} · ${r.unavailable}` });
      else if (r.conflicts?.length) {
        const who = r.conflicts.map((c) => [c.holder || "someone", c.title].filter(Boolean).join(" · ")).join("; ");
        skipped.push({ text: `${line.item} · ${fmtDay(d)} · ${fmtRange(line.start, line.end)} (${who})` });
      } else w.free.push(d);
    }
    return { w, skipped };
  }

  function summaryOf(w, runId) {
    const { line } = w;
    const dates = [...w.booked.keys()].sort();
    const range = fmtRange(line.start, line.end);
    if (!line.repeat) return { summary: `${line.item} · ${fmtDay(dates[0])} · ${range} · ${line.title}`, ref: w.booked.get(dates[0]) ?? undefined, count: 1 };
    const every = repeatText({ ...line.repeat, until: null });
    return {
      summary: `${line.item} · ${every} ${monthDay(dates[0])} – ${monthDay(dates.at(-1))} (${dates.length} dates) · ${range} · ${line.title}`,
      seriesId: `${line.id}-${runId}`, count: dates.length,
    };
  }

  async function run({ user, channel, client, runId, responseUrl = null }) {
    if (!trayStore || !user || !channel || !runId) return;
    const where = { channel, user, responseUrl };
    const ctx = context();

    // 1–2. Load the tray, refuse what can't be reserved yet, take the run.
    const state = { tray: null };
    for (let attempt = 0; attempt < 2 && !state.tray; attempt++) {
      const stored = await trayStore.getTray(user);
      if (!stored?.lines?.length) return replyCard(client, where, await cardWith(stored ?? emptyTray(), EMPTY_TEXT, client));
      // A line whose item left the catalog is skipped, not refused.
      const problems = trayProblems({ ...stored, lines: stored.lines.filter((l) => findItem(catalog, l.item)) }, ctx);
      if (problems.length) {
        return replyCard(client, where, await cardWith(stored, `Can't reserve yet:\n${problems.map((p) => `• ${esc(p)}`).join("\n")}`, client));
      }
      const at = now().getTime();
      const { running } = stored;
      if (running && running.runId !== runId && at - Number(running.at) < RUN_STALE_MS) {
        return postPrivately(client, where, { text: BUSY_TEXT });
      }
      const tray = { ...stored, running: { runId, at } };
      if (await trayStore.putTray(user, tray, { expectVersion: stored.version })) state.tray = { ...tray, version: stored.version + 1 };
    }
    // Lost twice: someone else is changing the tray, so nothing is written.
    if (!state.tray) return;
    const release = (t) => {
      if (t.running?.runId === runId) t.running = null;
    };

    // 3. Whose account writes.
    const requester = await requesterFor(client, user);
    const member = await memberClients(user);
    if (member.status === "none" || member.status === "revoked") {
      try {
        await promptTray({ client, channel, user, requester, revoked: member.status === "revoked" });
      } finally {
        await persist(state, user, release, "release");
      }
      return;
    }
    const clients = member.clients ?? null;

    // 4. Re-check every date still to write.
    const prepared = await Promise.all(structuredClone(state.tray.lines).map(prepareLine));
    const work = prepared.map((p) => p.w).filter(Boolean);
    const skipped = prepared.flatMap((p) => p.skipped);

    // 5–6. Write each backend's free dates in one go.
    let revoked = false;
    let unsaved = false;
    const backends = [...new Set(work.filter((w) => w.free.length).map((w) => w.entry.backend))];
    for (const backend of backends) {
      if (revoked) break;
      const group = work.filter((w) => w.entry.backend === backend && w.free.length);
      const want = group.flatMap((w) => w.free.map((date) => ({ w, date })));
      const claimed = await claimGroup(state, user, runId, want);
      if (!claimed) {
        // Another run owns the tray. It posts what this run saved as done;
        // only bookings that never reached the tray are posted from here.
        if (!unsaved) return;
        break;
      }
      if (!claimed.length) continue;
      const adapter = adapters[backend];
      const bookings = claimed.map(({ w, date }) => bookingFor(w, date, requester));
      let results;
      try {
        results = await adapter.bookMany(bookings, clients ? { clients } : {});
      } catch (error) {
        results = bookings.map(() => ({ status: "error", error }));
      }
      const forbidden = new Map();
      claimed.forEach(({ w, date }, i) => {
        const r = results?.[i];
        if (r?.status === "booked") {
          w.booked.set(date, r.ref ?? null);
          return;
        }
        if (r?.status === "unavailable") {
          skipped.push({ text: `${w.line.item} · ${fmtDay(date)} · ${r.reason}` });
          return;
        }
        const kind = clients ? classifyWriteError(r?.error) : "error";
        if (kind === "revoked") {
          // Left in the tray; Reserve all carries on with it after connecting.
          revoked = true;
        } else if (kind === "forbidden") {
          forbidden.set(w, [...(forbidden.get(w) || []), date]);
        } else {
          metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend, stage: "reserve_all" } });
          log.error("reserve all write failed", { backend, error: errorText(r?.error) });
          skipped.push({ text: `${w.line.item} · ${fmtDay(date)} · couldn't save (${errorText(r?.error)})` });
        }
      });
      for (const [w, dates] of forbidden) {
        skipped.push({ text: `${w.line.item} · ${daysText(dates)} · ${forbiddenText(adapter, { items: [w.entry] })}` });
      }
      const outcome = new Map(claimed.map(({ w, date }) => [`${w.line.id}|${date}`, w.booked.has(date) ? w.booked.get(date) : undefined]));
      let lost = false;
      const saved = await persist(state, user, (t) => {
        for (const { w, date } of claimed) {
          const l = t.lines.find((x) => x.id === w.line.id);
          if (!l) {
            lost = true;
            continue;
          }
          const ref = outcome.get(`${w.line.id}|${date}`);
          const progress = { ...(l.progress || {}) };
          if (ref !== undefined) {
            progress[date] = "done";
            l.booked = { ...(l.booked || {}), [date]: ref };
          } else {
            delete progress[date];
          }
          l.progress = progress;
        }
      }, "progress");
      if (!saved || lost) unsaved = true;
      if (revoked) {
        try {
          await connect.authStore.markRevoked(user);
          connect.memberGoogle.forget(user);
        } catch (error) {
          log.error("marking a revoked grant failed", { error });
        }
      }
    }

    // From here everything is written: failures are logged, never thrown, so
    // an SQS retry can't run the writes again.
    const entries = work.filter((w) => w.booked.size);
    const total = entries.reduce((n, w) => n + w.booked.size, 0);
    if (total) metric("ReservationBooked", total, { dimensions: { Flow: "reservations" }, fields: { reserveAll: true, asMember: !!clients } });

    // 8. One public post.
    let postTs = null;
    if (entries.length) {
      try {
        const booked = entries.map((w) => summaryOf(w, runId));
        const message = combinedMessage({ user, booked, skipped });
        booked.forEach((b, i) => {
          if (!message.blocks[i + 1]?.accessory) log.warn("booked line has no Cancel button: its ref is too big", { summary: b.summary });
        });
        const res = await client.chat.postMessage({ channel, ...BOT_PERSONA, ...message });
        postTs = res?.ts ?? null;
      } catch (error) {
        log.error("reserve all post failed", { error });
      }
    }

    // 7. The ledger, so "mine" and Cancel find these bookings.
    for (const w of entries) {
      const refs = [...w.booked.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref).filter(Boolean);
      try {
        if (w.line.repeat) {
          await ledger?.recordSeries(user, {
            id: `${w.line.id}-${runId}`, item: w.line.item, start: w.line.start, end: w.line.end, title: w.line.title,
            repeat: w.line.repeat, channel, postTs, refs,
          }, { today: ctx.today });
        } else {
          for (const ref of refs) await ledger?.recordBooking(user, ref, { today: ctx.today });
        }
      } catch (error) {
        log.error("booking ledger write failed", { error });
      }
    }

    // 9. The tray keeps only what wasn't booked.
    const bookedDates = new Map(work.map((w) => [w.line.id, new Set(w.booked.keys())]));
    await persist(state, user, (t) => {
      t.lines = t.lines.flatMap((l) => {
        const done = bookedDates.get(l.id);
        const { booked, ...rest } = l;
        if (!done?.size) return [{ ...rest, progress: {} }];
        const left = expandDates(l).filter((d) => !done.has(d));
        if (!left.length) return [];
        return [{ ...rest, progress: {}, ...(l.repeat ? { onlyDates: left } : {}) }];
      });
      release(t);
    }, "finish");

    // 10. The private result, with the tray as it is now.
    try {
      const head = total ? `✅ Reserved ${total} booking${total === 1 ? "" : "s"}. It's posted in the channel.` : "Nothing could be booked.";
      const lines = skipped.slice(0, NOTICE_SKIPS).map((s) => `• ${esc(String(s.text).slice(0, NOTICE_SKIP_MAX))}`);
      if (skipped.length > NOTICE_SKIPS) lines.push(`…and ${skipped.length - NOTICE_SKIPS} more.`);
      await replyCard(client, where, await cardWith(state.tray, [head, ...lines].join("\n"), client));
    } catch (error) {
      log.error("reserve all result failed", { error });
    }

    // 11. Each affected digest period once.
    const periods = new Map();
    for (const w of entries) {
      for (const d of w.booked.keys()) {
        const { from } = periodCovering(d);
        if (!periods.has(from)) periods.set(from, d);
      }
    }
    for (const date of periods.values()) {
      try {
        await livingDigest?.refresh(date);
      } catch (error) {
        log.error("digest refresh failed", { date, error });
      }
    }

    // 12. A grant revoked partway: connect, then the rest is reserved.
    if (revoked) {
      try {
        await promptTray({ client, channel, user, requester, revoked: true });
      } catch (error) {
        log.error("reserve all connect prompt failed", { error });
      }
    }
  }

  // After the member connects Google: the pending row said "reserve my tray".
  // There is no response_url, so every private reply is a new ephemeral.
  function resume(pending, client) {
    const user = pending.request?.user || pending.slackUserId;
    const channel = pending.request?.channel || pending.channel;
    return run({ user, channel, client, runId: `resume-${pending.pendingId}`, responseUrl: null });
  }

  return { run, resume };
}
