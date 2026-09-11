const assert = require('node:assert/strict');
const { test } = require('node:test');
const sharp = require('sharp');
const { MAX_DIMENSION, WEBP_QUALITY, optimizeProductImage } = require('../src/modules/productColours/productImageOptimization.service');

test('Product images decode, orient, resize, strip metadata, and store as quality-90 WebP', async (t) => {
  assert.equal(MAX_DIMENSION, 1600);
  assert.equal(WEBP_QUALITY, 90);
  for (const format of ['jpeg', 'png', 'webp']) {
    await t.test(`${format} input is accepted`, async () => {
      const input = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#123456' } })[format]().withMetadata({ orientation: 1 }).toBuffer();
      const output = await optimizeProductImage(input);
      const metadata = await sharp(output.buffer).metadata();
      assert.equal(output.contentType, 'image/webp');
      assert.equal(output.extension, 'webp');
      assert.equal(metadata.format, 'webp');
      assert.deepEqual([metadata.width, metadata.height], [1200, 800]);
      assert.equal(metadata.exif, undefined);
    });
  }

  await t.test('large input preserves aspect ratio at the maximum dimension', async () => {
    const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
    const output = await optimizeProductImage(input);
    assert.deepEqual([output.width, output.height], [1600, 1200]);
  });

  await t.test('small input is never upscaled', async () => {
    const input = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#fedcba' } }).png().toBuffer();
    const output = await optimizeProductImage(input);
    assert.deepEqual([output.width, output.height], [800, 800]);
  });

  await t.test('corrupt and unsupported input is rejected cleanly', async () => {
    await assert.rejects(optimizeProductImage(Buffer.from('not an image')), /Unable to process this image/);
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } }).gif().toBuffer();
    await assert.rejects(optimizeProductImage(gif), /Unable to process this image/);
  });
});
