async function postResponseUrl(url, text) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
    if (!res.ok) console.warn(`[ephemeral] response_url POST returned ${res.status}`);
  } catch (err) {
    console.warn(`[ephemeral] response_url POST failed: ${err.message}`);
  }
}

export async function sendEphemeral({ client, channel, user, responseUrl, text }) {
  if (client && channel && user) {
    try {
      await client.chat.postEphemeral({ channel, user, text });
      return;
    } catch (err) {
      const code = err.data?.error || err.message;
      console.warn(`[ephemeral] postEphemeral failed (${code}); falling back to response_url`);
    }
  }
  await postResponseUrl(responseUrl, text);
}
