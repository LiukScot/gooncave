// Contract for the grid thumbnail: a strip is cropped to the shape the grid
// shows it in, anything else is fitted whole. Uses real files so sharp
// produces real pixels.
/* eslint-disable import-x/no-named-as-default --
   sharp's default export shares its name with a named one; the rule reads
   the correct import as a mistake. */
import './helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

import { test } from 'bun:test';
import sharp from 'sharp';

import type { FileRecord } from '../src/db/types';
import { CROPPED_THUMB_SUFFIX, scanLocalFile } from '../src/lib/scanner';

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
  existingFiles?: Map<string, FileRecord>
) => {
  const thumbnailsDir = await fs.promises.mkdtemp(
    path.join(tmpRoot, 'thumbs-')
  );
  const scanned = await scanLocalFile(filePath, {
    thumbnailsDir,
    existingFiles
  });
  assert.ok(scanned, 'file should scan');
  return scanned;
};

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

test('a tall-but-not-strip image is still kept whole', async () => {
  const scanned = await scanWithThumb(await writeImage(400, 700));
  assert.ok(scanned.thumbPath);
  assert.equal(scanned.thumbPath.endsWith(CROPPED_THUMB_SUFFIX), false);
});

const recordFor = (
  filePath: string,
  overrides: Partial<FileRecord>
): Map<string, FileRecord> => {
  // A whole second: mtimeMs carries sub-millisecond precision on Linux, and
  // the record's ISO timestamp cannot express that, so the reuse check would
  // never fire on a file left at its natural mtime.
  const stamp = new Date('2026-01-02T03:04:05.000Z');
  fs.utimesSync(filePath, stamp, stamp);
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
