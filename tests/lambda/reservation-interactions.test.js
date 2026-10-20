// tests/lambda/reservation-interactions.test.js
import { describe, it, expect, vi } from "vitest";
import { handleReservationInteraction } from "../../src/lambda/reservation-interactions.js";
import { buildCatalog } from "../../src/lib/reservation-catalog.js";
import { cardMessage, BOOK_ACTION, EDIT_ACTION } from "../../src/lib/reservation-card.js";
import { buildEditModal, MODAL_CALLBACK, ITEM_ACTION } from "../../src/lib/reservation-modal.js";

const SET2 = { label: "Tech Set 2", category: "tech", backend: "rms", calendarId: "t2" };
const CATALOG = buildCatalog({ rooms: true, kitchen: true, rms: [SET2] });
const REQ = { intent: "book", items: [SET2], ambiguous: [], unmatched: [], date: "2026-10-17", toDate: null, start: 840, end: 960, title: "Youth night", ministry: null, appliances: {} };
const card = cardMessage({ user: "U9", req: REQ, assessment: { state: "free" } });
const [bookButton, editButton] = card.blocks.find((b) => b.type === "actions").elements;

const press = (button, user = "U9") => ({
  type: "block_actions", trigger_id: "TRIG", user: { id: user },
  channel: { id: "CRES" }, container: { message_ts: "200.2", channel_id: "CRES" },
  message: { ts: "200.2", thread_ts: "200.1", blocks: card.blocks }, actions: [button],
});

describe("handleReservationInteraction", () => {
  it("opens the pre-filled Edit modal for the requester", async () => {
    const openView = vi.fn().mockResolvedValue();
    const r = await handleReservationInteraction(press(editButton), { catalog: CATALOG, openView });
    expect(r).toEqual({ handled: true });
    expect(openView).toHaveBeenCalledWith({
      trigger_id: "TRIG",
      view: buildEditModal({ user: "U9", channel: "CRES", threadTs: "200.1", cardTs: "200.2", req: REQ }),
    });
  });

  it("leaves Edit by someone else, and Book, to the worker", async () => {
    const openView = vi.fn();
    expect(await handleReservationInteraction(press(editButton, "U7"), { catalog: CATALOG, openView })).toEqual({ handled: false });
    expect(await handleReservationInteraction(press(bookButton), { catalog: CATALOG, openView })).toEqual({ handled: false });
    expect(await handleReservationInteraction(press({ action_id: "maintenance_submit" }), { catalog: CATALOG, openView })).toEqual({ handled: false });
    expect(openView).not.toHaveBeenCalled();
  });

  it("answers the item typeahead from the catalog", async () => {
    const r = await handleReservationInteraction({ type: "block_suggestion", action_id: ITEM_ACTION, value: "set 2" }, { catalog: CATALOG });
    expect(r).toEqual({ handled: true, response: { options: [{ text: { type: "plain_text", text: "Tech Set 2" }, value: "Tech Set 2" }] } });
  });

  it("returns inline errors for an invalid modal, and passes a valid one on", async () => {
    const view = buildEditModal({ user: "U9", channel: "CRES", threadTs: "200.1", cardTs: "200.2", req: REQ });
    const state = (end) => ({ values: {
      items: { [ITEM_ACTION]: { selected_options: [{ value: "Tech Set 2" }] } },
      date: { date: { selected_date: "2026-10-17" } },
      start: { start: { selected_time: "14:00" } },
      end: { end: { selected_time: end } },
      title: { title: { value: "x" } },
    } });
    const bad = await handleReservationInteraction({ type: "view_submission", view: { ...view, state: state("13:00") } }, { catalog: CATALOG });
    expect(bad).toEqual({ handled: true, response: { response_action: "errors", errors: { end: "End must be after start." } } });
    const good = await handleReservationInteraction({ type: "view_submission", view: { ...view, state: state("16:00") } }, { catalog: CATALOG });
    expect(good).toEqual({ handled: false });
  });

  it("ignores other modals", async () => {
    const r = await handleReservationInteraction({ type: "view_submission", view: { callback_id: "other" } }, { catalog: CATALOG });
    expect(r).toEqual({ handled: false });
    expect(MODAL_CALLBACK).not.toBe("other");
    expect(BOOK_ACTION).not.toBe(EDIT_ACTION);
  });
});
