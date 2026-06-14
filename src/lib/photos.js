export function createPhotoService({ driveService, slackBotToken, fetchImpl = fetch }) {
  function isImage(file) {
    return (file.mimetype || "").startsWith("image/");
  }

  async function collectPhotos(files) {
    const images = (files || []).filter(isImage);
    const photos = [];

    for (const file of images) {
      try {
        const url = file.url_private_download || file.url_private;
        const resp = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${slackBotToken}` },
        });
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);

        const buffer = Buffer.from(await resp.arrayBuffer());
        const uploaded = await driveService.uploadPhoto({
          buffer,
          name: file.name || `${file.id}.img`,
          mimeType: file.mimetype,
        });

        photos.push({
          imageUrl: uploaded.imageUrl,
          viewUrl: uploaded.viewUrl,
          name: file.name || uploaded.fileId,
        });
      } catch (err) {
        console.error("photo upload failed:", err.message);
      }
    }

    return photos;
  }

  return { collectPhotos };
}
