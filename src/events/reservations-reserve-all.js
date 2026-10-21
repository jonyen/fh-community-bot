// src/events/reservations-reserve-all.js
// Reserve all: one press books every free date of every line in the member's
// tray, through the same adapters, account rules, ledger and digest as a
// card's Book, then posts one combined message in the channel.
//
// Nothing may be written twice, and nothing written may go unposted:
// - The run holds the tray (`running`) while it books. A press made while
//   another run holds it is told to wait.
// - Before a backend's dates are written they are marked "started", with the
//   run's id in `claims`, in the stored tray (version-checked); after, "done"
//   with the booking's ref. Only the run that claimed a date posts it, records
//   it and tidies it away; other runs leave it alone.
// - Right after the public post the run saves a `posts[runId]` record, so a
//   redelivery of the same press finishes the ledger and tray without posting
//   again.
// - A date whose write may or may not have happened (an error, or a crash
//   while "started") is never written again: it is reported as "may already
//   be booked" and taken out of the tray.
import { log, metric } from "../lib/logger.js";
import { nyToday, nyParts, fmtDay, fmtRange, periodCovering, overlaps } from "../lib/reservation-time.js";
import { roomsConflict } from "../lib/rooms-catalog.js";
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
const MAYBE_TEXT = "may already be booked, please check before booking again";
const ERROR_TEXT = "⚠️ Something went wrong. Please try again.";
const OVERLAP_TEXT = "overlaps another line in your tray";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// What a booking is made from; a line whose fields changed mid-run is not written.
const bookingFields = (l) => JSON.stringify([l.item, l.date, l.start, l.end, l.title, l.repeat ?? null, l.onlyDates ?? null, l.appliances ?? {}]);
const errorText = (error) => (typeof error === "string" ? error : error?.message) || "unknown error";
const daysText = (dates) => (dates.length <= 3 ? dates.map(fmtDay).join(", ") : `${dates.length} dates`);
// "10/24": the repeat's weekdays are already named before the span.
const monthDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const keyOf = (lineId, date) => `${lineId}|${date}`;
// text goes in the public post; detail (if any) replaces it in the private result.
const skip = (item, date, text, detail) => ({
  text: `${item} · ${fmtDay(date)} · ${text}`, ...(detail ? { detail: `${item} · ${fmtDay(date)} · ${detail}` } : {}),
});
const entryDates = (e) => e.refs.map(([d]) => d);

// Whether two catalog entries of one backend would hold the same thing: rooms
// that share a room, the same calendar item, or the kitchen (one member, one slot).
function sameThing(backend, a, b) {
  if (backend === "rooms") return roomsConflict([a.label], [b.label]);
  if (backend === "kitchen") return true;
  return a.label === b.label;
}

// A later tray line booking the same thing on the same date at an overlapping
// time as an earlier line would book it twice: its date is skipped instead.
function skipOverlaps(work, skipped) {
  const placed = [];
  for (const w of work) {
    const backend = w.entry.backend;
    const clash = (d) => placed.some((p) => p.backend === backend && p.date === d
      && overlaps(p.start, p.end, w.line.start, w.line.end) && sameThing(backend, p.entry, w.entry));
    const kept = [];
    for (const d of w.free) {
      if (clash(d)) skipped.push(skip(w.line.item, d, OVERLAP_TEXT));
      else kept.push(d);
    }
    w.free = kept;
    for (const d of [...kept, ...w.booked.keys()]) placed.push({ backend, entry: w.entry, date: d, start: w.line.start, end: w.line.end });
  }
}

// Drops the Reserve all bookkeeping for one date of a stored line.
function forgetDate(line, date) {
  for (const field of ["progress", "claims", "booked"]) {
    if (line[field]?.[date] !== undefined) {
      const { [date]: _, ...rest } = line[field];
      line[field] = rest;
    }
  }
}

// Takes `gone` dates out of the stored tray's lines; a line left with no
// dates goes, a repeat keeps the rest as onlyDates and starts at the first
// of them (a repeat day, as every expanded date is), so a leftover whose old
// first date has passed can still be reserved. Other dates are untouched.
function removeDates(tray, gone) {
  tray.lines = tray.lines.flatMap((l) => {
    const dates = expandDates(l);
    const out = dates.filter((d) => gone.has(keyOf(l.id, d)));
    if (!out.length) return [l];
    const left = dates.filter((d) => !gone.has(keyOf(l.id, d)));
    if (!left.length) return [];
    const next = { ...l };
    for (const d of out) forgetDate(next, d);
    if (next.repeat) {
      next.onlyDates = left;
      next.date = left[0];
    }
    return [next];
  });
}

const problemsText = (problems) => `Can't reserve yet:\n${problems.map((p) => `• ${esc(p)}`).join("\n")}`;
const ownsSomething = (tray, runId) => !!tray.posts?.[runId] || tray.lines.some((l) => Object.values(l.claims || {}).includes(runId));
// Another run's leftovers: claims or a posts record. A run that takes the
// tray took it from no one or from a run gone quiet for 15 minutes (runs
// last at most 5), so every other run's leftovers are abandoned to it.
const othersLeftovers = (tray, runId) => Object.keys(tray.posts || {}).some((id) => id !== runId)
  || tray.lines.some((l) => Object.values(l.claims || {}).some((by) => by !== runId));
// Runs that ended or were taken over are remembered this long, so an SQS
// redelivery of one stops instead of acting as a new press.
const ENDED_KEEP_MS = 24 * 60 * 60 * 1000;

// Lines whose every date is a leftover of some run (claimed or posted): they
// are finished, not booked, so their details aren't checked again.
function leftoverOnly(tray, line) {
  const dates = expandDates(line);
  const posted = new Set(Object.values(tray.posts || {}).flatMap(keysOf));
  return dates.length > 0 && dates.every((d) => line.progress?.[d] || posted.has(keyOf(line.id, d)));
}

function remember(tray, ids, at) {
  const ended = Object.fromEntries(Object.entries(tray.ended || {}).filter(([, t]) => at - Number(t) < ENDED_KEEP_MS));
  for (const id of ids) ended[id] = at;
  tray.ended = Object.keys(ended).length ? ended : null;
}

// Taking the tray from no one or from a run gone quiet for 15 minutes (runs
// last at most 5): every other run's claims become this run's, in the same
// version-checked write, and those runs are remembered as ended. Their posts
// records stay under their ids for this run to finish; an ended run never
// touches them again.
function adoptInto(tray, runId, at) {
  const others = new Set();
  if (tray.running?.runId && tray.running.runId !== runId) others.add(tray.running.runId);
  for (const l of tray.lines) {
    for (const [d, by] of Object.entries(l.claims || {})) {
      if (by === runId) continue;
      others.add(by);
      l.claims = { ...l.claims, [d]: runId };
    }
  }
  for (const id of Object.keys(tray.posts || {})) if (id !== runId) others.add(id);
  if (others.size || tray.ended) remember(tray, others, at);
}

const keysOf = (record) => (record.entries || []).flatMap((e) => entryDates(e).map((d) => keyOf(e.lineId, d)));

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
  // tray in place by line id and date, so applying it again is harmless.
  // Never throws.
  async function persist(state, user, change, what) {
    let tray = structuredClone(state.tray);
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

  // Marks a backend's dates "started" before anything is written.
  // { ok, changed, taken }: the dates this run may write, those whose line was
  // edited or removed meanwhile, those another run marked meanwhile.
  // { notOwner }: another run holds the tray. { failed }: the store failed or
  // kept losing races to the member's own edits. Nothing is written on either.
  async function claimGroup(state, user, runId, want) {
    let tray = structuredClone(state.tray);
    try {
      for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
        if (!tray || tray.running?.runId !== runId) return { notOwner: true };
        const lines = new Map(tray.lines.map((l) => [l.id, l]));
        const ok = [];
        const changed = [];
        const taken = [];
        for (const pick of want) {
          const l = lines.get(pick.w.line.id);
          if (!l || bookingFields(l) !== bookingFields(pick.w.line)) changed.push(pick);
          else if (l.progress?.[pick.date]) taken.push(pick);
          else ok.push(pick);
        }
        if (!ok.length) return { ok, changed, taken };
        for (const { w, date } of ok) {
          const l = lines.get(w.line.id);
          l.progress = { ...(l.progress || {}), [date]: "started" };
          l.claims = { ...(l.claims || {}), [date]: runId };
        }
        const expectVersion = tray.version;
        if (await trayStore.putTray(user, tray, { expectVersion })) {
          state.tray = { ...tray, version: expectVersion + 1 };
          return { ok, changed, taken };
        }
        tray = await trayStore.getTray(user);
      }
    } catch (error) {
      log.error("claiming tray dates failed", { error });
    }
    return { failed: true };
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

  // Sorts the line's dates: this run's own (or adopted) done (to post) and
  // started (to report and drop), another live run's (left alone), dates a
  // posts record already covers, and the rest, which are re-checked when this
  // run may book.
  async function prepareLine(line, runId, canBook, adopt, postedKeys, clients) {
    const skipped = [];
    const drop = [];
    const entry = findItem(catalog, line.item);
    const adapter = entry && adapters[entry.backend];
    if (!adapter?.bookMany) return { skipped: canBook ? [{ text: `${line.item} can no longer be booked.` }] : [], drop };
    const w = { line, entry, adapter, booked: new Map(), free: [] };
    const dates = [];
    for (const d of expandDates(line)) {
      const progress = line.progress?.[d];
      if (!progress) {
        dates.push(d);
      } else if (postedKeys.has(keyOf(line.id, d))) {
        // Posted by its run; tidied away with that run's record.
      } else if (line.claims?.[d] !== runId && !adopt) {
        if (canBook) skipped.push(skip(line.item, d, "still being reserved by an earlier press"));
      } else if (progress === "done" && line.booked?.[d]) {
        w.booked.set(d, line.booked[d]);
      } else {
        skipped.push(skip(line.item, d, MAYBE_TEXT));
        drop.push(keyOf(line.id, d));
      }
    }
    if (!canBook || !dates.length) return { w, skipped, drop };
    let result;
    try {
      // clients: the member's account will write, which some backends need to say a date is bookable.
      result = await adapter.checkDates({ dates, start: line.start, end: line.end, items: [entry], ...(clients ? { clients } : {}) });
    } catch (error) {
      log.warn("re-checking a tray line failed", { backend: adapter.backend, error });
      result = {};
    }
    for (const d of dates) {
      const r = result?.[d];
      if (!r) skipped.push(skip(line.item, d, "couldn't check it, please try again"));
      else if (r.unavailable) skipped.push(skip(line.item, d, r.unavailable));
      else if (r.conflicts?.length) {
        const who = r.conflicts.map((c) => [c.holder || "someone", c.title].filter(Boolean).join(" · ")).join("; ");
        skipped.push(skip(line.item, d, `${fmtRange(line.start, line.end)} (${who})`));
      } else w.free.push(d);
    }
    return { w, skipped, drop };
  }

  // What gets posted and recorded for one tray line: plain data, kept in the
  // posts record so a redelivery can finish the ledger without the line.
  function entryOf(w) {
    const { line } = w;
    return {
      lineId: line.id, item: line.item, start: line.start, end: line.end, title: line.title, repeat: line.repeat ?? null,
      refs: [...w.booked.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
  }

  function summaryOf(e, runId) {
    const dates = entryDates(e);
    const range = fmtRange(e.start, e.end);
    if (!e.repeat) return { summary: `${e.item} · ${fmtDay(dates[0])} · ${range} · ${e.title}`, ref: e.refs[0][1] ?? undefined, count: 1 };
    const every = repeatText({ ...e.repeat, until: null });
    return {
      summary: `${e.item} · ${every} ${monthDay(dates[0])} – ${monthDay(dates.at(-1))} (${dates.length} dates) · ${range} · ${e.title}`,
      seriesId: `${e.lineId}-${runId}`, count: dates.length,
    };
  }

  async function writeLedger(user, channel, runId, record, today) {
    for (const e of record.entries) {
      const refs = e.refs.map(([, ref]) => ref).filter(Boolean);
      try {
        if (e.repeat) {
          await ledger?.recordSeries(user, {
            id: `${e.lineId}-${runId}`, item: e.item, start: e.start, end: e.end, title: e.title,
            repeat: e.repeat, channel, postTs: record.ts, refs,
          }, { today });
        } else {
          for (const ref of refs) await ledger?.recordBooking(user, ref, { today });
        }
      } catch (error) {
        log.error("booking ledger write failed", { error });
      }
    }
  }

  async function run({ user, channel, client, runId, responseUrl = null }) {
    if (!trayStore || !user || !channel || !runId) return;
    const where = { channel, user, responseUrl };
    const ctx = context();

    // 1–2. Load the tray, refuse what can't be reserved yet, take the run.
    // A run with its own unfinished bookings (a redelivery) always finishes
    // them, holding the tray or not.
    const state = { tray: null };
    let owner = false;
    let problems = [];
    // Nothing is booked before the run holds the tray, so a failure here is
    // told to the member rather than thrown (a throw would hold up their queue).
    try {
      for (let attempt = 0; attempt < 2 && !state.tray; attempt++) {
        const stored = await trayStore.getTray(user);
        // A redelivery of a run that ended, or whose leftovers another run took
        // over: nobody pressed anything, so nothing happens.
        if (stored?.ended?.[runId]) {
          log.info("reserve all run already ended", { runId });
          return;
        }
        if (!stored?.lines?.length && !stored?.posts?.[runId]) {
          return replyCard(client, where, await cardWith(stored ?? emptyTray(), EMPTY_TEXT, client));
        }
        const mine = ownsSomething(stored, runId);
        // A line whose item left the catalog is skipped, not refused; one with
        // only leftovers of some run is finished, not checked.
        problems = trayProblems({ ...stored, lines: stored.lines.filter((l) => findItem(catalog, l.item) && !leftoverOnly(stored, l)) }, ctx);
        const at = now().getTime();
        const { running } = stored;
        const busy = running && running.runId !== runId && at - Number(running.at) < RUN_STALE_MS;
        // Leftovers are finished first, even when the rest can't be reserved yet.
        if (problems.length && !mine && (busy || !othersLeftovers(stored, runId))) {
          return replyCard(client, where, await cardWith(stored, problemsText(problems), client));
        }
        if (busy) {
          if (!mine) return postPrivately(client, where, { text: BUSY_TEXT });
          state.tray = stored;
          break;
        }
        const tray = { ...structuredClone(stored), running: { runId, at } };
        adoptInto(tray, runId, at);
        if (await trayStore.putTray(user, tray, { expectVersion: stored.version })) {
          state.tray = { ...tray, version: stored.version + 1 };
          owner = true;
        }
      }
    } catch (error) {
      log.error("reserve all could not load the tray", { runId, error });
      return postPrivately(client, where, { text: ERROR_TEXT });
    }
    // Lost twice: someone else is changing the tray, so nothing is written.
    if (!state.tray) return;

    // Every way out lets go of the tray, unless another run has taken it.
    let released = !owner;
    const release = (t) => {
      if (owner && t.running?.runId === runId) {
        t.running = null;
        remember(t, [runId], now().getTime());
      }
    };
    try {
      await reserve({ user, channel, client, runId, where, ctx, state, owner, problems, release, onReleased: () => { released = true; } });
    } finally {
      if (!released) await persist(state, user, release, "release");
    }
  }

  async function reserve({ user, channel, client, runId, where, ctx, state, owner, problems, release, onReleased }) {
    const skipped = [];
    const drop = new Set(); // this run's uncertain dates: reported and taken out
    const clear = new Set(); // this run's claims that turned out bookable again
    let revoked = false;
    let connectFirst = null; // "none" | "revoked": the member must connect before booking
    let requester = null;
    let record = state.tray.posts?.[runId] ?? null;
    // Posts records of abandoned runs: recorded in the ledger if they weren't,
    // then tidied away with their dates.
    const adopted = owner && !record
      ? Object.entries(state.tray.posts || {}).filter(([id]) => id !== runId)
      : [];

    if (!record) {
      // 3. Whose account writes.
      let member = { status: "none" };
      if (owner && !problems.length) {
        try {
          requester = await requesterFor(client, user);
          member = await memberClients(user);
        } catch (error) {
          log.error("reserve all could not start", { error });
          return postPrivately(client, where, { text: `⚠️ I couldn't reserve your tray (${esc(errorText(error))}). Please try again.` });
        }
        if (member.status === "none" || member.status === "revoked") {
          connectFirst = member.status;
          // Nothing of this run's to finish: just ask, the tray stays as it is.
          if (!ownsSomething(state.tray, runId) && !othersLeftovers(state.tray, runId)) {
            try {
              await promptTray({ client, channel, user, requester, revoked: connectFirst === "revoked" });
            } catch (error) {
              log.error("reserve all connect prompt failed", { error });
              await postPrivately(client, where, { text: ERROR_TEXT });
            }
            return;
          }
        }
      }
      const canBook = owner && !connectFirst && !problems.length;
      const clients = member.clients ?? null;

      // 4. Sort and re-check every date.
      const postedKeys = new Set(Object.values(state.tray.posts || {}).flatMap(keysOf));
      const prepared = await Promise.all(structuredClone(state.tray.lines).map((l) => prepareLine(l, runId, canBook, owner, postedKeys, clients)));
      const work = prepared.map((p) => p.w).filter(Boolean);
      for (const p of prepared) {
        skipped.push(...p.skipped);
        for (const k of p.drop) drop.add(k);
      }
      skipOverlaps(work, skipped);

      // 5–6. Write each backend's free dates in one go.
      let stop = null; // "notOwner": another run holds the tray; "failed": the store failed
      const backends = canBook ? [...new Set(work.filter((w) => w.free.length).map((w) => w.entry.backend))] : [];
      for (const backend of backends) {
        if (revoked || stop === "notOwner") break;
        const group = work.filter((w) => w.entry.backend === backend && w.free.length);
        const want = group.flatMap((w) => w.free.map((date) => ({ w, date })));
        const claim = stop ? { failed: true } : await claimGroup(state, user, runId, want);
        if (claim.notOwner) {
          // The run holding the tray books the rest; this one only finishes its own.
          stop = "notOwner";
          break;
        }
        if (claim.failed) {
          stop = "failed";
          for (const { w, date } of want) skipped.push(skip(w.line.item, date, "not booked, please press Reserve all again"));
          continue;
        }
        for (const { w, date } of claim.changed) skipped.push(skip(w.line.item, date, "changed while reserving"));
        for (const { w, date } of claim.taken) skipped.push(skip(w.line.item, date, "still being reserved by an earlier press"));
        if (!claim.ok.length) continue;
        const adapter = adapters[backend];
        const bookings = claim.ok.map(({ w, date }) => bookingFor(w, date, requester));
        let results;
        try {
          results = await adapter.bookMany(bookings, clients ? { clients } : {});
        } catch (error) {
          results = bookings.map(() => ({ status: "error", error }));
        }
        const forbidden = new Map();
        claim.ok.forEach(({ w, date }, i) => {
          const r = results?.[i];
          const key = keyOf(w.line.id, date);
          if (r?.status === "booked") {
            w.booked.set(date, r.ref ?? null);
            return;
          }
          if (r?.status === "unavailable") {
            clear.add(key);
            skipped.push(skip(w.line.item, date, r.reason));
            return;
          }
          const kind = clients ? classifyWriteError(r?.error) : "error";
          if (kind === "revoked") {
            // Refused before writing: stays in the tray for after connecting.
            clear.add(key);
            revoked = true;
          } else if (kind === "forbidden") {
            clear.add(key);
            forbidden.set(w, [...(forbidden.get(w) || []), date]);
          } else {
            // It may have been written: never written again, so it leaves the tray.
            drop.add(key);
            metric("ReservationFailed", 1, { dimensions: { Flow: "reservations" }, fields: { backend, stage: "reserve_all" } });
            log.error("reserve all write failed", { backend, error: r?.error });
            skipped.push(skip(w.line.item, date, `couldn't be saved, ${MAYBE_TEXT}`, `couldn't save (${errorText(r?.error)}), ${MAYBE_TEXT}`));
          }
        });
        for (const [w, dates] of forbidden) {
          skipped.push({ text: `${w.line.item} · ${daysText(dates)} · ${forbiddenText(adapter, { items: [w.entry] })}` });
        }
        const outcome = new Map(claim.ok.map(({ w, date }) => [keyOf(w.line.id, date), w.booked.get(date)]));
        await persist(state, user, (t) => {
          for (const l of t.lines) {
            for (const d of Object.keys(l.claims || {})) {
              const key = keyOf(l.id, d);
              if (l.claims[d] !== runId || !outcome.has(key)) continue;
              if (outcome.get(key) !== undefined) {
                l.progress = { ...l.progress, [d]: "done" };
                l.booked = { ...(l.booked || {}), [d]: outcome.get(key) };
              } else if (clear.has(key)) {
                forgetDate(l, d);
              }
            }
          }
        }, "progress");
        if (revoked) {
          try {
            await connect.authStore.markRevoked(user);
            connect.memberGoogle.forget(user);
          } catch (error) {
            log.error("marking a revoked grant failed", { error });
          }
        }
      }

      // From here things are written: failures are logged, never thrown,
      // so an SQS retry can't run the writes again.
      const entries = work.filter((w) => w.booked.size).map(entryOf);
      if (stop === "notOwner" && !entries.length && !drop.size) {
        // Nothing of this run's to finish, and the tray is another run's.
        onReleased();
        return;
      }
      const total = entries.reduce((n, e) => n + e.refs.length, 0);
      if (total) metric("ReservationBooked", total, { dimensions: { Flow: "reservations" }, fields: { reserveAll: true, asMember: !!clients } });

      // 8. One public post, remembered at once so it is never posted twice.
      if (entries.length) {
        let ts = null;
        try {
          const booked = entries.map((e) => summaryOf(e, runId));
          const message = combinedMessage({ user, booked, skipped: skipped.map((s) => ({ text: s.text })) });
          booked.forEach((b, i) => {
            if (!message.blocks[i + 1]?.accessory) log.warn("booked line has no Cancel button: its ref is too big", { summary: b.summary });
          });
          const res = await client.chat.postMessage({ channel, ...BOT_PERSONA, ...message });
          ts = res?.ts ?? null;
        } catch (error) {
          log.error("reserve all post failed", { error });
        }
        const posted = { ts, entries, ledger: false };
        record = posted;
        await persist(state, user, (t) => {
          t.posts = { ...(t.posts || {}), [runId]: posted };
        }, "posted");
      }
    } else {
      // A redelivery of a run that already posted: its own unfinished dates
      // are reported and dropped; nothing is booked or posted again.
      for (const l of state.tray.lines) {
        for (const [d, by] of Object.entries(l.claims || {})) {
          if (by === runId && l.progress?.[d] === "started") {
            drop.add(keyOf(l.id, d));
            skipped.push(skip(l.item, d, MAYBE_TEXT));
          }
        }
      }
    }

    // 7. The ledger, so "mine" and Cancel find these bookings.
    for (const [id, r] of adopted) {
      if (r.ledger) continue;
      await writeLedger(user, channel, id, r, ctx.today);
      await persist(state, user, (t) => {
        if (t.posts?.[id]) t.posts[id] = { ...t.posts[id], ledger: true };
      }, "ledger");
    }
    if (record && !record.ledger) {
      await writeLedger(user, channel, runId, record, ctx.today);
      await persist(state, user, (t) => {
        if (t.posts?.[runId]) t.posts[runId] = { ...t.posts[runId], ledger: true };
      }, "ledger");
    }

    // 9. The tray keeps only what wasn't booked. Only this run's dates are
    // touched, plus other runs' dates that were already posted and recorded.
    const mineGone = new Set([...(record ? keysOf(record) : []), ...adopted.flatMap(([, r]) => keysOf(r)), ...drop]);
    const adoptedIds = new Set(adopted.map(([id]) => id));
    const finished = await persist(state, user, (t) => {
      const gone = new Set(mineGone);
      for (const [id, r] of Object.entries(t.posts || {})) {
        if (id === runId || adoptedIds.has(id) || !(r.ts && r.ledger)) continue;
        for (const e of r.entries || []) for (const d of entryDates(e)) gone.add(keyOf(e.lineId, d));
      }
      for (const l of t.lines) {
        for (const d of Object.keys(l.claims || {})) {
          if (l.claims[d] === runId && clear.has(keyOf(l.id, d))) forgetDate(l, d);
        }
      }
      removeDates(t, gone);
      if (t.posts) {
        const left = Object.fromEntries(Object.entries(t.posts).filter(([id, r]) => id !== runId && !adoptedIds.has(id) && !(r.ts && r.ledger)));
        t.posts = Object.keys(left).length ? left : null;
      }
      release(t);
    }, "finish");
    if (finished) onReleased();

    // 10. The private result, with the tray as it is now.
    const total = (record?.entries || []).reduce((n, e) => n + e.refs.length, 0);
    try {
      const n = `${total} booking${total === 1 ? "" : "s"}`;
      const head = !total ? "Nothing could be booked."
        : record.ts ? `✅ Reserved ${n}. It's posted in the channel.`
          : `✅ Reserved ${n}, but I couldn't post them in the channel.`;
      const lines = problems.length ? [problemsText(problems)] : [];
      lines.push(...skipped.slice(0, NOTICE_SKIPS).map((s) => `• ${esc(String(s.detail ?? s.text).slice(0, NOTICE_SKIP_MAX))}`));
      if (skipped.length > NOTICE_SKIPS) lines.push(`…and ${skipped.length - NOTICE_SKIPS} more.`);
      await replyCard(client, where, await cardWith(state.tray, [head, ...lines].join("\n"), client));
    } catch (error) {
      log.error("reserve all result failed", { error });
    }

    // 11. Each affected digest period once.
    const periods = new Map();
    for (const e of record?.entries || []) {
      for (const d of entryDates(e)) {
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

    // 12. Connect (again), then the rest is reserved.
    if (revoked || connectFirst) {
      try {
        await promptTray({ client, channel, user, requester, revoked: revoked || connectFirst === "revoked" });
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
