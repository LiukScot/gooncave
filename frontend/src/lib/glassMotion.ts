/**
 * The moving parts of the Apple Edition's Liquid Glass, which CSS alone
 * cannot place (see the Apple Edition block in app.css):
 *
 * - Sliding selection: a group of choices (the tab bar's capsules, every
 *   segmented control) carries one glass pill under the chosen item. When
 *   the choice changes in the Apple Edition, the pill lifts off as a clear
 *   glass lens, stretches toward the new item like a drop, and settles
 *   there: iOS 26's tab bar. In Chrome the lens also bends what is under it
 *   (an SVG displacement filter, `#glass-lens`); other browsers show the
 *   clear glass without the bend.
 * - Touch light: a glass control lights up where it is pressed. This writes
 *   the point.
 *
 * Both only write CSS variables and attributes; the Apple Edition's rules
 * decide what to draw, so in the other styles they do nothing visible.
 */

// A group of choices and the class its chosen item wears.
const INDICATOR_GROUPS: [group: string, chosen: string][] = [
  ['.app-tab-bar-group', '.app-tab-bar-link.is-active'],
  ['.btn-group', '.btn.btn-primary']
];

// Long enough for the first placement to paint before moves animate.
const SETTLE_MS = 50;

const MORPH_MS = 620;
// How far the lifted lens grows past the pill, across and along.
const LIFT_SCALE = { x: 1.12, y: 1.2 };
// Mid-flight the leading edge has covered most of the way and the trailing
// edge little of it, so the lens is stretched between the two items.
const LEAD = 0.85;
const TRAIL = 0.3;
// The settle carries the lens a little past its item before it lands.
const OVERSHOOT_PX = 4;

type Box = { x: number; y: number; w: number; h: number };
const lastBoxes = new WeakMap<HTMLElement, Box>();
const morphs = new WeakMap<HTMLElement, Animation>();

const motionAllowed = (): boolean =>
  document.documentElement.dataset.style === 'apple' &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const pose = (x: number, y: number, w: number, sx = 1, sy = 1): Keyframe => ({
  transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`,
  width: `${w}px`
});

/** Lifts the pill off `from`, stretches it toward `to` and lands it there. */
const morph = (group: HTMLElement, from: Box, to: Box): void => {
  morphs.get(group)?.cancel();
  const right = to.x > from.x;
  const fromEnd = from.x + from.w;
  const toEnd = to.x + to.w;
  const left = right ? from.x + (to.x - from.x) * TRAIL : to.x + (from.x - to.x) * (1 - LEAD);
  const end = right ? fromEnd + (toEnd - fromEnd) * LEAD : fromEnd - (fromEnd - toEnd) * TRAIL;
  const animation = group.animate(
    [
      pose(from.x, from.y, from.w),
      { ...pose(from.x, from.y, from.w, LIFT_SCALE.x, LIFT_SCALE.y), offset: 0.18 },
      { ...pose(left, to.y, end - left, LIFT_SCALE.x, LIFT_SCALE.y * 0.94), offset: 0.5 },
      {
        ...pose(to.x + (right ? OVERSHOOT_PX : -OVERSHOOT_PX), to.y, to.w, 1.05, 1.08),
        offset: 0.78
      },
      pose(to.x, to.y, to.w)
    ],
    {
      duration: MORPH_MS,
      easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
      pseudoElement: '::before'
    }
  );
  morphs.set(group, animation);
  group.dataset.indicator = 'moving';
  animation.finished
    .then(() => {
      if (morphs.get(group) === animation) group.dataset.indicator = 'ready';
    })
    // Cancelled by a newer move, which owns the state now.
    .catch(() => undefined);
};

const PRESS_TARGETS =
  '.btn, .app-tab-bar-link, .file-detail-overlay-btn, .video-controls-btn';

// Items change size after their class does (a tab's name unrolls, a style
// change re-pads every button), so the pill follows each item's size until
// it settles instead of keeping a measurement taken mid-way.
const watched = new WeakSet<Element>();
const resizes = new ResizeObserver(() => schedule());

/**
 * Places every selection pill now, on the layout as it is. For a caller
 * that needs the pills settled before showing them (a change of style);
 * everything else goes through the observers.
 */
export const placeIndicators = (): void => {
  for (const [groupSelector, chosenSelector] of INDICATOR_GROUPS) {
    for (const group of document.querySelectorAll<HTMLElement>(groupSelector)) {
      for (const item of group.children) {
        if (watched.has(item)) continue;
        watched.add(item);
        resizes.observe(item);
      }
      const chosen = group.querySelector<HTMLElement>(chosenSelector);
      if (!chosen) {
        delete group.dataset.indicator;
        continue;
      }
      const groupBox = group.getBoundingClientRect();
      const box = chosen.getBoundingClientRect();
      const next: Box = {
        x: box.left - groupBox.left,
        y: box.top - groupBox.top,
        w: box.width,
        h: box.height
      };
      const previous = lastBoxes.get(group);
      lastBoxes.set(group, next);
      group.style.setProperty('--indicator-x', `${next.x}px`);
      group.style.setProperty('--indicator-y', `${next.y}px`);
      group.style.setProperty('--indicator-w', `${next.w}px`);
      group.style.setProperty('--indicator-h', `${next.h}px`);
      // Another item was chosen (not a resize, which keeps the order).
      if (
        previous &&
        group.dataset.indicator !== undefined &&
        group.dataset.indicator !== 'placed' &&
        Math.abs(previous.x - next.x) > next.w / 2 &&
        motionAllowed()
      ) {
        morph(group, previous, next);
      }
      // First placement lands without travelling; only later moves slide.
      if (group.dataset.indicator === undefined) {
        group.dataset.indicator = 'placed';
        window.setTimeout(() => {
          group.dataset.indicator = 'ready';
        }, SETTLE_MS);
      }
    }
  }
};

// A timer rather than a frame callback: frames never run in a background
// tab, which would leave every pill unplaced until the tab is shown.
let pending: number | undefined;
const schedule = (): void => {
  if (pending !== undefined) return;
  pending = window.setTimeout(() => {
    pending = undefined;
    placeIndicators();
  }, 0);
};

const markPress = (event: PointerEvent): void => {
  const target = (event.target as Element | null)?.closest<HTMLElement>(PRESS_TARGETS);
  if (!target) return;
  const box = target.getBoundingClientRect();
  target.style.setProperty('--press-x', `${event.clientX - box.left}px`);
  target.style.setProperty('--press-y', `${event.clientY - box.top}px`);
};

/**
 * The displacement map for the lens: neutral in the middle, bending more
 * the nearer a point is to the rim, as the thick edge of a glass pebble
 * does. Red moves pixels across, green up and down; 128 is no move.
 */
const lensMap = (): string | null => {
  const width = 128;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(width, height);
  const radius = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // A capsule: the distance from the segment joining its two ends.
      const centreX = Math.min(Math.max(x + 0.5, radius), width - radius);
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - radius;
      const distance = Math.hypot(dx, dy);
      const bend = Math.min(1, distance / radius) ** 3;
      const i = (y * width + x) * 4;
      image.data[i] = 128 - (distance ? dx / distance : 0) * bend * 127;
      image.data[i + 1] = 128 - (distance ? dy / distance : 0) * bend * 127;
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
};

const SVG_NS = 'http://www.w3.org/2000/svg';

const installLensFilter = (): void => {
  const map = lensMap();
  if (!map) return;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = 'glass-lens';
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', '1');
  filter.setAttribute('height', '1');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const image = document.createElementNS(SVG_NS, 'feImage');
  image.setAttribute('href', map);
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('result', 'map');
  const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
  displace.setAttribute('in', 'SourceGraphic');
  displace.setAttribute('in2', 'map');
  displace.setAttribute('scale', '16');
  displace.setAttribute('xChannelSelector', 'R');
  displace.setAttribute('yChannelSelector', 'G');
  filter.append(image, displace);
  svg.append(filter);
  document.body.append(svg);
};

/** Starts following the page; meant to run once, for the app's lifetime. */
export const installGlassMotion = (): void => {
  installLensFilter();
  // A choice changes by a class swap, new groups mount with pages, and a
  // change of style or mode on the root resizes everything.
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'data-style']
  });
  window.addEventListener('resize', schedule);
  document.addEventListener('pointerdown', markPress, { passive: true });
  schedule();
};
