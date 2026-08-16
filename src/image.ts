import sharp from 'sharp';

/** Soft cap on longest side; further reduced if the byte budget is still exceeded. */
export const MODEL_IMAGE_MAX_SIDE = 1536;
const MODEL_IMAGE_MIN_SIDE = 640;
/** Target payload size for model-bound images (Kimi bills by bytes, not pixels). */
export const MODEL_IMAGE_TARGET_BYTES = 100_000;
const JPEG_QUALITIES = [80, 70, 60, 50, 40] as const;

export type PreparedModelImage = {
  buffer: Buffer;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  originalBytes: number;
  bytes: number;
};

async function encodeJpeg(
  input: Buffer,
  side: number,
  quality: number,
  originalBytes: number,
  fallbackWidth: number,
  fallbackHeight: number,
): Promise<PreparedModelImage> {
  const buffer = await sharp(input, { failOn: 'none', animated: false })
    .rotate()
    .resize({
      width: side,
      height: side,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  const out = await sharp(buffer).metadata();
  return {
    buffer,
    mediaType: 'image/jpeg',
    width: out.width ?? fallbackWidth,
    height: out.height ?? fallbackHeight,
    originalBytes,
    bytes: buffer.byteLength,
  };
}

/**
 * Always re-encode as JPEG and keep the payload under MODEL_IMAGE_TARGET_BYTES
 * by lowering quality and, if needed, shrinking dimensions.
 */
export async function prepareImageForModel(input: Buffer): Promise<PreparedModelImage> {
  const originalBytes = input.byteLength;
  const meta = await sharp(input, { failOn: 'none', animated: false }).rotate().metadata();
  const srcWidth = meta.width ?? 0;
  const srcHeight = meta.height ?? 0;
  if (srcWidth < 1 || srcHeight < 1) {
    throw new Error('Image has no readable dimensions.');
  }

  let side = Math.min(Math.max(srcWidth, srcHeight), MODEL_IMAGE_MAX_SIDE);
  let best: PreparedModelImage | undefined;

  for (;;) {
    for (const quality of JPEG_QUALITIES) {
      const candidate = await encodeJpeg(input, side, quality, originalBytes, srcWidth, srcHeight);
      if (!best || candidate.bytes < best.bytes) best = candidate;
      if (candidate.bytes <= MODEL_IMAGE_TARGET_BYTES) return candidate;
    }

    if (side <= MODEL_IMAGE_MIN_SIDE) break;
    const next = Math.max(MODEL_IMAGE_MIN_SIDE, Math.floor(side * 0.75));
    if (next >= side) break;
    side = next;
  }

  if (!best) throw new Error('Unable to encode image as JPEG.');
  return best;
}
