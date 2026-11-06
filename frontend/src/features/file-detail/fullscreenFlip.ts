import { useLayoutEffect, useState } from 'react';

/** The open picture or video. Only one detail view is on screen at a time. */
const MEDIA = '.file-detail-panel-current .file-detail-media';
const DURATION_MS = 250;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

type Box = { left: number; top: number; width: number; height: number };

/** Where the picture itself is drawn inside its element: object-fit contain, centred. */
const pictureBox = (media: HTMLElement): Box => {
  const box = media.getBoundingClientRect();
  const width =
    media instanceof HTMLImageElement ? media.naturalWidth
      : media instanceof HTMLVideoElement ? media.videoWidth
        : 0;
  const height =
    media instanceof HTMLImageElement ? media.naturalHeight
      : media instanceof HTMLVideoElement ? media.videoHeight
        : 0;
  if (!width || !height || !box.width || !box.height) return box;
  const scale = Math.min(box.width / width, box.height / height);
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  return {
    left: box.left + (box.width - drawnWidth) / 2,
    top: box.top + (box.height - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight
  };
};

/**
 * Entering and leaving fullscreen, however it happens (button, shortcut, drag, Back): the
 * picture moves and scales from where it was to where it now is (FLIP: measure first and
 * last, then animate the difference back to nothing). One element moves, so there is no
 * second copy of the picture, and one scale for both sides, so it never stretches. Leaving,
 * the page around the picture fades in.
 */
export function useFullscreenFlip(fullscreen: boolean): void {
  const [flip, setFlip] = useState<{ fullscreen: boolean; from: Box | null }>({ fullscreen, from: null });
  if (flip.fullscreen !== fullscreen) {
    // Measured while rendering the change: the page on screen still shows the picture where it
    // was, including where a drag has moved it. By the first effect it has already moved.
    const media = document.querySelector<HTMLElement>(MEDIA);
    setFlip({ fullscreen, from: media ? pictureBox(media) : null });
  }
  useLayoutEffect(() => {
    const { from } = flip;
    const media = document.querySelector<HTMLElement>(MEDIA);
    if (!from || !media || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = pictureBox(media);
    if (!to.width || !to.height) return;
    const scale = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const timing = { duration: DURATION_MS, easing: EASING };
    const animations = [
      media.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, transformOrigin: 'center' },
          { transform: 'none', transformOrigin: 'center' }
        ],
        timing
      )
    ];
    if (!flip.fullscreen) {
      const panel = media.closest('.file-detail-panel-current');
      // The page and the buttons around the picture come back with it, not before it.
      const around = [
        ...(panel?.querySelectorAll('.file-detail-body, .file-detail-overlay-back, .file-detail-fullscreen-btn') ?? []),
        ...document.querySelectorAll('.phone-actions')
      ];
      for (const element of around) animations.push(element.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      // The band behind the picture is already its small size: shown at once, it sticks out
      // above the picture that is still large.
      const wrap = media.closest('.file-detail-media-wrap');
      if (wrap) animations.push(wrap.animate([{ backgroundColor: 'transparent' }, {}], timing));
    }
    return () => animations.forEach((animation) => animation.cancel());
  }, [flip]);
}
