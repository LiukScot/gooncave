import type { Page } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

export const selectionPosts: ExplorePost[] = ['1', '2'].map((id) => ({
  remoteId: id, siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
  previewUrl: '/favicon.png', sampleUrl: null, fileUrl: '/favicon.png',
  width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
  tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
  fileExt: 'png', fileSize: null, favorited: false, voted: null,
  sourceUrl: `https://fixture.invalid/posts/${id}`, parentId: null, hasChildren: false, poolIds: []
}));

export async function serveFixtureSite(page: Page) {
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts: selectionPosts, siteErrors: [], sites: ['fixture'] } }));
}

export const tile = (page: Page, id: string) => page.locator(`[data-select-key="fixture:${id}"]`);

