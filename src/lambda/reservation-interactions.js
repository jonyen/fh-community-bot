// src/lambda/reservation-interactions.js
// The parts of a reservation card that Slack wants answered within 3 seconds,
// so the receiver handles them itself: opening the Edit modal (the trigger_id
// expires), the item typeahead, and inline modal errors. Everything else goes
// to the worker through the queue.
import { decodeCard, EDIT_ACTION } from "../lib/reservation-card.js";
import { buildEditModal, modalErrors, itemOptions, MODAL_CALLBACK, ITEM_ACTION } from "../lib/reservation-modal.js";

export async function handleReservationInteraction(payload, { catalog, openView }) {
  if (payload.type === "block_suggestion") {
    if (payload.action_id !== ITEM_ACTION) return { handled: false };
    return { handled: true, response: { options: itemOptions(catalog, payload.value) } };
  }

  if (payload.type === "block_actions") {
    const edit = (payload.actions || []).find((a) => a.action_id === EDIT_ACTION);
    if (!edit) return { handled: false };
    const card = decodeCard(edit.value, catalog);
    // Someone else's press is answered by the worker.
    if (!card || card.user !== payload.user?.id) return { handled: false };
    const cardTs = payload.container?.message_ts || payload.message?.ts;
    await openView({
      trigger_id: payload.trigger_id,
      response_url: payload.response_url,
      view: buildEditModal({
        user: card.user,
        channel: payload.channel?.id || payload.container?.channel_id,
        threadTs: payload.message?.thread_ts || cardTs,
        cardTs,
        req: card.req,
      }),
    });
    return { handled: true };
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === MODAL_CALLBACK) {
    const errors = modalErrors(payload.view);
    if (errors) return { handled: true, response: { response_action: "errors", errors } };
  }
  return { handled: false };
}
