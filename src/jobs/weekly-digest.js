import cron from "node-cron";

export function createWeeklyDigest({ sheetsService, ollamaService, slackClient, channelId }) {
  async function run() {
    const openIssues = await sheetsService.getOpenIssues();

    if (openIssues.length === 0) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: "No outstanding issues this week. All clear!",
      });
      return;
    }

    const summary = await ollamaService.generateDigest(openIssues);

    if (summary) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `*Weekly Maintenance Digest*\n\n${summary}`,
      });
    } else {
      const fallback = openIssues
        .map((i) => `• #${i.id}: ${i.description} (${i.status})`)
        .join("\n");
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `*Weekly Maintenance Digest*\n\nCouldn't generate AI summary. Open issues:\n${fallback}`,
      });
    }
  }

  function schedule(cronExpression, timezone) {
    cron.schedule(cronExpression, run, { timezone });
  }

  return { run, schedule };
}
