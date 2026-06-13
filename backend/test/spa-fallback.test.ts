import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test } from 'bun:test';

import { createServer } from '../src/index';

test('frontend deep links serve index.html when frontend assets are configured', async () => {
  const frontendRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gooncave-frontend-')
  );
  fs.writeFileSync(
    path.join(frontendRoot, 'index.html'),
    '<!doctype html><html><body>spa shell</body></html>'
  );

  const app = createServer({ frontendDir: frontendRoot });
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/app/gallery?fileId=abc123',
    headers: { accept: 'text/html' }
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /spa shell/);

  await app.close();
});

test('api-like unknown routes still return JSON 404', async () => {
  const frontendRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gooncave-frontend-')
  );
  fs.writeFileSync(
    path.join(frontendRoot, 'index.html'),
    '<!doctype html><html><body>spa shell</body></html>'
  );

  const app = createServer({ frontendDir: frontendRoot });
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/auth/not-a-route',
    headers: { accept: 'application/json' }
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');

  await app.close();
});
