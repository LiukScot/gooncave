import { expect, test, type Page } from './helpers';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
});

/** Stands in for the iPhone app: its IPC answers like `AppLock.swift` with a code of 1234. */
const iphone = async (page: Page, enabled: boolean) => {
  await page.addInitScript((startEnabled: boolean) => {
    const lock = { enabled: startEnabled, code: '1234', biometricAsks: 0 };
    Object.assign(window, {
      isTauri: true,
      gooncaveLock: lock,
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: { action?: string; code?: string }) => {
          if (command !== 'app_lock') return null;
          switch (args.action) {
            case 'state':
              return { enabled: lock.enabled, biometry: 'faceID', wait: 0 };
            case 'set':
              lock.enabled = true;
              lock.code = args.code ?? '';
              return { enabled: true };
            case 'check':
              return { ok: args.code === lock.code, wait: 0 };
            case 'clear':
              lock.enabled = false;
              return { enabled: false };
            case 'biometric':
              lock.biometricAsks += 1;
              return { ok: false, fallback: true };
          }
          throw new Error(`Unknown action ${args.action}`);
        }
      }
    });
    if (startEnabled) localStorage.setItem('gooncave.appLock', '1');
  }, enabled);
};

const goAway = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test('the lock asks for Face ID at launch, takes only the right code, and locks again on return', async ({ page }) => {
  await iphone(page, true);
  await page.goto('/app/gallery');
  const lock = page.getByRole('dialog', { name: 'GoonCave is locked' });
  await expect(lock).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { gooncaveLock: { biometricAsks: number } }).gooncaveLock.biometricAsks)).toBe(1);
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);

  await lock.getByLabel('Code').fill('9999');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(lock.getByRole('alert')).toHaveText('Wrong code.');
  await expect(lock).toBeVisible();

  await lock.getByLabel('Code').fill('1234');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(lock).toBeHidden();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);

  await goAway(page, 'hidden');
  await expect(lock).toBeVisible();
  await goAway(page, 'visible');
  await expect.poll(() => page.evaluate(() => (window as unknown as { gooncaveLock: { biometricAsks: number } }).gooncaveLock.biometricAsks)).toBe(2);
});

test('Extra turns the lock on with a repeated code and off only after the code', async ({ page }) => {
  await iphone(page, false);
  await page.goto('/app/settings/extra');
  const toggle = page.getByRole('checkbox', { name: 'Face ID lock' });
  await toggle.check();
  await page.getByLabel('New code, 4 to 12 digits').fill('5678');
  await page.getByLabel('The same code again').fill('5679');
  await page.getByRole('button', { name: 'Turn on the lock' }).click();
  await expect(page.getByRole('alert')).toHaveText('The two codes are different.');
  await page.getByLabel('The same code again').fill('5678');
  await page.getByRole('button', { name: 'Turn on the lock' }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('New code, 4 to 12 digits')).toHaveCount(0);

  await toggle.uncheck();
  await page.getByLabel('Code', { exact: true }).fill('1111');
  await page.getByRole('button', { name: 'Turn off the lock' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong code.');
  await expect.poll(() => page.evaluate(() => (window as unknown as { gooncaveLock: { enabled: boolean } }).gooncaveLock.enabled)).toBe(true);
  await page.getByLabel('Code', { exact: true }).fill('5678');
  await page.getByRole('button', { name: 'Turn off the lock' }).click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as unknown as { gooncaveLock: { enabled: boolean } }).gooncaveLock.enabled)).toBe(false);
});
