/** Marks an <img> whose picture moves on its own, such as a GIF. */
export const ANIMATED_PICTURE = 'data-animated-picture';

type Size = { width: number; height: number };
type Rect = Size & { x: number; y: number };

const positionShare = (part: string | undefined): number =>
  part?.endsWith('%') ? Number.parseFloat(part) / 100 : 0.5;

/**
 * Where an `object-fit` box draws its picture, in the box's own pixels. `position` is the
 * computed `object-position` ("50% 0%"); the part outside the box is what cover crops.
 */
export const fittedRect = (box: Size, picture: Size, fit: string, position: string): Rect => {
  if (fit !== 'cover' && fit !== 'contain') return { x: 0, y: 0, ...box };
  const pick = fit === 'cover' ? Math.max : Math.min;
  const scale = pick(box.width / picture.width, box.height / picture.height);
  const width = picture.width * scale;
  const height = picture.height * scale;
  const [x, y] = position.split(' ');
  return {
    x: (box.width - width) * positionShare(x),
    y: (box.height - height) * positionShare(y),
    width,
    height
  };
};

/** A still of the frame `image` shows now, laid over it, or null when it cannot be drawn. */
const stillOf = (image: HTMLImageElement): HTMLCanvasElement | null => {
  const box = { width: image.offsetWidth, height: image.offsetHeight };
  if (!image.complete || !image.naturalWidth || !box.width || !box.height) return null;
  const canvas = document.createElement('canvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const style = getComputedStyle(image);
  const drawn = fittedRect(
    box,
    { width: image.naturalWidth, height: image.naturalHeight },
    style.objectFit,
    style.objectPosition
  );
  // Drawing a picture from another site is allowed; only reading the canvas back is not.
  context.drawImage(image, drawn.x * ratio, drawn.y * ratio, drawn.width * ratio, drawn.height * ratio);
  Object.assign(canvas.style, {
    position: 'absolute',
    left: `${image.offsetLeft}px`,
    top: `${image.offsetTop}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: style.borderRadius,
    pointerEvents: 'none'
  });
  return canvas;
};

/**
 * Stops the page from changing on its own: every GIF shows the frame it is on, and playing
 * videos pause. During a view transition the browser draws the new page again whenever any
 * of it changes, so one GIF made every frame of the swipe back redraw the whole page behind.
 * Returns what puts them back.
 */
export const freezePictures = (): (() => void) => {
  const stills: { image: HTMLImageElement; still: HTMLCanvasElement }[] = [];
  for (const image of document.querySelectorAll<HTMLImageElement>(`img[${ANIMATED_PICTURE}]`)) {
    const still = stillOf(image);
    if (!still) continue;
    image.after(still);
    image.style.visibility = 'hidden';
    stills.push({ image, still });
  }
  const videos = [...document.querySelectorAll('video')].filter((video) => !video.paused);
  for (const video of videos) video.pause();
  return () => {
    for (const { image, still } of stills) {
      still.remove();
      image.style.visibility = '';
    }
    for (const video of videos) {
      // A video on the page the swipe left is detached by now; playing it would be sound
      // with no picture and no control to stop it.
      if (!video.isConnected) continue;
      video.play().catch((error: unknown) => console.warn('Cannot resume a video after the swipe back', error));
    }
  };
};
