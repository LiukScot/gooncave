// Pin the pure pieces of the scanner: extension classification + FS walker.
// Avoids sharp/ffmpeg so the suite stays sub-second.
import '../../test/helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

import { test } from 'bun:test';

import {
  detectMediaKind,
  iterateLocalMediaPaths,
  listLocalMediaPaths
} from './scanner';

const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT ?? os.tmpdir();
const makeFixtureDir = async (label: string) =>
  fs.promises.mkdtemp(path.join(tmpRoot, `scanner-${label}-`));

test('detectMediaKind returns IMAGE for common image extensions', () => {
  for (const name of [
    'photo.jpg',
    'banner.JPEG',
    'art.png',
    'animation.gif',
    'shot.webp',
    'sample.bmp',
    'next-gen.avif'
  ]) {
    assert.equal(detectMediaKind(name), 'IMAGE', `expected IMAGE for ${name}`);
  }
});

test('detectMediaKind returns VIDEO for common video extensions', () => {
  for (const name of ['clip.mp4', 'movie.MOV', 'capture.mkv', 'stream.webm']) {
    assert.equal(detectMediaKind(name), 'VIDEO', `expected VIDEO for ${name}`);
  }
});

test('detectMediaKind returns null for unsupported extensions', () => {
  assert.equal(detectMediaKind('readme.txt'), null);
  assert.equal(detectMediaKind('archive.zip'), null);
  assert.equal(detectMediaKind('no-extension'), null);
});

test('detectMediaKind handles absolute paths', () => {
  assert.equal(detectMediaKind('/foo/bar/baz.PNG'), 'IMAGE');
});

test('listLocalMediaPaths returns an empty array for an empty directory', async () => {
  const dir = await makeFixtureDir('empty');
  const result = await listLocalMediaPaths(dir);
  assert.deepEqual(result, []);
});

test('listLocalMediaPaths skips non-media files', async () => {
  const dir = await makeFixtureDir('mixed');
  await fs.promises.writeFile(path.join(dir, 'note.txt'), 'x');
  await fs.promises.writeFile(path.join(dir, 'pic.png'), Buffer.from([0]));
  await fs.promises.writeFile(path.join(dir, 'clip.mp4'), Buffer.from([0]));
  const result = await listLocalMediaPaths(dir);
  assert.equal(result.length, 2);
  const names = result.map((p) => path.basename(p)).sort();
  assert.deepEqual(names, ['clip.mp4', 'pic.png']);
});

test('listLocalMediaPaths recurses into nested directories', async () => {
  const dir = await makeFixtureDir('nested');
  await fs.promises.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'top.png'), Buffer.from([0]));
  await fs.promises.writeFile(path.join(dir, 'a', 'mid.jpg'), Buffer.from([0]));
  await fs.promises.writeFile(
    path.join(dir, 'a', 'b', 'leaf.webp'),
    Buffer.from([0])
  );
  const result = await listLocalMediaPaths(dir);
  assert.equal(result.length, 3);
});

test('iterateLocalMediaPaths honors a shouldStop signal', async () => {
  const dir = await makeFixtureDir('stop');
  for (let i = 0; i < 5; i++) {
    await fs.promises.writeFile(
      path.join(dir, `img-${i}.png`),
      Buffer.from([0])
    );
  }
  let stop = false;
  const seen: string[] = [];
  for await (const filePath of iterateLocalMediaPaths(dir, {
    shouldStop: () => stop
  })) {
    seen.push(filePath);
    if (seen.length === 2) stop = true;
  }
  // After we flipped stop, the iterator may yield the file already pulled
  // ahead, but it must not flush the whole 5-file batch.
  assert.ok(
    seen.length >= 2 && seen.length < 5,
    `expected partial enumeration, got ${seen.length}`
  );
});

test('listLocalMediaPaths ignores symlinks-to-files outside the root', async () => {
  const dir = await makeFixtureDir('symlink');
  const outside = await makeFixtureDir('outside');
  const realFile = path.join(outside, 'real.png');
  await fs.promises.writeFile(realFile, Buffer.from([0]));
  try {
    await fs.promises.symlink(realFile, path.join(dir, 'link.png'));
  } catch (err) {
    // Some sandboxed CI runners forbid symlinks; skip rather than fail
    // (AGENTS §9: tests that need a specific OS capability go in the
    // integration suite).
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
    throw err;
  }
  const result = await listLocalMediaPaths(dir);
  // The walker uses entry.isFile() which returns false for a dangling/
  // outside symlink, so we don't expect link.png in the result.
  // If implementation later changes to follow symlinks, this test will
  // surface that intentionally.
  assert.equal(result.includes(path.join(dir, 'link.png')), false);
});
