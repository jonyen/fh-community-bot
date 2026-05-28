const BOT_USERNAME = "Gender Aliases";
const BOT_ICON_EMOJI = ":busts_in_silhouette:";

async function postResponseUrl(url, text) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
    if (!res.ok) {
      console.warn(`[slash] response_url POST returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`[slash] response_url POST failed: ${err.message}`);
  }
}

export function createSlashRefreshHandler({ genderMapService }) {
  return async function handleSlashRefresh({ envelope, client }) {
    let text;
    try {
      const count = await genderMapService.invalidate();
      text = `Refreshed gender map. ${count} entries loaded.`;
    } catch (err) {
      text = `Refresh failed: ${err.message}`;
    }

    if (client && envelope.channel_id && envelope.user_id) {
      try {
        await client.chat.postEphemeral({
          channel: envelope.channel_id,
          user: envelope.user_id,
          text,
          username: BOT_USERNAME,
          icon_emoji: BOT_ICON_EMOJI,
        });
        return;
      } catch (err) {
        const code = err.data?.error || err.message;
        console.warn(`[slash] postEphemeral failed (${code}); falling back to response_url`);
      }
    }

    await postResponseUrl(envelope.response_url, text);
  };
}
