import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';

import { createChatwootAdThumbnail } from '../src/api/integrations/chatbot/chatwoot/chatwootAdThumbnail';

test('ad thumbnail is a 320x180 PNG with a centered cover crop, without stretching or bars', async () => {
  // A wide source with a green 320px center and red/blue 160px outer bands.
  // Cover must crop both outer bands; contain/stretch would preserve them.
  const pixels = Buffer.alloc(640 * 180 * 3);
  for (let y = 0; y < 180; y++) {
    for (let x = 0; x < 640; x++) pixels[(y * 640 + x) * 3 + (x < 160 ? 0 : x < 480 ? 1 : 2)] = 255;
  }
  const input = await sharp(pixels, { raw: { width: 640, height: 180, channels: 3 } }).jpeg().toBuffer();
  const output = await createChatwootAdThumbnail(input);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 180);
  const stats = await sharp(output).stats();
  assert.ok(stats.channels[0].mean < 3, 'red outer band should be cropped');
  assert.ok(stats.channels[1].mean > 250, 'green center should fill the thumbnail');
  assert.ok(stats.channels[2].mean < 3, 'blue outer band should be cropped');
});

test('ad thumbnail rejects invalid image input instead of passing it as an attachment', async () => {
  await assert.rejects(createChatwootAdThumbnail(Buffer.from('invalid local fixture')));
});
