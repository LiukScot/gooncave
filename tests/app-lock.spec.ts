import { expect, test, type Page } from './helpers';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
});

type Lock = { code: string | null; face: boolean; faceWorks: boolean; stateFails: boolean; biometricAsks: number };

/** Stands in for the iPhone app: its IPC answers like `AppLock.swift`. */
const iphone = async (page: Page, start: { code?: string; face?: boolean; faceWorks?: boolean; stateFails?: boolean }) => {
  await page.addInitScript((initial: Lock) => {
    const lock = { ...initial };
    Object.assign(window, {
      isTauri: true,
      gooncaveLock: lock,
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: { action?: string; code?: string }) => {
          if (command !== 'app_lock') return null;
          switch (args.action) {
            case 'state':
              if (lock.stateFails) throw new Error('Keychain did not answer');
              return { code: lock.code !== null, face: lock.face, biometry: 'faceID', wait: 0 };
            case 'set':
              lock.code = args.code ?? '';
              return { code: true };
            case 'check':
              return { ok: args.code === lock.code, wait: 0 };
            case 'clear':
              lock.code = null;
              return { code: false };
            case 'faceOn':
            case 'faceOff':
              lock.face = args.action === 'faceOn';
              return { face: lock.face };
            case 'biometric':
              lock.biometricAsks += 1;
              return lock.faceWorks ? { ok: true } : { ok: false, fallback: true };
          }
          throw new Error(`Unknown action ${args.action}`);
        }
      }
    });
    if (lock.code !== null || lock.face) localStorage.setItem('gooncave.appLock', '1');
  }, {
    code: start.code ?? null,
    face: start.face ?? false,
    faceWorks: start.faceWorks ?? false,
    stateFails: start.stateFails ?? false,
    biometricAsks: 0
  });
};

const lockState = (page: Page) => page.evaluate(() => (window as unknown as { gooncaveLock: Lock }).gooncaveLock);

const goAway = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test('the lock asks for Face ID at launch, takes only the right code, and locks again on return', async ({ page }) => {
  await iphone(page, { code: '1234', face: true });
  await page.goto('/app/gallery');
  const lock = page.getByRole('dialog', { name: 'GoonCave is locked' });
  await expect(lock).toBeVisible();
  await expect.poll(() => lockState(page).then((lock) => lock.biometricAsks)).toBe(1);
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);

  await lock.getByLabel('Your code').fill('9999');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(lock.getByRole('alert')).toHaveText('Wrong code.');
  await expect(lock).toBeVisible();

  await lock.getByLabel('Your code').fill('1234');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(lock).toBeHidden();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);

  await goAway(page, 'hidden');
  await expect(lock).toBeVisible();
  await goAway(page, 'visible');
  await expect.poll(() => lockState(page).then((lock) => lock.biometricAsks)).toBe(2);
});

test('a code lock alone never asks for Face ID', async ({ page }) => {
  await iphone(page, { code: '1234', faceWorks: true });
  await page.goto('/app/gallery');
  const lock = page.getByRole('dialog', { name: 'GoonCave is locked' });
  await expect(lock.getByLabel('Your code')).toBeVisible();
  await expect(lock.getByRole('button', { name: 'Unlock with Face ID' })).toHaveCount(0);
  await lock.getByLabel('Your code').fill('1234');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(lock).toBeHidden();
  expect((await lockState(page)).biometricAsks).toBe(0);
});

test('a Face ID lock alone unlocks with Face ID and shows no code field', async ({ page }) => {
  await iphone(page, { face: true, faceWorks: true });
  await page.goto('/app/gallery');
  const lock = page.getByRole('dialog', { name: 'GoonCave is locked' });
  await expect(lock).toBeHidden();
  expect((await lockState(page)).biometricAsks).toBe(1);
  await goAway(page, 'hidden');
  await expect(lock).toBeVisible();
  await expect(lock.getByLabel('Your code')).toHaveCount(0);
  await expect(lock.getByRole('button', { name: 'Unlock with Face ID' })).toBeVisible();
});

test('a lock the iPhone cannot read at launch still offers the code and Face ID', async ({ page }) => {
  await iphone(page, { code: '1234', stateFails: true });
  await page.goto('/app/gallery');
  const lock = page.getByRole('dialog', { name: 'GoonCave is locked' });
  await expect(lock.getByRole('button', { name: 'Unlock with Face ID' })).toBeVisible();
  await lock.getByLabel('Your code').fill('1234');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(lock).toBeHidden();
});

test('Extra leaves Face ID off and says why when Face ID fails while turning it on', async ({ page }) => {
  await iphone(page, {});
  await page.goto('/app/settings/extra');
  const face = page.getByRole('checkbox', { name: 'Face ID' });
  // click, not check: check() insists the box ends up ticked, and here it must not.
  await face.click();
  await expect(page.getByRole('alert')).toHaveText('Face ID did not work, so it stays off.');
  await expect(face).not.toBeChecked();
  expect(await lockState(page)).toMatchObject({ face: false, biometricAsks: 1 });
});

test('Extra turns Face ID on alone after Face ID works, and off only after Face ID', async ({ page }) => {
  await iphone(page, { faceWorks: true });
  await page.goto('/app/settings/extra');
  const face = page.getByRole('checkbox', { name: 'Face ID' });
  await face.check();
  await expect(face).toBeChecked();
  expect(await lockState(page)).toMatchObject({ face: true, code: null, biometricAsks: 1 });
  await expect(page.getByRole('checkbox', { name: 'Code' })).not.toBeChecked();

  await face.uncheck();
  await page.getByRole('button', { name: 'Unlock with Face ID' }).click();
  await expect(face).not.toBeChecked();
  expect(await lockState(page)).toMatchObject({ face: false, biometricAsks: 2 });
});

test('Extra turns the code on with a repeated code and off only after the code', async ({ page }) => {
  await iphone(page, {});
  await page.goto('/app/settings/extra');
  const toggle = page.getByRole('checkbox', { name: 'Code' });
  await toggle.check();
  await page.getByLabel('New code, 4 to 12 digits').fill('5678');
  await page.getByLabel('The same code again').fill('5679');
  await page.getByRole('button', { name: 'Turn on the code' }).click();
  await expect(page.getByRole('alert')).toHaveText('The two codes are different.');
  await page.getByLabel('The same code again').fill('5678');
  await page.getByRole('button', { name: 'Turn on the code' }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('New code, 4 to 12 digits')).toHaveCount(0);
  expect((await lockState(page)).face).toBe(false);

  await toggle.uncheck();
  await page.getByLabel('Your code').fill('1111');
  await page.getByRole('button', { name: 'Turn off the code' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong code.');
  await expect.poll(() => lockState(page).then((lock) => lock.code)).toBe('5678');
  await page.getByLabel('Your code').fill('5678');
  await page.getByRole('button', { name: 'Turn off the code' }).click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => lockState(page).then((lock) => lock.code)).toBeNull();
});
