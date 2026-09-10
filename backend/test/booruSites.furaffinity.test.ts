import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { booruSitesRepo } from '../src/db/repos/booruSitesRepo';
import { ENGINE_REGISTRY } from '../src/lib/booruEngines';
import { createFurAffinityEngine } from '../src/lib/booruEngines/furaffinity';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

const cookieFor = async (userId: string) => {
  const session = await sessionCookieFor(userId);
  return `${session.name}=${session.value}`;
};

test('engine catalog exposes the FurAffinity preset and credential contract', async () => {
  const seeded = await seedUser({ username: 'fa_catalog' });
  const response = await app.inject({
    method: 'GET',
    url: '/booru-sites/engines',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    engines: Array<{
      type: string;
      credentialSchema: string;
      supportedExploreSorts: string[];
      supportsExploreTagSearch: boolean;
      supportsSessionCookie: boolean;
    }>;
    presets: Array<{ key: string; baseUrl: string }>;
  };
  assert.deepEqual(
    body.engines.find((entry) => entry.type === 'furaffinity'),
    {
      type: 'furaffinity',
      credentialSchema: 'username+session-cookie',
      defaultCapabilities: {
        favorites: true,
        tags: true,
        sourceMatch: true,
        search: true,
        vote: false
      },
      supportedExploreSorts: ['new'],
      supportsExploreTagSearch: false,
      supportsSessionCookie: true
    }
  );
  assert.deepEqual(
    body.presets.find((entry) => entry.key === 'FURAFFINITY'),
    {
      key: 'FURAFFINITY',
      name: 'FurAffinity',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net'
    }
  );
});

test('FurAffinity site creation stores but never returns the raw cookie', async () => {
  const seeded = await seedUser({ username: 'fa_create' });
  const cookie = await cookieFor(seeded.user.id);
  const secret = 'a=account; b=private-session';
  process.env.ALLOW_PRIVATE_BOORU_HOSTS = 'true';
  let created;
  try {
    created = await app.inject({
      method: 'POST',
      url: '/booru-sites',
      headers: { cookie },
      payload: {
        name: 'FurAffinity',
        engine: 'furaffinity',
        baseUrl: 'http://127.0.0.1:4100',
        username: 'demo',
        sessionCookie: secret
      }
    });
  } finally {
    delete process.env.ALLOW_PRIVATE_BOORU_HOSTS;
  }

  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.body.includes(secret), false);
  assert.equal(created.json().site.hasSessionCookie, true);
  assert.equal(created.json().site.engineCredentialSchema, 'username+session-cookie');
  const siteId = created.json().site.id as string;

  const replacementSecret = 'a=replacement; b=still-private';
  const updated = await app.inject({
    method: 'PUT',
    url: `/booru-sites/${siteId}`,
    headers: { cookie },
    payload: { sessionCookie: replacementSecret }
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.body.includes(replacementSecret), false);
  assert.equal(updated.json().site.hasSessionCookie, true);

  const metadataOnlyUpdate = await app.inject({
    method: 'PUT',
    url: `/booru-sites/${siteId}`,
    headers: { cookie },
    payload: { name: 'FurAffinity account' }
  });
  assert.equal(metadataOnlyUpdate.statusCode, 200, metadataOnlyUpdate.body);
  assert.equal(metadataOnlyUpdate.json().site.hasSessionCookie, true);

  const listed = await app.inject({
    method: 'GET',
    url: '/booru-sites',
    headers: { cookie }
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.includes(secret), false);
  assert.equal(listed.body.includes(replacementSecret), false);
  assert.equal(listed.json().sites[0].hasSessionCookie, true);
});

test('Explore includes FurAffinity only for unfiltered New queries', async () => {
  const seeded = await seedUser({ username: 'fa_explore' });
  const authCookie = await cookieFor(seeded.user.id);
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'FurAffinity',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net',
      username: 'demo',
      sessionCookie: 'a=account; b=session',
      enabled: true
    },
    seeded.user.id
  );
  const originalEngine = ENGINE_REGISTRY.furaffinity;
  ENGINE_REGISTRY.furaffinity = createFurAffinityEngine({
    minRequestIntervalMs: 0,
    fetchImpl: async () =>
      new Response(`<html><body id="pageid-browse"><figure id="sid-42" class="r-general">
      <a href="/view/42/"><img src="//t.furaffinity.net/42@300-1788069904.jpg"
        data-width="200" data-height="300" data-tags="u_artist wolf"></a>
      <a href="/user/artist/">artist</a></figure></body></html>`, {
        status: 200
      })
  });

  try {
    const newest = await app.inject({
      method: 'GET',
      url: `/explore/posts?sort=new&sites=${site.id}`,
      headers: { cookie: authCookie }
    });
    assert.equal(newest.statusCode, 200, newest.body);
    assert.equal(newest.json().posts[0].remoteId, '42');

    for (const query of ['sort=popular', 'sort=new&tags=wolf']) {
      const excluded = await app.inject({
        method: 'GET',
        url: `/explore/posts?${query}&sites=${site.id}`,
        headers: { cookie: authCookie }
      });
      assert.equal(excluded.statusCode, 200, excluded.body);
      assert.deepEqual(excluded.json().sites, []);
      assert.deepEqual(excluded.json().posts, []);
    }
  } finally {
    ENGINE_REGISTRY.furaffinity = originalEngine;
  }
});

test('Explore detail resolves FurAffinity tags and full media in one read', async () => {
  const seeded = await seedUser({ username: 'fa_explore_detail' });
  const authCookie = await cookieFor(seeded.user.id);
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'FurAffinity',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net',
      username: 'demo',
      sessionCookie: 'a=account; b=session',
      enabled: true
    },
    seeded.user.id
  );
  let requestCount = 0;
  const originalEngine = ENGINE_REGISTRY.furaffinity;
  ENGINE_REGISTRY.furaffinity = createFurAffinityEngine({
    minRequestIntervalMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(`<html><body id="pageid-submission">
        <img id="submissionImg" data-tags="u_artist s_wolf blue_eyes"
          data-fullview-src="//d.furaffinity.net/art/demo/full-size.png">
      </body></html>`, { status: 200 });
    }
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: `/explore/post-tags?siteId=${site.id}&remoteId=42`,
      headers: { cookie: authCookie }
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      tags: [
        { tag: 'artist', category: 'artist' },
        { tag: 'wolf', category: 'species' },
        { tag: 'blue_eyes', category: 'general' }
      ],
      fileUrl: 'https://d.furaffinity.net/art/demo/full-size.png'
    });
    assert.equal(requestCount, 1);
  } finally {
    ENGINE_REGISTRY.furaffinity = originalEngine;
  }
});

test('subscription refresh indexes the FurAffinity inbox', async () => {
  const seeded = await seedUser({ username: 'fa_subscribed_feed' });
  const authCookie = await cookieFor(seeded.user.id);
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'FurAffinity',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net',
      username: 'demo',
      sessionCookie: 'a=account; b=session',
      enabled: true
    },
    seeded.user.id
  );
  let requestCount = 0;
  const originalEngine = ENGINE_REGISTRY.furaffinity;
  ENGINE_REGISTRY.furaffinity = createFurAffinityEngine({
    minRequestIntervalMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(`<html><div id="messagecenter-new-submissions">
      <figure id="sid-43" class="r-mature"><a href="/view/43/"><img
        src="//t.furaffinity.net/43@300-1788069904.jpg"
        data-width="200" data-height="300" data-tags="u_artist wolf"></a>
        <a href="/user/artist/">artist</a></figure></div>
      <form id="messages-form" action="/msg/submissions/new@48/"></form>
      <a class="button standard more" href="/msg/submissions/new~43@48/">Next 48</a>
      </html>`, {
        status: 200
      });
    }
  });

  try {
    const refresh = await app.inject({
      method: 'POST',
      url: '/explore/subscriptions/refresh',
      headers: { cookie: authCookie }
    });
    const response = await app.inject({
      method: 'GET',
      url: `/explore/subscriptions?sites=${site.id}`,
      headers: { cookie: authCookie }
    });

    assert.equal(refresh.statusCode, 200, refresh.body);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().posts[0].remoteId, '43');
    assert.equal(requestCount, 1);
  } finally {
    ENGINE_REGISTRY.furaffinity = originalEngine;
  }
});
