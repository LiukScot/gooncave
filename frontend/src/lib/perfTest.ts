import { api } from '@/api';

/**
 * Device-only switches for finding what makes animations slow on a phone, and
 * the frame meter that writes what it sees to the app log (Settings → Report
 * issue). They live in this browser's storage, not in the library: they are
 * tests of this device, and every change reloads the page.
 */
export type PerfSwitch = 'frameMeter' | 'noPageAnimations' | 'stillThumbnails';

const storageKey = (name: PerfSwitch) => `gooncave.perfTest.${name}`;

export const readPerfSwitch = (name: PerfSwitch): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(name)) === '1';
  } catch (error) {
    console.warn(`Cannot read the ${name} test switch`, error);
    return false;
  }
};

export const writePerfSwitch = (name: PerfSwitch, on: boolean): void => {
  try {
    window.localStorage.setItem(storageKey(name), on ? '1' : '0');
  } catch (error) {
    console.warn(`Cannot save the ${name} test switch`, error);
  }
};

// shortcut: not `isGifUrl` from exploreMedia, which cuts a URL at `?` and `#` that a file name can hold.
/** A GIF tile whose thumbnail a desktop made is an animated WebP; WebKit keeps every frame it decoded. */
export const hasAnimatedThumb = (path: string): boolean => /\.gif$/i.test(path);

/** Read once: every switch change reloads the page. */
export const hideAnimatedPictures = readPerfSwitch('stillThumbnails');

export type FrameSummary = {
  frames: number;
  durationMs: number;
  medianMs: number;
  worstMs: number;
  /** Frames longer than one and a half screen refreshes: one or more were dropped. */
  late: number;
  /** Frames over 50 ms: a hitch anyone sees. */
  hitches: number;
};

/**
 * `times` are the requestAnimationFrame timestamps of one measure, in order.
 * `refreshMs` is the screen's frame time when known: a measure that is slow from
 * start to end has a slow median, and frames late against it alone would be 0.
 */
export const summarizeFrames = (times: number[], refreshMs = Infinity): FrameSummary | null => {
  if (times.length < 3) return null;
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  const frameMs = Math.min(medianMs, refreshMs);
  return {
    frames: gaps.length,
    durationMs: times[times.length - 1] - times[0],
    medianMs,
    worstMs: sorted[sorted.length - 1],
    late: gaps.filter((gap) => gap > frameMs * 1.5).length,
    hitches: gaps.filter((gap) => gap > 50).length
  };
};

// The shortest usual frame of any measure so far: the screen's refresh, once one measure was smooth.
let refreshMs = Infinity;

// The app log hides words with a dot or a slash, so every figure is a bare number.
const pageState = () => {
  const animated = document.querySelectorAll('img[data-animated-picture]').length;
  const playing = [...document.querySelectorAll('video')].filter((video) => !video.paused).length;
  return `${document.querySelectorAll('img').length} pictures on the page, ${animated} GIFs, ${playing} videos playing, ${Math.round(performance.now() / 60000)} min since the page opened`;
};

const ms = (value: number) => value.toFixed(1);

const report = (label: string, times: number[]) => {
  const summary = summarizeFrames(times, refreshMs);
  if (!summary) return;
  refreshMs = Math.min(refreshMs, summary.medianMs);
  const fps = (summary.frames * 1000) / Math.max(summary.durationMs, 1);
  api
    .reportWindowError(
      `[developer] Frames during ${label}: ${summary.frames} in ${Math.round(summary.durationMs)} ms (${ms(fps)} fps), usual frame ${ms(summary.medianMs)} ms, screen ${ms(refreshMs)} ms, slowest ${ms(summary.worstMs)} ms, ${summary.late} late, ${summary.hitches} over 50 ms. ${pageState()}.`
    )
    .catch((error: unknown) => console.warn('Cannot add a frame measure to the app log', error));
};

/**
 * Counts frames until the returned function is called, then writes them to the log.
 * Given `until` (a `performance.now()` time), frames after the first one past it are left out.
 */
const measure = (label: string): ((until?: number) => void) => {
  const times: number[] = [];
  let frame = requestAnimationFrame(function tick(time) {
    times.push(time);
    frame = requestAnimationFrame(tick);
  });
  return (until) => {
    cancelAnimationFrame(frame);
    const after = until === undefined ? -1 : times.findIndex((time) => time > until);
    report(label, after === -1 ? times : times.slice(0, after + 1));
  };
};

/** A scroll counts as over once no scroll event came for this long. */
const SCROLL_IDLE_MS = 250;

const scrollerName = (target: EventTarget | null): string => {
  if (!(target instanceof Element)) return 'the page';
  return target.id || target.classList[0] || target.tagName.toLowerCase();
};

type ViewTransitionStarter = (options: unknown) => ViewTransition;

/**
 * Turns the frame meter on when its switch is on: every view transition (page
 * animations and the edge swipe) and every scroll writes one line to the log.
 * It times the page's own frames. WebKit scrolls, and may animate, on another
 * thread, so a steady figure next to a visible stutter points there.
 */
export const installFrameMeter = (): void => {
  if (!readPerfSwitch('frameMeter')) return;

  const doc = document as unknown as { startViewTransition?: ViewTransitionStarter };
  const start = doc.startViewTransition?.bind(document);
  if (start) {
    // shortcut: wraps the browser's own method, only while this test switch is on.
    doc.startViewTransition = (options: unknown) => {
      const types =
        typeof options === 'object' && options !== null && 'types' in options
          ? (options as { types?: string[] }).types
          : undefined;
      const transition = start(options);
      const stop = measure(`the ${types?.join(' ') || 'page'} animation`);
      transition.finished.then(
        () => stop(),
        () => stop()
      );
      return transition;
    };
  }

  let scroll: { stop: (until?: number) => void; timer: number } | null = null;
  document.addEventListener(
    'scroll',
    (event) => {
      if (scroll) window.clearTimeout(scroll.timer);
      const stop = scroll?.stop ?? measure(`scrolling ${scrollerName(event.target === document ? null : event.target)}`);
      const last = performance.now();
      scroll = {
        stop,
        timer: window.setTimeout(() => {
          scroll = null;
          stop(last);
        }, SCROLL_IDLE_MS)
      };
    },
    { capture: true, passive: true }
  );
};
