/**
 * Records the frames Chromium draws for the page while an action runs and finds
 * frames that flash white or black: a blank screen between two routes, a cover
 * left on top, a layer painted in the wrong colour. Reading computed styles
 * does not see those.
 *
 * It does not see what the GPU or the window draws afterwards, such as a
 * view-transition picture drawn white under XWayland: those need the checks by
 * hand in docs/testing.md.
 */
import { expect, test, type Page } from '@playwright/test';

/** Share (0 to 1) of a frame's pixels that are near white and near black. */
type FrameShares = { white: number; black: number };

/** How much more of a frame may turn white or black than in the screens before and after. */
const FLASH_JUMP = 0.25;
/** How long the recording goes on after the action, so its animations end on screen. */
const SETTLE_MS = 1200;

type Recording = { pngs: string[]; shares: FrameShares[] };

async function recordFrames(page: Page, action: () => Promise<void>): Promise<Recording> {
  const cdp = await page.context().newCDPSession(page);
  const frames: string[] = [];
  const acks: Promise<unknown>[] = [];
  const onFrame = ({ data, sessionId }: { data: string; sessionId: number }) => {
    frames.push(data);
    acks.push(cdp.send('Page.screencastFrameAck', { sessionId }));
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 400, maxHeight: 400, everyNthFrame: 1 });
  // Chromium sends the screen as it is when the recording starts: the screen before.
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  await action();
  await page.waitForTimeout(SETTLE_MS);
  await cdp.send('Page.stopScreencast');
  // A frame arriving now would send its ack after the wait below, to a closed session.
  cdp.off('Page.screencastFrame', onFrame);
  await Promise.all(acks);
  await cdp.detach();
  if (frames.length < 2) throw new Error(`The recording caught ${frames.length} frame(s); it needs the screen before and after.`);

  const shares = await page.evaluate(async (pngs) => Promise.all(pngs.map(async (png) => {
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas to read the recorded frames.');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let white = 0;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      const low = Math.min(data[i], data[i + 1], data[i + 2]);
      const high = Math.max(data[i], data[i + 1], data[i + 2]);
      if (low >= 245) white += 1;
      if (high <= 10) black += 1;
    }
    const pixels = data.length / 4;
    return { white: white / pixels, black: black / pixels };
  })), frames);
  return { pngs: frames, shares };
}

/**
 * Indexes of the frames, between the first and the last, where white or black
 * covers much more of the window than on both the screen before and after.
 */
function flashFrames(frames: FrameShares[]): number[] {
  const first = frames[0];
  const last = frames[frames.length - 1];
  return frames.flatMap((frame, index) =>
    index > 0 && index < frames.length - 1 &&
    (['white', 'black'] as const).some((color) => frame[color] > Math.max(first[color], last[color]) + FLASH_JUMP)
      ? [index]
      : []
  );
}

const percent = ({ white, black }: FrameShares) => `${Math.round(white * 100)}% white, ${Math.round(black * 100)}% black`;

/**
 * Runs `action` and fails when a frame drawn meanwhile flashes white or black.
 * A failure attaches the screens before and after and the first flashing frame.
 */
export async function expectNoFlash(page: Page, action: () => Promise<unknown>): Promise<void> {
  const { pngs, shares } = await recordFrames(page, async () => { await action(); });
  const flashes = flashFrames(shares);
  if (flashes.length > 0) {
    for (const [name, index] of [['before', 0], ['flash', flashes[0]], ['after', shares.length - 1]] as const) {
      await test.info().attach(`${name} (frame ${index} of ${shares.length})`, { body: Buffer.from(pngs[index], 'base64'), contentType: 'image/png' });
    }
  }
  expect(
    flashes.map((index) => `frame ${index} of ${shares.length}: ${percent(shares[index])}`),
    `before: ${percent(shares[0])}; after: ${percent(shares[shares.length - 1])}`
  ).toEqual([]);
}
