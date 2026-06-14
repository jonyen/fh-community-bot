import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPhotoService } from "../../src/lib/photos.js";

function fakeResponse(ok, bytes = "bytes") {
  return {
    ok,
    status: ok ? 200 : 403,
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(bytes).buffer),
  };
}

describe("PhotoService", () => {
  let mockDrive;
  let mockFetch;
  let service;

  beforeEach(() => {
    mockDrive = {
      uploadPhoto: vi.fn().mockImplementation(({ name }) =>
        Promise.resolve({
          fileId: `id-${name}`,
          imageUrl: `https://lh3.googleusercontent.com/d/id-${name}`,
          viewUrl: `https://drive.google.com/file/d/id-${name}/view`,
        })
      ),
    };
    mockFetch = vi.fn().mockResolvedValue(fakeResponse(true));
    service = createPhotoService({
      driveService: mockDrive,
      slackBotToken: "xoxb-123",
      fetchImpl: mockFetch,
    });
  });

  it("downloads each image with the bot token and uploads to Drive", async () => {
    const photos = await service.collectPhotos([
      { id: "F1", name: "leak.jpg", mimetype: "image/jpeg", url_private_download: "https://files.slack.com/leak" },
    ]);

    expect(mockFetch).toHaveBeenCalledWith("https://files.slack.com/leak", {
      headers: { Authorization: "Bearer xoxb-123" },
    });
    expect(mockDrive.uploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ name: "leak.jpg", mimeType: "image/jpeg" })
    );
    expect(photos).toEqual([
      {
        imageUrl: "https://lh3.googleusercontent.com/d/id-leak.jpg",
        viewUrl: "https://drive.google.com/file/d/id-leak.jpg/view",
        name: "leak.jpg",
      },
    ]);
  });

  it("ignores non-image files", async () => {
    const photos = await service.collectPhotos([
      { id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private_download: "https://files.slack.com/pdf" },
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(photos).toEqual([]);
  });

  it("skips a failed download but keeps the others (graceful degradation)", async () => {
    mockFetch
      .mockResolvedValueOnce(fakeResponse(false))
      .mockResolvedValueOnce(fakeResponse(true));

    const photos = await service.collectPhotos([
      { id: "F1", name: "bad.jpg", mimetype: "image/jpeg", url_private_download: "u1" },
      { id: "F2", name: "good.jpg", mimetype: "image/jpeg", url_private_download: "u2" },
    ]);

    expect(photos).toHaveLength(1);
    expect(photos[0].name).toBe("good.jpg");
  });

  it("returns [] for empty or missing files", async () => {
    expect(await service.collectPhotos([])).toEqual([]);
    expect(await service.collectPhotos(undefined)).toEqual([]);
  });
});
