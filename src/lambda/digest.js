// src/lambda/digest.js
// Monday and Friday 8 AM: posts the weekday (Mon–Thu) or weekend (Fri–Sun)
// living digest, chosen by the schedule's input. Later bookings edit it in
// place (see services/livingDigest.js).
import { getDeps } from "./clients.js";
import { log } from "../lib/logger.js";

export async function handler(event) {
  const { livingDigest } = getDeps();
  if (!livingDigest) {
    log.warn("digest skipped: RESERVATIONS_CHANNEL_ID not set");
    return;
  }
  await livingDigest.post(event?.period === "weekend" ? "weekend" : "weekday");
}
