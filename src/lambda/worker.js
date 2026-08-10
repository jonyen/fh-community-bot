import { dispatchSlackEvent } from "./dispatch.js";
import { getDeps } from "./clients.js";
import { log, metric, withCorrelationId } from "../lib/logger.js";

const DIMENSIONS = { Lambda: "worker" };

export async function handler(sqsEvent) {
  const { client, handler: mentionHandler, genderHandler, slashRefreshHandler, reservationHandler, maintenanceFormHandler, onestopChannelId } = getDeps();

  for (const record of sqsEvent.Records || []) {
    // The SQS message id ties every line from this event back together, and it
    // survives a redrive — a message replayed from the DLQ logs under the same
    // id as its original attempt.
    await withCorrelationId(record.messageId, async () => {
      const slackEnvelope = JSON.parse(record.body);
      const startedAt = Date.now();

      log.info("event received", { eventType: slackEnvelope?.event?.type });

      try {
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
        metric("EventProcessed", 1, { dimensions: DIMENSIONS });
        log.info("event processed", { durationMs: Date.now() - startedAt });
      } catch (error) {
        // Rethrow so SQS retries and, after maxReceiveCount, routes to the DLQ.
        // The metric and the log line are what make that visible before the
        // DLQ depth alarm fires.
        metric("EventFailed", 1, { dimensions: DIMENSIONS });
        log.error("event failed", { error, durationMs: Date.now() - startedAt });
        throw error;
      }
    });
  }
}
