/**
 * A booru that answers like e621, served on this computer for the core to ask. The core accepts
 * a site here only because playwright.config.ts starts it with GOONCAVE_TEST_LOCAL_SITES=1.
 *
 * Unlike `page.route`, the core does its own work on the answers: paging, read marks, copies.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { thumbnailablePng, type Page } from './helpers';

export type FakePost = {
  id: number;
  md5?: string;
  /** The PNG served as this post's picture; a shared fixture picture when absent. */
  picture?: Buffer;
  /** Deleted on the site after it was listed: its picture is gone and the site says so. */
  removed?: boolean;
  /** The size the site lists; the picture's own, 64x120, when absent. */
  size?: { width: number; height: number };
};

/** A 64x120 PNG of a random pattern: two seeds give two pictures that do not look alike. */
export const distinctPicture = (seed: number) =>
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `cellauto=s=64x120:seed=${seed}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);

export type FakeBooru = {
  siteId: string;
  /** The `page` asked in every list request, in order. */
  pagesAsked: string[];
  close: () => Promise<void>;
};

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

/** Starts a fake booru holding `posts`, newest first, and adds it as a site of the core. */
export async function startFakeBooru(page: Page, name: string, posts: FakePost[]): Promise<FakeBooru> {
  const newestFirst = [...posts].sort((a, b) => b.id - a.id);
  const pagesAsked: string[] = [];
  const fallback = Buffer.from(thumbnailablePng, 'base64');
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const picture = /^\/picture\/(\d+)\.png$/.exec(url.pathname);
    if (picture) {
      const post = newestFirst.find((entry) => entry.id === Number(picture[1]));
      const shown = post && !post.removed;
      response.writeHead(shown ? 200 : 404, { 'content-type': 'image/png' });
      response.end(shown ? post.picture ?? fallback : undefined);
      return;
    }
    const single = /^\/posts\/(\d+)\.json$/.exec(url.pathname);
    if (single) {
      const post = newestFirst.find((entry) => entry.id === Number(single[1]));
      if (!post?.removed) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ post: { id: post.id, flags: { deleted: true } } }));
      return;
    }
    if (url.pathname !== '/posts.json') {
      response.writeHead(404).end();
      return;
    }
    const limit = Number(url.searchParams.get('limit') ?? 75);
    const asked = url.searchParams.get('page') ?? '1';
    pagesAsked.push(asked);
    const before = /^b(\d+)$/.exec(asked);
    const listed = before
      ? newestFirst.filter((post) => post.id < Number(before[1])).slice(0, limit)
      : newestFirst.slice((Number(asked) - 1) * limit, Number(asked) * limit);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      posts: listed.map((post) => {
        const file = `${origin}/picture/${post.id}.png`;
        return {
          id: post.id,
          file: { url: file, width: post.size?.width ?? 64, height: post.size?.height ?? 120, ext: 'png', size: 1000, md5: post.md5 ?? `${name}-${post.id}` },
          preview: { url: file },
          sample: { url: file },
          score: { total: 0 },
          tags: { general: ['fixture_tag'] },
          pools: [],
          relationships: { parent_id: null, has_children: false }
        };
      })
    }));
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  const created = await page.request.post('/booru-sites', { data: { name, engine: 'e621', baseUrl: origin } });
  if (!created.ok()) {
    server.close();
    throw new Error(`The core refused the fake booru: ${await created.text()}`);
  }
  const { site: { id: siteId } } = (await created.json()) as { site: { id: string } };
  return {
    siteId,
    pagesAsked,
    close: async () => {
      // The core keeps every test's sites: one left behind would show in the next test's Explore.
      await page.request.delete(`/booru-sites/${siteId}`);
      const closed = new Promise((resolve) => server.close(resolve));
      // The core keeps its connections open for the next request; close waits for them otherwise.
      server.closeAllConnections();
      await closed;
    }
  };
}

/** Marks posts of a fake booru as read, as Explore does when the reader scrolls past them. */
export async function markRead(page: Page, siteId: string, ids: number[]) {
  // The core takes at most 500 keys at a time.
  for (let start = 0; start < ids.length; start += 500) {
    const keys = ids.slice(start, start + 500).map((id) => `${siteId}:${id}`);
    const response = await page.request.post('/read-marks', { data: { scope: 'post', keys } });
    if (!response.ok()) throw new Error(`The core did not mark the posts read: ${await response.text()}`);
  }
}
