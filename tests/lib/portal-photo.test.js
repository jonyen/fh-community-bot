import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import { portalPhotoSource, toJpeg } from "../../src/lib/portal-photo.js";

describe("portalPhotoSource", () => {
  it("uses the original for a JPEG, PNG or GIF the portal accepts", () => {
    expect(portalPhotoSource({ id: "F1", name: "a.jpg", mimetype: "image/jpeg", size: 1000, url_private_download: "https://o", thumb_1024: "https://t" }))
      .toEqual({ url: "https://o", name: "a.jpg", convert: false });
  });

  it("falls back to the largest preview, as JPEG, for HEIC", () => {
    expect(portalPhotoSource({ id: "F1", name: "IMG_1.HEIC", mimetype: "image/heic", url_private: "https://o", thumb_720: "https://t720", thumb_960: "https://t960" }))
      .toEqual({ url: "https://t960", name: "IMG_1.jpg", convert: true });
  });

  it("falls back to a preview for an accepted type that's over 5 MB", () => {
    expect(portalPhotoSource({ id: "F1", name: "big.png", mimetype: "image/png", size: 9_000_000, url_private: "https://o", thumb_1024: "https://t" }))
      .toMatchObject({ url: "https://t", convert: true });
  });

  it("returns null when there's no usable version", () => {
    expect(portalPhotoSource({ id: "F1", name: "x.heic", mimetype: "image/heic", url_private: "https://o" })).toBeNull();
  });
});

describe("toJpeg", () => {
  it("re-encodes a PNG as JPEG", () => {
    const png = new PNG({ width: 3, height: 2 });
    png.data.fill(128);
    const out = toJpeg(PNG.sync.write(png), "image/png");
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("passes a JPEG through", () => {
    const buf = Buffer.from([0xff, 0xd8, 1]);
    expect(toJpeg(buf, "image/jpeg")).toBe(buf);
  });

  it("refuses anything else", () => {
    expect(() => toJpeg(Buffer.from("x"), "image/heic")).toThrow("can't convert image/heic");
  });
});
