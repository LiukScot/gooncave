import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldersRepo } from '../src/db/repos/foldersRepo';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

const ONE_BY_ONE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf' +
    'c0c00000000300017c6bf3060000000049454e44ae426082',
  'hex'
);

const cookieFor = async (userId: string) => {
  const session = await sessionCookieFor(userId);
  return `${session.name}=${session.value}`;
};

test('POST /auth/register returns 429 after too many attempts in one minute', async () => {
  const app = await buildTestApp();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { username: `rate_reg_${i}`, password: 'longenoughpassword' }
      });
      assert.equal(res.statusCode, 200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'rate_reg_blocked', password: 'longenoughpassword' }
    });
    assert.equal(blocked.statusCode, 429);
  } finally {
    await app.close();
  }
});

test('POST /auth/login returns 429 after too many failed attempts in one minute', async () => {
  const app = await buildTestApp();
  try {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'rate_login_user', password: 'rightpassword1' }
    });

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'rate_login_user', password: 'rightpassword1' }
      });
      assert.equal(res.statusCode, 200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'rate_login_user', password: 'rightpassword1' }
    });
    assert.equal(blocked.statusCode, 429);
  } finally {
    await app.close();
  }
});

test('POST /folders/:id/uploads returns 429 after too many attempts in one minute', async () => {
  const app = await buildTestApp();
  try {
    const seeded = await seedUser({ username: 'rate_upload_user' });
    const cookie = await cookieFor(seeded.user.id);
    const folders = await foldersRepo.listFolders(seeded.user.id);
    const folderId = folders[0]?.id;
    assert.ok(folderId, 'expected a root folder');

    const buildMultipartUpload = (filename: string) => {
      const boundary = 'gooncave-upload-boundary';
      const head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: image/png\r\n\r\n';
      const tail = `\r\n--${boundary}--\r\n`;
      const payload = Buffer.concat([
        Buffer.from(head, 'utf8'),
        ONE_BY_ONE_PNG,
        Buffer.from(tail, 'utf8')
      ]);
      const headers = {
        cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(payload.length)
      };
      return { headers, payload };
    };

    for (let i = 0; i < 30; i++) {
      const upload = buildMultipartUpload(`rate-${i}.png`);
      const res = await app.inject({
        method: 'POST',
        url: `/folders/${folderId}/uploads`,
        headers: upload.headers,
        payload: upload.payload
      });
      assert.equal(res.statusCode, 200);
    }

    const blockedUpload = buildMultipartUpload('rate-blocked.png');
    const blocked = await app.inject({
      method: 'POST',
      url: `/folders/${folderId}/uploads`,
      headers: blockedUpload.headers,
      payload: blockedUpload.payload
    });
    assert.equal(blocked.statusCode, 429);
  } finally {
    await app.close();
  }
});
