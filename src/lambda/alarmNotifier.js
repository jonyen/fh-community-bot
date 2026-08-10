// Posts CloudWatch alarm state changes into Slack.
//
// Its own Lambda subscribed to an SNS topic rather than something the bot
// calls: the alarms that matter most fire because the bot is broken, so the
// alert path must not share the bot's code path. SNS fans out, so an email
// subscription can be added to the same topic without touching this function —
// worth doing, since a Slack outage is precisely when this cannot deliver.

import { WebClient } from "@slack/web-api";
import { log } from "../lib/logger.js";

function format(message) {
  let alarm;
  try {
    alarm = JSON.parse(message);
  } catch {
    return `⚠️ Alarm notification\n\`\`\`\n${message}\n\`\`\``;
  }

  if (!alarm || typeof alarm !== "object" || !alarm.AlarmName) {
    return `⚠️ Alarm notification\n\`\`\`\n${message}\n\`\`\``;
  }

  const firing = alarm.NewStateValue === "ALARM";
  const icon = firing ? "🔴" : alarm.NewStateValue === "OK" ? "✅" : "ℹ️";
  const verb = firing ? "FIRING" : alarm.NewStateValue === "OK" ? "RESOLVED" : alarm.NewStateValue;

  const lines = [`${icon} *${verb}* — \`${alarm.AlarmName}\``];
  if (alarm.AlarmDescription) lines.push(alarm.AlarmDescription);
  if (alarm.NewStateReason) lines.push(`\n_${alarm.NewStateReason}_`);
  if (alarm.Trigger?.MetricName) {
    lines.push(`\nMetric: \`${alarm.Trigger.Namespace}/${alarm.Trigger.MetricName}\``);
  }
  lines.push("\nRunbook: `docs/RUNBOOK.md`");

  return lines.join("\n");
}

export async function handler(event, _context, deps = {}) {
  const channel = process.env.ALARM_CHANNEL;
  const client = deps.client ?? new WebClient(process.env.SLACK_BOT_TOKEN);
  const records = event?.Records ?? [];

  // allSettled, not all: one undeliverable alarm must not swallow the others.
  await Promise.allSettled(
    records.map(async (record) => {
      const text = format(record?.Sns?.Message ?? "");
      try {
        await client.chat.postMessage({ channel, text });
      } catch (error) {
        // Nothing left to escalate to. Log loudly and return success so SNS
        // does not retry into an ongoing Slack outage.
        log.error("alarm notification could not be delivered", { error, text });
      }
    }),
  );
}
