const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

/**
 * True when a stored photo/attachment value can be shown in <img>:
 * a base64 image data URL (legacy / just picked) or a file URL ending in an image extension
 * (e.g. signed /api/files/signed/it_media/...jpg?exp=&sig=).
 */
export function isImageSrc(src) {
  const s = String(src || "").trim();
  if (!s) return false;
  if (s.startsWith("data:")) return s.startsWith("data:image/");
  if (s.startsWith("blob:")) return true;
  return IMAGE_EXT_RE.test(s.split(/[?#]/)[0]);
}
