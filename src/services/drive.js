import { Readable } from "node:stream";

export function createDriveService(driveClient, folderId) {
  async function uploadPhoto({ buffer, name, mimeType }) {
    const res = await driveClient.files.create({
      requestBody: {
        name,
        ...(folderId ? { parents: [folderId] } : {}),
      },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id, webViewLink",
    });

    const fileId = res.data.id;

    await driveClient.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    return {
      fileId,
      imageUrl: `https://lh3.googleusercontent.com/d/${fileId}`,
      viewUrl: res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
    };
  }

  return { uploadPhoto };
}
