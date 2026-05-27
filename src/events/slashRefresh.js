async function postResponseUrl(url, text) {
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
  return async function handleSlashRefresh({ envelope }) {
    let text;
    try {
      const count = await genderMapService.invalidate();
      text = `Refreshed gender map. ${count} entries loaded.`;
    } catch (err) {
      text = `Refresh failed: ${err.message}`;
    }
    await postResponseUrl(envelope.response_url, text);
  };
}
