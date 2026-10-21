// src/lib/reservation-listing.js
// The private listing card: a paged, searchable list of what can be reserved,
// with the member's tray under it. Pure message building, no I/O; the
// interaction handler decides what each action does.
import { CATEGORY_NAMES, categoryCounts } from "./reservation-catalog.js";
import { ROOMS } from "./rooms-catalog.js";
import { lineSummary } from "./reservation-tray.js";
import { fitSection } from "./reservation-card.js";

export const LIST_SEARCH_ACTION = "reservation_list_search";
export const LIST_CATEGORY_ACTION = "reservation_list_category";
export const LIST_PAGE_ACTION = "reservation_list_page";
export const LIST_ADD_ACTION = "reservation_list_add";
export const LIST_EDIT_ACTION = "reservation_list_edit";
export const TRAY_RESERVE_ACTION = "reservation_tray_reserve";
export const TRAY_CLEAR_ACTION = "reservation_tray_clear";
export const LISTING_ACTIONS = new Set([
  LIST_SEARCH_ACTION, LIST_CATEGORY_ACTION, LIST_PAGE_ACTION, LIST_ADD_ACTION, LIST_EDIT_ACTION, TRAY_RESERVE_ACTION, TRAY_CLEAR_ACTION,
]);

export const PAGE_SIZE = 8;
const SEARCH_MAX = 60;

const plain = (text) => ({ type: "plain_text", text });
const section = (text, accessory) => ({ type: "section", text: { type: "mrkdwn", text: fitSection(text) }, ...(accessory ? { accessory } : {}) });
const button = (action_id, text, value, extra = {}) => ({ type: "button", action_id, text: plain(text), ...(value != null ? { value } : {}), ...extra });
// Typed text goes into mrkdwn, where <!channel> would be a mention.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const roomAliases = new Map(ROOMS.map((r) => [r.name, r.aliases]));

export function filterCatalog(catalog, { q = "", c = "all" } = {}) {
  const needle = String(q).trim().toLowerCase();
  return catalog.filter((e) => {
    if (c !== "all" && e.category !== c) return false;
    if (!needle) return true;
    const names = [e.label, CATEGORY_NAMES[e.category] || "", ...(e.category === "rooms" ? roomAliases.get(e.label) || [] : [])];
    return names.some((n) => n.toLowerCase().includes(needle));
  });
}

function categorySelect(categories, c) {
  const options = [{ text: plain("All categories"), value: "all" }, ...categories.map((id) => ({ text: plain(CATEGORY_NAMES[id] || id), value: id }))];
  return {
    type: "static_select", action_id: LIST_CATEGORY_ACTION, placeholder: plain("Category"), options,
    initial_option: options.find((o) => o.value === c) || options[0],
  };
}

function itemSection(entry, tray) {
  const added = tray.find((l) => l.item === entry.label);
  const accessory = added
    ? button(LIST_EDIT_ACTION, "✓ Added", added.id)
    : button(LIST_ADD_ACTION, "+ Add", entry.label);
  return section(`*${esc(entry.label)}* · ${CATEGORY_NAMES[entry.category] || entry.category}`, accessory);
}

// items: this page's entries; total: how many match across all pages.
// catalog is only needed for the "nothing matches" overview.
export function listingMessage({ items, total, view, categories, tray, lineStatus = {}, notice = null, searchedByModel = false, catalog = [] }) {
  const q = String(view.q || "").slice(0, SEARCH_MAX);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(view.p || 0, 0), pages - 1);
  const header = q ? `📋 ${total} items match "${esc(q)}"` : `📋 Things you can reserve · ${total} items`;
  const blocks = [];
  if (notice) blocks.push(section(notice));
  blocks.push(section(header));
  if (searchedByModel) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "I searched for that for you. Change the search below if it's not right." }] });
  blocks.push({
    type: "input", block_id: "list_search", dispatch_action: true, optional: true, label: plain("Search"),
    element: {
      type: "plain_text_input", action_id: LIST_SEARCH_ACTION, max_length: SEARCH_MAX, placeholder: plain('Search, e.g. "tech", "youth"'),
      dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] }, ...(q ? { initial_value: q } : {}),
    },
  });
  blocks.push({ type: "actions", block_id: "list_category", elements: [categorySelect(categories, view.c || "all")] });

  if (items.length === 0) {
    const overview = categoryCounts(catalog);
    const none = q ? `Nothing matches "${esc(q)}".` : `Nothing to reserve in ${CATEGORY_NAMES[view.c] || "this category"}.`;
    blocks.push(section(`${none}${overview ? `\n${overview}` : ""}`));
  } else {
    for (const e of items.slice(0, PAGE_SIZE)) blocks.push(itemSection(e, tray));
    const nav = [
      ...(p > 0 ? [button(LIST_PAGE_ACTION, "◀ Prev", String(p - 1))] : []),
      ...(p < pages - 1 ? [button(LIST_PAGE_ACTION, "Next ▶", String(p + 1))] : []),
    ];
    if (nav.length) blocks.push({ type: "actions", block_id: "list_nav", elements: nav });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Page ${p + 1} of ${pages}` }] });
  }

  if (tray.length) {
    blocks.push({ type: "divider" });
    blocks.push(section(`*Your tray (${tray.length})*`));
    for (const line of tray) {
      const status = lineStatus[line.id];
      blocks.push(section(esc(lineSummary(line)) + (status ? ` · ${esc(status)}` : ""), button(LIST_EDIT_ACTION, "Edit", line.id)));
    }
    blocks.push({
      type: "actions", block_id: "tray_actions",
      elements: [
        button(TRAY_RESERVE_ACTION, "Reserve all", "all", { style: "primary" }),
        button(TRAY_CLEAR_ACTION, "Clear", "all", {
          confirm: { title: plain("Clear your tray?"), text: plain("This removes every item you've collected."), confirm: plain("Clear"), deny: plain("Keep it") },
        }),
      ],
    });
  }
  return { text: q ? `${total} items match "${esc(q)}"` : "Things you can reserve", blocks };
}
