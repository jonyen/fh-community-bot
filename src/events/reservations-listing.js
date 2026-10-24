// src/events/reservations-listing.js
// The private listing card in #reservations: browse and search what can be
// reserved and collect it into a tray. The tray, the member's place in the
// list and the line being edited live in one stored row per member, so the
// card's buttons carry only ids. Every press re-renders the card through its
// response_url (an ephemeral can't be chat.update'd).
import { log } from "../lib/logger.js";
import { nyToday, nyParts, fmtDay } from "../lib/reservation-time.js";
import { CATEGORY_NAMES, categoryCounts, findItem } from "../lib/reservation-catalog.js";
import { BOT_PERSONA } from "../lib/reservation-format.js";
import { emptyTray, newLine, expandDates, lineProblems, whenOf, restartDates, hasClaims, MAX_LINES } from "../lib/reservation-tray.js";
import {
  listingMessage, filterCatalog, PAGE_SIZE, LISTING_ACTIONS,
  LIST_SEARCH_ACTION, LIST_CATEGORY_ACTION, LIST_PAGE_ACTION, LIST_ADD_ACTION, LIST_EDIT_ACTION, TRAY_CLEAR_ACTION, LIST_CLOSE_ACTION,
} from "../lib/reservation-listing.js";
import {
  lineFormMessage, readLineForm, FORM_ACTIONS,
  FORM_DATE_ACTION, FORM_START_ACTION, FORM_END_ACTION, FORM_REPEAT_ACTION, FORM_DAYS_ACTION, FORM_UNTIL_ACTION,
  FORM_SAVE_ACTION, FORM_REMOVE_ACTION, FORM_BACK_ACTION,
} from "../lib/reservation-line-form.js";

const SEARCH_MAX = 60;
const MATCH_TTL_MS = 10 * 60 * 1000;
const MATCH_CACHE_MAX = 200;
const TAKEN_SHOWN = 5;
const NO_TABLE_TEXT = "Booking from here isn't set up yet. Book directly in the room sheet, kitchen sheet or calendar.";
const FULL_TEXT = `Your tray is full (${MAX_LINES} lines). Reserve or remove some first.`;
const EXPIRED_TEXT = "Your tray expired after a day without changes, so it was cleared.";
const RACE_TEXT = "Something changed. Please try again.";
const ERROR_TEXT = "⚠️ Something went wrong. Please try again.";
const LINE_GONE_TEXT = "That line was reserved or removed meanwhile.";
const LINE_MOVED_TEXT = "That line was partly reserved meanwhile. Go back to the list to see what's left, then change it.";
const LINE_CLAIMED_TEXT = "Some of that line's dates are still being reserved. Change its date, time or repeat once that's done.";
const REQUEST_ADDED_TEXT = "Added to your tray. Check the details, then press *Reserve all*.";
const REQUEST_FULL_TEXT = `Your tray is full (${MAX_LINES} lines), so I couldn't add all of that. Reserve or remove some first.`;
const PICKERS = new Set([FORM_DATE_ACTION, FORM_START_ACTION, FORM_END_ACTION, FORM_REPEAT_ACTION, FORM_DAYS_ACTION, FORM_UNTIL_ACTION]);

// Sheet text (holder names, reasons) goes into mrkdwn.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cutSearch = (s) => String(s ?? "").trim().slice(0, SEARCH_MAX);
// What a stored line's dates are made from, including what Reserve all left of them.
const datesStamp = (l) => JSON.stringify([whenOf(l), l.onlyDates ?? null]);

export function createListingFlow({ catalog, adapters, llm, catalogText, trayStore = null, now = () => new Date(), withMentions }) {
  const categories = Object.keys(CATEGORY_NAMES).filter((id) => catalog.some((e) => e.category === id));
  // Lowercased query -> { labels, at }. Insertion order doubles as age order.
  const matchCache = new Map();

  // Catalog labels the model says fit the search; null when it couldn't say.
  async function modelMatch(q) {
    const key = q.toLowerCase();
    const hit = matchCache.get(key);
    if (hit && now().getTime() - hit.at < MATCH_TTL_MS) return hit.labels;
    matchCache.delete(key);
    let labels;
    try {
      labels = await llm.matchItems(q, { catalogText });
    } catch (error) {
      log.warn("item search by model failed", { error });
      labels = null;
    }
    if (!Array.isArray(labels)) return null;
    const valid = labels.map((l) => findItem(catalog, l)?.label).filter(Boolean);
    if (matchCache.size >= MATCH_CACHE_MAX) matchCache.delete(matchCache.keys().next().value);
    matchCache.set(key, { labels: valid, at: now().getTime() });
    return valid;
  }

  async function matching(view) {
    const literal = filterCatalog(catalog, view);
    const q = cutSearch(view.q);
    if (literal.length || !q) return { matches: literal, byModel: false };
    const labels = await modelMatch(q);
    if (!labels) return { matches: [], byModel: false };
    const wanted = new Set(labels);
    const matches = catalog.filter((e) => wanted.has(e.label) && (view.c === "all" || !view.c || e.category === view.c));
    return { matches, byModel: matches.length > 0 };
  }

  function context() {
    const at = now();
    return { today: nyToday(at), nowMin: nyParts(at.toISOString()).min, catalog };
  }

  // What the line's dates look like right now, as mrkdwn (already escaped).
  // "" when the line isn't complete enough to check. memo, shared by one
  // redraw's checks, lets a sheet backend read its sheet once for them all.
  async function lineCheck(line, client = null, memo = null) {
    const entry = findItem(catalog, line.item);
    const adapter = entry && adapters[entry.backend];
    if (!adapter?.checkDates || line.start == null || line.end == null || line.end <= line.start) return "";
    const dates = expandDates(line);
    if (!dates.length) return "";
    let result;
    try {
      result = await adapter.checkDates({ dates, start: line.start, end: line.end, items: [entry], ...(memo ? { memo } : {}) });
    } catch (error) {
      log.warn("checking a tray line failed", { backend: adapter.backend, error });
      return "";
    }
    const reason = dates.map((d) => result[d]?.unavailable).find(Boolean);
    if (reason) return `⚠️ ${esc(reason)}`;
    const taken = dates.filter((d) => result[d]?.conflicts?.length);
    if (!taken.length) return dates.length === 1 ? "✅ free" : `✅ all ${dates.length} dates free`;
    const shown = taken.slice(0, TAKEN_SHOWN);
    const people = new Map(await Promise.all(shown.map(async (d) => {
      const conflicts = client && withMentions ? await withMentions(client, result[d].conflicts) : result[d].conflicts;
      const names = [...new Set(conflicts.map((r) => (r.holderUserId ? `<@${r.holderUserId}>` : esc(r.holder || "someone"))))];
      return [d, names.join(", ")];
    })));
    if (dates.length === 1) return `❌ taken by ${people.get(dates[0])}`;
    const list = shown.map((d) => `${fmtDay(d)} (${people.get(d)})`);
    if (taken.length > TAKEN_SHOWN) list.push("…");
    return `⚠️ ${taken.length} of ${dates.length} dates taken: ${list.join(", ")}`;
  }

  async function listingFor(tray, { notice = null, client }) {
    const { matches, byModel } = await matching(tray.view);
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const p = Math.min(Math.max(tray.view.p || 0, 0), pages - 1);
    // One sheet read per backend for the whole redraw (Sheets read quota).
    const memo = new Map();
    const statuses = await Promise.all(tray.lines.map(async (l) => [l.id, await lineCheck(l, client, memo)]));
    return listingMessage({
      items: matches.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), total: matches.length, view: { ...tray.view, p }, categories,
      tray: tray.lines, lineStatus: Object.fromEntries(statuses), notice, searchedByModel: byModel, catalog,
    });
  }

  async function formFor(tray, { withProblems, client, notice = null }) {
    const line = tray.editing;
    const check = await lineCheck(line, client);
    const problems = withProblems ? lineProblems(line, context()).map(esc) : [];
    return lineFormMessage({
      line, entry: findItem(catalog, line.item), check, problems, notice, inTray: tray.lines.some((l) => l.id === line.id),
    });
  }

  // Read-modify-write of the member's tray. change(tray, { fresh }) edits it
  // in place and says what to show. A lost race reloads once and re-applies.
  async function mutate(user, change) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stored = await trayStore.getTray(user);
      const tray = stored ? structuredClone(stored) : emptyTray();
      const expectVersion = stored ? stored.version : 0;
      const outcome = change(tray, { fresh: !stored });
      if (await trayStore.putTray(user, tray, { expectVersion })) return { tray: { ...tray, version: expectVersion + 1 }, outcome };
    }
    return null;
  }

  // Nothing here books anything, so a failure is told to the member, not
  // thrown: a thrown error would hold up the member's queue of events.
  async function post({ channel, user, search, client }) {
    try {
      if (!trayStore) {
        return await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, text: `${categoryCounts(catalog)}\n${NO_TABLE_TEXT}` });
      }
      const view = { q: cutSearch(search), c: "all", p: 0 };
      // A new card starts on the list: a draft left from an older card is dropped.
      const saved = await mutate(user, (tray) => { tray.view = view; tray.editing = null; });
      // Lost twice: show the card anyway; the next press saves the view.
      const tray = saved?.tray ?? { ...emptyTray(), view };
      return await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, ...(await listingFor({ ...tray, editing: null }, { client })) });
    } catch (error) {
      log.error("posting the listing card failed", { error });
      try {
        await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, text: ERROR_TEXT });
      } catch (replyError) {
        log.error("listing failure reply failed", { error: replyError });
      }
    }
  }

  // /reserve with a booking request: its items go into the tray as lines with
  // the request's day, time and title, and the card shows them. Nothing is
  // booked until the member presses Reserve all, so nothing here is thrown.
  async function postRequest({ channel, user, req, client }) {
    if (!trayStore) return post({ channel, user, search: null, client });
    try {
      const saved = await mutate(user, (tray) => {
        tray.view = { q: "", c: "all", p: 0 };
        tray.editing = null;
        let added = 0;
        for (const entry of req.items) {
          if (tray.lines.length >= MAX_LINES) break;
          tray.lines.push({
            ...newLine(entry.label, null),
            date: req.date, start: req.start, end: req.end, title: req.title || null,
            appliances: entry.category === "kitchen" ? { ...(req.appliances || {}) } : {},
          });
          added++;
        }
        return { added };
      });
      if (!saved) return await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, text: RACE_TEXT });
      const notice = saved.outcome.added < req.items.length ? REQUEST_FULL_TEXT : REQUEST_ADDED_TEXT;
      return await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, ...(await listingFor({ ...saved.tray, editing: null }, { notice, client })) });
    } catch (error) {
      log.error("adding a request to the tray failed", { error });
      try {
        await client.chat.postEphemeral({ channel, user, ...BOT_PERSONA, text: ERROR_TEXT });
      } catch (replyError) {
        log.error("tray request failure reply failed", { error: replyError });
      }
    }
  }

  // What a press does to the tray, and which screen follows.
  function apply(tray, action, values) {
    const id = action.action_id;
    const listing = (notice = null) => ({ screen: "listing", notice });
    const form = (withProblems = false, notice = null) => ({ screen: "form", withProblems, notice });
    if (id === LIST_SEARCH_ACTION) {
      tray.view = { ...tray.view, q: cutSearch(action.value), p: 0 };
      return listing();
    }
    if (id === LIST_CATEGORY_ACTION) {
      const typed = values.list_search?.[LIST_SEARCH_ACTION];
      tray.view = { q: typed ? cutSearch(typed.value) : tray.view.q, c: action.selected_option?.value || "all", p: 0 };
      return listing();
    }
    if (id === LIST_PAGE_ACTION) {
      const p = Math.floor(Number(action.value));
      tray.view = { ...tray.view, p: Number.isFinite(p) && p > 0 ? p : 0 };
      return listing();
    }
    if (id === LIST_ADD_ACTION) {
      const entry = findItem(catalog, action.value);
      if (!entry) return listing(`${esc(String(action.value ?? ""))} can no longer be booked.`);
      if (tray.lines.length >= MAX_LINES) return listing(FULL_TEXT);
      tray.editing = newLine(entry.label, tray.lines.at(-1));
      return form();
    }
    if (id === LIST_EDIT_ACTION) {
      const line = tray.lines.find((l) => l.id === action.value);
      if (!line) return listing();
      // fromTray: Save finds the stored line again and keeps its bookkeeping;
      // when/stamp say what its dates were when the form opened.
      tray.editing = { ...structuredClone(line), fromTray: { when: whenOf(line), stamp: datesStamp(line) } };
      return form();
    }
    if (id === TRAY_CLEAR_ACTION) {
      tray.lines = [];
      tray.editing = null;
      return listing("Tray cleared.");
    }
    // The form's buttons and pickers act on the draft; a press on a form
    // whose draft is gone (saved, or left, elsewhere) shows the list.
    if (!tray.editing) return listing();
    if (PICKERS.has(id)) {
      tray.editing = readLineForm(values, tray.editing);
      return form(true);
    }
    if (id === FORM_SAVE_ACTION) {
      const { fromTray, ...draft } = readLineForm(values, tray.editing);
      const at = tray.lines.findIndex((l) => l.id === draft.id);
      if (fromTray) {
        // Reserve all may have booked or narrowed the line since Edit: never
        // put back dates it took out.
        if (at < 0) {
          tray.editing = null;
          return listing(LINE_GONE_TEXT);
        }
        const stored = tray.lines[at];
        const changed = whenOf(draft) !== fromTray.when;
        if (changed && hasClaims(stored)) {
          tray.editing = readLineForm(values, tray.editing);
          return form(true, LINE_CLAIMED_TEXT);
        }
        if (changed && datesStamp(stored) !== fromTray.stamp) {
          tray.editing = readLineForm(values, tray.editing);
          return form(true, LINE_MOVED_TEXT);
        }
        // Only what the form edits; the item and bookkeeping stay the stored line's.
        const next = { ...stored, title: draft.title, appliances: draft.appliances };
        if (changed) restartDates(Object.assign(next, { date: draft.date, start: draft.start, end: draft.end, repeat: draft.repeat }));
        tray.lines[at] = next;
      } else if (at >= 0) tray.lines[at] = draft;
      else if (tray.lines.length >= MAX_LINES) return listing(FULL_TEXT);
      else tray.lines.push(draft);
      tray.editing = null;
      return listing();
    }
    if (id === FORM_REMOVE_ACTION) {
      tray.lines = tray.lines.filter((l) => l.id !== tray.editing.id);
      tray.editing = null;
      return listing();
    }
    if (id === FORM_BACK_ACTION) {
      tray.editing = null;
      return listing();
    }
    return listing();
  }

  async function reply(responseUrl, message) {
    try {
      const res = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.delete_original ? message : { replace_original: true, ...message }),
      });
      if (!res.ok) log.warn("replacing the listing card failed", { status: res.status });
    } catch (error) {
      log.warn("replacing the listing card failed", { error });
    }
  }

  // The card is ephemeral, so only its asker can press it; the presser owns the tray.
  // Nothing here books anything, so a failure is told, not thrown (see post).
  async function handleAction({ payload, action, client }) {
    const user = payload.user?.id;
    const responseUrl = payload.response_url;
    if (!trayStore || !user || !responseUrl) return;
    // Close only dismisses the card; the tray stays for the next one.
    if (action.action_id === LIST_CLOSE_ACTION) return reply(responseUrl, { delete_original: true });
    try {
      const values = payload.state?.values || {};
      const saved = await mutate(user, (tray, { fresh }) => (fresh ? { screen: "listing", notice: EXPIRED_TEXT } : apply(tray, action, values)));
      if (!saved) {
        const tray = (await trayStore.getTray(user)) ?? emptyTray();
        return await reply(responseUrl, await listingFor({ ...tray, editing: null }, { notice: RACE_TEXT, client }));
      }
      const { tray, outcome } = saved;
      const message = outcome.screen === "form"
        ? await formFor(tray, { withProblems: outcome.withProblems, notice: outcome.notice, client })
        : await listingFor(tray, { notice: outcome.notice, client });
      return await reply(responseUrl, message);
    } catch (error) {
      log.error("listing card press failed", { action: action?.action_id, error });
      return reply(responseUrl, { replace_original: false, response_type: "ephemeral", text: ERROR_TEXT });
    }
  }

  // Reserve all is handled by reservations-reserve-all.js, which draws its
  // result with listingFor.
  return { post, postRequest, handleAction, lineCheck, listingFor, ACTIONS: new Set([...LISTING_ACTIONS, ...FORM_ACTIONS]) };
}
