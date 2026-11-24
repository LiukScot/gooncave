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
    engineCredentialSchema: 'username+apikey', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts: selectionPosts, siteErrors: [], sites: ['fixture'] } }));
}

export const tile = (page: Page, id: string) => page.locator(`[data-select-key="fixture:${id}"]`);


/** The selection bar sits at the bottom left, on the row of the corner buttons it hides. */
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
    inTheLeftHalf: bar.x < page.viewportSize()!.width / 2,
    besideTheMenu: bar.x >= content - 1
  };
}
