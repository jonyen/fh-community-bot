import { dispatchSlackEvent } from "./dispatch.js";
import { getDeps } from "./clients.js";

export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler, slashRefreshHandler, reservationHandler, maintenanceFormHandler, onestopChannelId } = getDeps();

  for (const record of sqsEvent.Records || []) {
    const slackEnvelope = JSON.parse(record.body);
    await dispatchSlackEvent({
      slackEnvelope,
      handler: mentionHandler,
      genderHandler,
      slashRefreshHandler,
      reservationHandler,
      maintenanceFormHandler,
      onestopChannelId,
      client,
    });
  }
}
