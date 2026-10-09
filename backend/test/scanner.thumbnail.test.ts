// Contract for the grid thumbnail: a strip is cropped to the shape the grid
// shows it in, anything else is fitted whole. Uses real files so sharp
// produces real pixels.
import './helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

import { test } from 'bun:test';
import sharp from 'sharp';

import type { FileRecord } from '../src/db/types';
import {
  ANIMATED_THUMB_MAX_FRAMES,
  ANIMATED_THUMB_SUFFIX,
  CROPPED_THUMB_SUFFIX,
  removeReplacedThumbnail,
  scanLocalFile
} from '../src/lib/scanner';

const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT ?? os.tmpdir();

const writeImage = async (width: number, height: number): Promise<string> => {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'thumb-'));
  const filePath = path.join(dir, 'image.png');
  await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .png()
    .toFile(filePath);
  return filePath;
};

const scanWithThumb = async (
  filePath: string,
  existingFiles?: Map<string, FileRecord>,
  thumbnailsDir?: string
) => {
  const dir =
    thumbnailsDir ?? (await fs.promises.mkdtemp(path.join(tmpRoot, 'thumbs-')));
  const scanned = await scanLocalFile(filePath, {
    thumbnailsDir: dir,
    existingFiles
  });
  assert.ok(scanned, 'file should scan');
  return scanned;
};

test('a JPEG the decoder only warns about still gets a thumbnail and a hash', async () => {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'thumb-'));
  const filePath = path.join(dir, 'image.jpg');
  const jpeg = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .jpeg()
    .toBuffer();
  // The scan header ends with Ss, Se, Ah/Al. A baseline file says Se = 63;
  // anything else draws the same picture and a decoder warning.
  const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  const headerLength = jpeg.readUInt16BE(scan + 2);
  jpeg[scan + 2 + headerLength - 2] = 0;
  await fs.promises.writeFile(filePath, jpeg);
  await assert.rejects(() => sharp(filePath).toBuffer(), /SOS parameters/);

  const scanned = await scanWithThumb(filePath);
  assert.ok(scanned.thumbPath);
  assert.ok(scanned.phash);
});

test('an ordinary image keeps its whole shape inside the box', async () => {
  const scanned = await scanWithThumb(await writeImage(800, 600));
  assert.ok(scanned.thumbPath);
  assert.equal(scanned.thumbPath.endsWith(CROPPED_THUMB_SUFFIX), false);
  const meta = await sharp(scanned.thumbPath).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
});

test('a strip is cropped to the shape the grid shows it in', async () => {
  // 1:12: fitted whole this would come out 33px wide and the tile, which
  // crops to 1:2 anyway, would blow those 33 pixels across its full width.
  const scanned = await scanWithThumb(await writeImage(100, 1200));
  assert.ok(scanned.thumbPath);
  assert.ok(
    scanned.thumbPath.endsWith(CROPPED_THUMB_SUFFIX),
    `expected a cropped name, got ${scanned.thumbPath}`
  );
  const meta = await sharp(scanned.thumbPath).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 800);
});

test('a GIF gets a bounded animated thumbnail and replaces an old still thumbnail', async () => {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'thumb-'));
  const filePath = path.join(dir, 'animation.gif');
  await fs.promises.writeFile(filePath, Buffer.from(
    'R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAACAoRRACH5BAAKAAAALAAAAAACAAIAgAAA/wAAAAIChFEAOw==',
    'base64'
  ));
  const scanned = await scanWithThumb(filePath, recordFor(filePath, {
    width: 2,
    height: 2,
    thumbPath: '/thumbs/old.jpg'
  }));
  assert.ok(scanned.thumbPath?.endsWith(ANIMATED_THUMB_SUFFIX));
  const meta = await sharp(scanned.thumbPath).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.pages, 2);
  assert.ok(meta.width && meta.width <= 400);
});

test('a long GIF keeps only its first frames in the thumbnail', async () => {
  const frames = ANIMATED_THUMB_MAX_FRAMES + 10;
  const size = 4;
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'thumb-'));
  const filePath = path.join(dir, 'long.gif');
  // The encoder merges consecutive frames that look alike, so each one
  // gets a colour far from the one before it.
  const stills = await Promise.all(
    Array.from({ length: frames }, (_, frame) =>
      sharp({
        create: {
          width: size,
          height: size,
          channels: 3,
          background: { r: (frame * 97) % 256, g: (frame * 53) % 256, b: 0 }
        }
      })
        .png()
        .toBuffer()
    )
  );
  await sharp(stills, { join: { animated: true } }).gif().toFile(filePath);
  assert.equal((await sharp(filePath).metadata()).pages, frames);

  const scanned = await scanWithThumb(filePath);
  assert.ok(scanned.thumbPath?.endsWith(ANIMATED_THUMB_SUFFIX));
  assert.equal(
    (await sharp(scanned.thumbPath).metadata()).pages,
    ANIMATED_THUMB_MAX_FRAMES
  );
});

test('a tall-but-not-strip image is still kept whole', async () => {
  const scanned = await scanWithThumb(await writeImage(400, 700));
  assert.ok(scanned.thumbPath);
  assert.equal(scanned.thumbPath.endsWith(CROPPED_THUMB_SUFFIX), false);
});

const recordFor = (
  filePath: string,
  overrides: Partial<FileRecord>
): Map<string, FileRecord> => {
  const stats = fs.statSync(filePath);
  return new Map([
    [
      filePath,
      {
        id: 'file-1',
        folderId: 'folder-1',
        locationType: 'LOCAL',
        path: filePath,
        sizeBytes: BigInt(stats.size),
        mtime: new Date(stats.mtimeMs).toISOString(),
        sha256: 'deadbeef',
        mediaType: 'IMAGE',
        width: null,
        height: null,
        durationMs: null,
        phash: null,
        thumbPath: null,
        ...overrides
      } as FileRecord
    ]
  ]);
};

test('an unchanged file is left alone', async () => {
  const filePath = await writeImage(800, 600);
  const scanned = await scanWithThumb(
    filePath,
    recordFor(filePath, {
      width: 800,
      height: 600,
      thumbPath: '/thumbs/old.jpg'
    })
  );
  assert.equal(scanned.thumbPath, '/thumbs/old.jpg');
  assert.equal(scanned.sha256, 'deadbeef', 'nothing should be re-read');
});

test('a strip indexed before the crop rule has its thumbnail rebuilt', async () => {
  const filePath = await writeImage(100, 1200);
  const scanned = await scanWithThumb(
    filePath,
    recordFor(filePath, {
      width: 100,
      height: 1200,
      thumbPath: '/thumbs/old.jpg'
    })
  );
  assert.notEqual(scanned.thumbPath, '/thumbs/old.jpg');
  assert.ok(scanned.thumbPath?.endsWith(CROPPED_THUMB_SUFFIX));
});

test('a file whose mtime has sub-millisecond precision is still unchanged', async () => {
  const filePath = await writeImage(800, 600);
  // What a real filesystem hands back: ext4 keeps nanoseconds, so mtimeMs
  // arrives as 1778431917137.8853 while the stored timestamp is the
  // millisecond `new Date()` truncated it to. Compared raw those never match,
  // and every scan re-hashed and re-thumbnailed the whole library.
  const fractional = 1_778_431_917.8853;
  fs.utimesSync(filePath, fractional, fractional);
  assert.notEqual(
    fs.statSync(filePath).mtimeMs % 1,
    0,
    'the fixture needs a fractional mtime to be worth anything'
  );

  const scanned = await scanWithThumb(
    filePath,
    recordFor(filePath, { width: 800, height: 600, thumbPath: '/thumbs/o.jpg' })
  );
  assert.equal(scanned.sha256, 'deadbeef', 'the file should not be re-read');
  assert.equal(scanned.thumbPath, '/thumbs/o.jpg');
});

test('a file whose thumbnail never got written is retried', async () => {
  const filePath = await writeImage(800, 600);
  const scanned = await scanWithThumb(
    filePath,
    recordFor(filePath, { width: 800, height: 600, thumbPath: null })
  );
  assert.ok(
    scanned.thumbPath,
    'a missing thumbnail must not survive the reuse path'
  );
});

test('a rebuild leaves the replaced thumbnail for the caller to remove', async () => {
  const filePath = await writeImage(100, 1200);
  const thumbnailsDir = await fs.promises.mkdtemp(
    path.join(tmpRoot, 'thumbs-')
  );
  const orphan = path.join(thumbnailsDir, 'old.jpg');
  await fs.promises.writeFile(orphan, 'not really a jpeg');

  const scanned = await scanWithThumb(
    filePath,
    recordFor(filePath, { width: 100, height: 1200, thumbPath: orphan }),
    thumbnailsDir
  );

  assert.notEqual(scanned.thumbPath, orphan);
  assert.equal(
    fs.existsSync(orphan),
    true,
    'the stored path still names it until the caller saves the new one'
  );

  await removeReplacedThumbnail(orphan, thumbnailsDir);
  assert.equal(fs.existsSync(orphan), false, 'the replaced file must go');
  await removeReplacedThumbnail(orphan, thumbnailsDir);
});

test('a thumbnail outside the thumbnails directory is left where it is', async () => {
  const thumbnailsDir = await fs.promises.mkdtemp(
    path.join(tmpRoot, 'thumbs-')
  );
  const elsewhere = await fs.promises.mkdtemp(path.join(tmpRoot, 'other-'));
  const stranger = path.join(elsewhere, 'someone-elses.jpg');
  await fs.promises.writeFile(stranger, 'not ours to delete');

  await removeReplacedThumbnail(stranger, thumbnailsDir);

  assert.equal(fs.existsSync(stranger), true);
});
