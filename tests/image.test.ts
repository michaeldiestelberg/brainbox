import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  MODEL_IMAGE_MAX_SIDE,
  MODEL_IMAGE_TARGET_BYTES,
  prepareImageForModel,
} from '../src/image.js';

/** Noisy PNG so compression has real payload to work against (solid fills compress too well). */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) {
    pixels[i] = (i * 17 + (i % 251)) & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

test('viewport-sized screenshots are always re-encoded under the byte budget', async () => {
  const input = await noisyPng(1440, 900);
  assert.ok(input.byteLength > MODEL_IMAGE_TARGET_BYTES, 'fixture should start above the budget');

  const prepared = await prepareImageForModel(input);

  assert.equal(prepared.mediaType, 'image/jpeg');
  assert.equal(prepared.originalBytes, input.byteLength);
  assert.ok(prepared.bytes <= MODEL_IMAGE_TARGET_BYTES);
  assert.ok(prepared.bytes < prepared.originalBytes);
  assert.ok(Math.max(prepared.width, prepared.height) <= MODEL_IMAGE_MAX_SIDE);
  assert.equal((await sharp(prepared.buffer).metadata()).format, 'jpeg');
});

test('oversized images are downscaled and stay under the byte budget', async () => {
  const input = await noisyPng(3000, 2000);
  const prepared = await prepareImageForModel(input);

  assert.equal(prepared.mediaType, 'image/jpeg');
  assert.ok(prepared.bytes <= MODEL_IMAGE_TARGET_BYTES);
  assert.ok(Math.max(prepared.width, prepared.height) <= MODEL_IMAGE_MAX_SIDE);
});

test('small images are not upscaled but still become JPEG under budget', async () => {
  const input = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  }).png().toBuffer();

  const prepared = await prepareImageForModel(input);

  assert.equal(prepared.mediaType, 'image/jpeg');
  assert.equal(prepared.width, 320);
  assert.equal(prepared.height, 240);
  assert.ok(prepared.bytes <= MODEL_IMAGE_TARGET_BYTES);
});

test('unreadable image data returns a clear error', async () => {
  await assert.rejects(
    () => prepareImageForModel(Buffer.from('not-an-image')),
    /Input buffer|unsupported|Vips|Image has no readable dimensions|unsupported image format/i,
  );
});
