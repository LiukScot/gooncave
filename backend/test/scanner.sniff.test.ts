// Contract for sniffMediaKind: the real media kind comes from magic bytes,
// not the filename. Uses real temp files so file-type sees actual bytes.
import './helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import os from 'os';
import path from 'path';

import sharp from 'sharp';

import { sniffMediaKind } from '../src/lib/scanner';

// A real PNG built by sharp — file-type needs more than the bare signature.
let pngBytes: Buffer;
before(async () => {
  pngBytes = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 255, g: 0, b: 0 }
    }
  })
    .png()
    .toBuffer();
});

// A minimal MP4 header: a `ftyp` box with the `isom` brand at offset 4.
const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32
]);

const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT ?? os.tmpdir();

const writeTemp = async (name: string, contents: Buffer): Promise<string> => {
  const filePath = path.join(tmpRoot, `sniff-${Date.now()}-${name}`);
  await fs.promises.writeFile(filePath, contents);
  return filePath;
};

test('detects an image from its magic bytes', async () => {
  const filePath = await writeTemp('real.png', pngBytes);
  assert.equal(await sniffMediaKind(filePath), 'IMAGE');
});

test('detects a video from its magic bytes', async () => {
  const filePath = await writeTemp('clip.mp4', MP4_HEADER);
  assert.equal(await sniffMediaKind(filePath), 'VIDEO');
});

test('reports the true kind regardless of the file extension', async () => {
  // PNG bytes behind a .jpg name: content wins, so the route can spot the lie.
  const filePath = await writeTemp('spoofed.jpg', pngBytes);
  assert.equal(await sniffMediaKind(filePath), 'IMAGE');
});

test('returns null for content that is neither image nor video', async () => {
  const filePath = await writeTemp(
    'payload.jpg',
    Buffer.from('<html>not an image</html>')
  );
  assert.equal(await sniffMediaKind(filePath), null);
});
