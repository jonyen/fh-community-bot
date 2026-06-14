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

    // No public permission is set: the org disallows "anyone with link" sharing,
    // and these links are for internal viewers who can already see the folder
    // (the file inherits the folder's sharing).
    return {
      fileId,
      viewUrl: res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
    };
  }

  return { uploadPhoto };
}
