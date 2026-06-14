import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDriveService } from "../../src/services/drive.js";

describe("DriveService", () => {
  let mockDrive;
  let service;

  beforeEach(() => {
    mockDrive = {
      files: {
        create: vi.fn().mockResolvedValue({
          data: { id: "FILE123", webViewLink: "https://drive.google.com/file/d/FILE123/view" },
        }),
      },
      permissions: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    service = createDriveService(mockDrive, "FOLDER1");
  });

  it("uploads into the configured folder and returns image + view URLs", async () => {
    const result = await service.uploadPhoto({
      buffer: Buffer.from("img-bytes"),
      name: "leak.jpg",
      mimeType: "image/jpeg",
    });

    expect(mockDrive.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { name: "leak.jpg", parents: ["FOLDER1"] },
        media: expect.objectContaining({ mimeType: "image/jpeg" }),
        fields: "id, webViewLink",
      })
    );
    expect(result).toEqual({
      fileId: "FILE123",
      imageUrl: "https://lh3.googleusercontent.com/d/FILE123",
      viewUrl: "https://drive.google.com/file/d/FILE123/view",
    });
  });

  it("shares the uploaded file anyone-with-link reader", async () => {
    await service.uploadPhoto({ buffer: Buffer.from("x"), name: "a.png", mimeType: "image/png" });

    expect(mockDrive.permissions.create).toHaveBeenCalledWith({
      fileId: "FILE123",
      requestBody: { role: "reader", type: "anyone" },
    });
  });

  it("omits parents when no folder is configured", async () => {
    const noFolder = createDriveService(mockDrive, null);
    await noFolder.uploadPhoto({ buffer: Buffer.from("x"), name: "a.png", mimeType: "image/png" });

    expect(mockDrive.files.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { name: "a.png" } })
    );
  });
});
