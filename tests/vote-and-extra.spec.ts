import { expect, test } from '@playwright/test';

import { loginUi, thumbnailablePng, uploadSampleImages } from './helpers';

// One test, one login: /auth/login is rate-limited to 10/minute and the
// whole suite shares that budget.
test('voting locks the buttons, and the Extra toggles hide Games + Rated', async ({
  page
}) => {
  await loginUi(page);

  // --- voting ---------------------------------------------------------
  const fileName = `vote-${Date.now()}.png`;
  await uploadSampleImages(page, [fileName], { base64: thumbnailablePng });
  await page.goto('/app/gallery');
  await page
    .locator(`[data-test-id="file-card"][aria-label*="${fileName}"]`)
    .click();
  await expect(page).toHaveURL(/fileId=/);

  const voteUp = page.getByRole('button', { name: 'Vote up' });
  const voteDown = page.getByRole('button', { name: 'Vote down' });
  const voteBlock = page.getByRole('group', { name: 'Vote' });
  const score = page.locator('[data-test-id="vote-score"]');
  await expect(voteUp).toBeEnabled();
  // A score can never go negative, so at zero there is nothing to vote down.
  await expect(voteDown).toHaveCount(0);

  // Voting applies straight away and collapses the block into a countdown,
  // but the request itself is held back for the undo window.
  await voteUp.click();
  await expect(page.getByRole('status')).toContainText('Voted up');
  await expect(score).toHaveText('+1');
  await expect(voteBlock).toHaveText('24h');
  await expect(voteUp).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(score).toHaveText('0');
  await expect(voteUp).toBeEnabled();
  await expect(voteDown).toHaveCount(0);

  // Leaving the file before the window elapses must send the vote, not drop
  // it — reloading proves the server actually stored it.
  const votePosted = page.waitForResponse(
    (res) => res.url().includes('/vote') && res.request().method() === 'POST'
  );
  await voteUp.click();
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await votePosted;
  await page.reload();
  const card = page.locator(
    `[data-test-id="file-card"][aria-label*="${fileName}"]`
  );
  // The gallery card carries the score too, once it is above zero.
  await expect(card.locator('[data-test-id="card-score"]')).toHaveText('1');
  await card.click();
  await expect(score).toHaveText('+1');
  await expect(voteBlock).toHaveText('24h');

  // --- extra toggles --------------------------------------------------
  // click() + an awaited assertion rather than check()/uncheck(): these are
  // React-controlled inputs, and Playwright's check() re-reads the state too
  // eagerly for the re-render to have landed.
  await page.goto('/app/settings/extra');
  await expect(page.getByRole('heading', { name: 'Extra' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Games' }).first()).toBeVisible();

  const gamesToggle = page.locator('#extra-gamesTabEnabled');
  const voteToggle = page.locator('#extra-voteSystemEnabled');

  // Read and restore through the API, not the checkboxes: the settings query
  // renders the enabled-by-default state until the server answers, so reading
  // a checkbox right after a load can report the default rather than the
  // stored value.
  const readSettings = async () => {
    const res = await page.request.get('/settings/extra');
    expect(res.ok(), 'failed to read extra settings').toBeTruthy();
    return (await res.json()) as {
      gamesTabEnabled: boolean;
      voteSystemEnabled: boolean;
    };
  };
  const initialSettings = await readSettings();

  // These settings are persisted and the smoke DB outlives this spec, so an
  // assertion failing mid-way must not leave them off for everything after.
  try {
    await gamesToggle.click();
    await expect(gamesToggle).not.toBeChecked();
    await expect(page.getByRole('link', { name: 'Games' })).toHaveCount(0);

    await voteToggle.click();
    await expect(voteToggle).not.toBeChecked();
    await page.goto('/app/gallery');
    await expect(page.getByRole('button', { name: 'Newest' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rated' })).toHaveCount(0);
    // ...and the detail view drops both the vote block and the score row.
    await page.locator('[data-test-id="file-card"]').first().click();
    await expect(page).toHaveURL(/fileId=/);
    await expect(voteBlock).toHaveCount(0);
    await expect(score).toHaveCount(0);
  } finally {
    const res = await page.request.put('/settings/extra', {
      data: initialSettings
    });
    expect(res.ok(), 'failed to restore extra settings').toBeTruthy();
  }

  await page.goto('/app/gallery');
  await expect(page.getByRole('link', { name: 'Games' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rated' })).toBeVisible();
});
