import type { Page } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

export const fixturePost = (id: string, height = 480): ExplorePost => ({
  remoteId: id, siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
  previewUrl: '/favicon.png', sampleUrl: null, fileUrl: '/favicon.png',
  width: 640, height, score: 0, rating: null, md5: null, createdAt: null,
  tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
  fileExt: 'png', fileSize: null, favorited: false, voted: null,
  sourceUrl: `https://fixture.invalid/posts/${id}`, parentId: null, hasChildren: false, poolIds: []
});

export const selectionPosts = ['1', '2'].map((id) => fixturePost(id));

export async function serveFixtureSite(page: Page, posts = selectionPosts) {
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username+apikey', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts, siteErrors: [], sites: ['fixture'] } }));
}

export const tile = (page: Page, id: string) => page.locator(`[data-select-key="fixture:${id}"]`);


/** The selection bar sits at the bottom right, on the row of the corner buttons it hides. */
export async function barOnCornerRow(page: Page) {
  const bar = await page.getByRole('toolbar', { name: 'Selection' }).boundingBox();
  const lens = await page.locator('.search-lens').boundingBox();
  if (!bar || !lens) throw new Error('The selection bar or the corner button is not on screen');
  const content = await page.locator('.page-shell').evaluate((shell) => {
    const style = getComputedStyle(shell);
    return shell.getBoundingClientRect().left + parseFloat(style.paddingLeft);
  });
  return {
    centredOnButton: Math.abs(bar.y + bar.height / 2 - (lens.y + lens.height / 2)) <= 1,
    cornerButtonsHidden: await page.locator('.search-lens, .search-lens-actions').evaluateAll((buttons) =>
      buttons.every((button) => getComputedStyle(button).visibility === 'hidden')),
    endsWhereTheButtonEnds: Math.abs(bar.x + bar.width - (lens.x + lens.width)) <= 1,
    besideTheMenu: bar.x >= content - 1
  };
}
