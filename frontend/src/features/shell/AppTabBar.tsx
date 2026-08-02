import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Compass, Images, Settings } from 'lucide-react';
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';

import { AubergineIcon } from '@/components/icons/AubergineIcon';

const TAB_COUNT = 4;
// Ignore scroll direction this close to the top — content there barely
// scrolls, and it reads as jitter rather than an intentional swipe.
const SCROLL_HIDE_MIN_Y = 24;
const SCROLL_DELTA_THRESHOLD = 4;
// Below this many px of finger movement, a press still reads as a tap (so
// the thumb slides to it) rather than a drag (so the thumb tracks it live).
const DRAG_THRESHOLD_PX = 6;

// Order matches the tab bar left-to-right: Explore, Gallery, Games, Settings.
function routeIndexFromPathname(pathname: string): number {
  if (pathname.startsWith('/app/explore')) return 0;
  if (pathname.startsWith('/app/games')) return 2;
  if (pathname.startsWith('/app/settings')) return 3;
  return 1;
}

/** Mobile-only capsule tab bar: press-and-drag the pill across the whole
 * width and it snaps to (and navigates to) whichever tab you release over,
 * like an iOS segmented control. Tapping or focus+Enter on a tab still
 * navigates directly. */
export function AppTabBar({ hidden = false }: { hidden?: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeIndex = routeIndexFromPathname(pathname);

  const barRef = useRef<HTMLElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startClientX: number;
    isDragging: boolean;
    px: number;
    index: number;
  } | null>(null);
  // A pointer-driven tap/drag ends in a native `click` on whichever Link the
  // browser resolves it to; the drag already decided where to navigate, so
  // that trailing click must be swallowed once rather than acted on again.
  const suppressClickRef = useRef(false);

  // isPressed is purely the "grow while held" feedback; dragPx only becomes
  // non-null once the gesture crosses DRAG_THRESHOLD_PX and turns into an
  // actual drag. A plain tap never sets dragPx, so the transform stays on
  // the (transitioned) `translateX(index * 100%)` branch and the thumb
  // slides to its target instead of jumping there.
  const [isPressed, setIsPressed] = useState(false);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [hiddenByScroll, setHiddenByScroll] = useState(false);
  // Mirrors "a pointer is currently down on the bar" for the scroll
  // listener's closure, which can't see React state without re-subscribing.
  const isInteractingRef = useRef(false);

  // Once the route confirms a drag/tap's destination, drop the local
  // override and let the URL drive the thumb again.
  useEffect(() => {
    if (pendingIndex === activeIndex) setPendingIndex(null);
  }, [activeIndex, pendingIndex]);

  // A fresh page starts at the top; without this a bar hidden by scrolling
  // down on the previous route would stay hidden after navigating.
  useEffect(() => {
    setHiddenByScroll(false);
  }, [pathname]);

  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        const delta = y - lastY;
        lastY = y;
        // A held/dragged thumb is a deliberate interaction; don't yank the
        // bar out from under the user's finger just because the page
        // scrolled a bit underneath it.
        if (isInteractingRef.current) return;
        if (y < SCROLL_HIDE_MIN_Y) {
          setHiddenByScroll(false);
        } else if (delta > SCROLL_DELTA_THRESHOLD) {
          setHiddenByScroll(true);
        } else if (delta < -SCROLL_DELTA_THRESHOLD) {
          setHiddenByScroll(false);
        }
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const displayIndex = pendingIndex ?? activeIndex;

  const navigateToIndex = useCallback(
    (index: number) => {
      switch (index) {
        case 0:
          void navigate({ to: '/app/explore' });
          return;
        case 1:
          void navigate({
            to: '/app/gallery',
            search: { fileId: undefined, fs: undefined }
          });
          return;
        case 2:
          void navigate({ to: '/app/games' });
          return;
        default:
          void navigate({ to: '/app/settings' });
      }
    },
    [navigate]
  );

  const measure = useCallback((clientX: number) => {
    const bar = barRef.current;
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    const segmentWidth = rect.width / TAB_COUNT;
    const rawPx = clientX - rect.left - segmentWidth / 2;
    const px = Math.min(Math.max(rawPx, 0), rect.width - segmentWidth);
    const index = Math.min(
      TAB_COUNT - 1,
      Math.max(0, Math.round(px / segmentWidth))
    );
    return { px, index };
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const measured = measure(event.clientX);
      if (!measured) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      // Only record where the press landed — the thumb stays put (and just
      // grows) until movement proves this is a drag, not a tap.
      dragStateRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        isDragging: false,
        ...measured
      };
      suppressClickRef.current = true;
      isInteractingRef.current = true;
      setIsPressed(true);
      setHiddenByScroll(false);
    },
    [measure]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const measured = measure(event.clientX);
      if (!measured) return;

      if (!drag.isDragging) {
        const moved = Math.abs(event.clientX - drag.startClientX);
        if (moved < DRAG_THRESHOLD_PX) {
          dragStateRef.current = { ...drag, ...measured };
          return;
        }
      }

      dragStateRef.current = { ...drag, isDragging: true, ...measured };
      setDragPx(measured.px);
      setPendingIndex(measured.index);
    },
    [measure]
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
      isInteractingRef.current = false;
      setIsPressed(false);
      setDragPx(null);
      setPendingIndex(drag.index);
      if (drag.index !== activeIndex) navigateToIndex(drag.index);
    },
    [activeIndex, navigateToIndex]
  );

  const handleLinkClick = useCallback((event: ReactMouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
    }
  }, []);

  const thumbPosition =
    dragPx !== null ? `${dragPx}px` : `${displayIndex * 100}%`;
  const thumbTransform = `translateX(${thumbPosition})${isPressed ? ' scale(1.08)' : ''}`;

  return (
    <nav
      ref={barRef}
      className={`app-tab-bar flex md:hidden ${hiddenByScroll || hidden ? 'is-hidden' : ''}`}
      aria-label="view switcher"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="app-tab-bar-thumb"
        style={{
          transform: thumbTransform,
          transitionDuration: dragPx !== null ? '0ms' : undefined
        }}
        aria-hidden="true"
      />
      <Link
        to="/app/explore"
        className={`app-tab-bar-link${displayIndex === 0 ? ' is-active' : ''}`}
        onClick={handleLinkClick}
      >
        <Compass className="app-tab-bar-icon" aria-hidden="true" />
        <span>Explore</span>
      </Link>
      <Link
        to="/app/gallery"
        search={{ fileId: undefined, fs: undefined }}
        className={`app-tab-bar-link${displayIndex === 1 ? ' is-active' : ''}`}
        onClick={handleLinkClick}
      >
        <Images className="app-tab-bar-icon" aria-hidden="true" />
        <span>Gallery</span>
      </Link>
      <Link
        to="/app/games"
        className={`app-tab-bar-link${displayIndex === 2 ? ' is-active' : ''}`}
        onClick={handleLinkClick}
      >
        <AubergineIcon className="app-tab-bar-icon" />
        <span>Games</span>
      </Link>
      <Link
        to="/app/settings"
        className={`app-tab-bar-link${displayIndex === 3 ? ' is-active' : ''}`}
        onClick={handleLinkClick}
      >
        <Settings className="app-tab-bar-icon" aria-hidden="true" />
        <span>Settings</span>
      </Link>
    </nav>
  );
}
