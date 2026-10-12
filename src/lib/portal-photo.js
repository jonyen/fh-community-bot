import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES } from "../services/rentManagerTwa.js";

// Slack's previews, largest first. Slack makes them for formats it can't show
// inline too, so an iPhone HEIC still has PNG previews.
const THUMB_KEYS = ["thumb_1024", "thumb_960", "thumb_800", "thumb_720", "thumb_480", "thumb_360"];

// Where to fetch a Slack image so the portal will take it. The portal only
// accepts GIF, JPEG and PNG up to 5 MB, and iPhones send HEIC. Decoding a
// 24-megapixel HEIC needs more memory than the worker has, so anything the
// portal won't take as-is comes from Slack's largest preview instead and is
// re-encoded as JPEG. Returns null when there's nothing usable.
export function portalPhotoSource(file) {
  const original = file.url_private_download || file.url_private;
  const fits = ALLOWED_PHOTO_TYPES.has(file.mimetype) && (!file.size || file.size <= MAX_PHOTO_BYTES);
  if (fits && original) return { url: original, name: file.name || `${file.id}.img`, convert: false };

  const thumbKey = THUMB_KEYS.find((k) => file[k]);
  if (!thumbKey) return null;
  const base = (file.name || file.id || "photo").replace(/\.[^.]+$/, "");
  return { url: file[thumbKey], name: `${base}.jpg`, convert: true };
}

// Re-encodes a PNG or JPEG buffer as JPEG.
export function toJpeg(buffer, mimeType, quality = 85) {
  if (mimeType === "image/jpeg") return buffer;
  if (mimeType !== "image/png") throw new Error(`can't convert ${mimeType || "unknown type"} to JPEG`);
  const { width, height, data } = PNG.sync.read(buffer);
  return jpeg.encode({ width, height, data }, quality).data;
}
