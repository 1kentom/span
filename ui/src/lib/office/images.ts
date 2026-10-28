/** Embedded document images: MIME from magic bytes (never from names), size caps, data URLs. */
import { bytesToDataUrl } from '../viewer';

export const MAX_DOC_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DOC_IMAGES_TOTAL = 48 * 1024 * 1024;
export const MAX_DOC_IMAGES = 300;

export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return undefined;
}

/** Tracks the image budget of one document. */
export class ImageBudget {
  private count = 0;
  private total = 0;
  constructor(private readonly maxEach = MAX_DOC_IMAGE_BYTES, private readonly maxTotal = MAX_DOC_IMAGES_TOTAL, private readonly maxCount = MAX_DOC_IMAGES) {}
  /** A data URL for a raster image within budget, or the reason it is not shown. */
  take(bytes: Uint8Array | undefined): { src: string } | { omitted: string } {
    if (!bytes) return { omitted: 'Image missing from the file' };
    const mime = sniffImageMime(bytes);
    if (!mime) return { omitted: 'Image format not shown in the preview' };
    if (bytes.length > this.maxEach) return { omitted: 'Image too large for the preview' };
    if (this.count >= this.maxCount || this.total + bytes.length > this.maxTotal) return { omitted: 'Image budget of the preview reached' };
    this.count++; this.total += bytes.length;
    return { src: bytesToDataUrl(bytes, mime) };
  }
}
