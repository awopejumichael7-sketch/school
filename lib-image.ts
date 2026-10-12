import { UserFacingError } from './lib-errors';

export const MAX_LOGO_CHARS = 60_000; // firestore.rules allows 70,000

/**
 * Shrinks a logo to a small data URL so it can live in Firestore (Spark has no
 * Cloud Storage). Output stays well under the rules limit.
 */
export async function fileToLogoDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    throw new UserFacingError('Please choose a PNG, JPG or WebP image.');
  }
  if (file.size > 8 * 1024 * 1024) throw new UserFacingError('That image is too large (max 8 MB).');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new UserFacingError('That image could not be read. Try a different file.');
  });
  try {
    for (const size of [256, 192, 128, 96]) {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new UserFacingError('Your browser cannot process images.');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const q of [0.85, 0.7, 0.5]) {
        const url = canvas.toDataURL('image/webp', q);
        if (url.length <= MAX_LOGO_CHARS) return url;
      }
      const png = canvas.toDataURL('image/png');
      if (png.length <= MAX_LOGO_CHARS) return png;
    }
  } finally {
    bitmap.close();
  }
  throw new UserFacingError('That logo is too detailed to store. Please use a simpler image.');
}
