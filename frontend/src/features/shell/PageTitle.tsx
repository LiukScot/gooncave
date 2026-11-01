import { PanelLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useAppMenuStore } from '@/stores/appMenuStore';

/** Near the top of the page the heading always shows. */
const ALWAYS_SHOWN_ABOVE_PX = 24;
/** A finger drifts while it rests: only this much travel counts as a direction. */
const DIRECTION_PX = 8;

function useHiddenWhileScrollingDown(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    // A rubber-band bounce past the end must not read as scrolling back up.
    const position = () =>
      Math.min(
        window.scrollY,
        document.documentElement.scrollHeight - window.innerHeight
      );
    let last = position();
    let frame = 0;
    const measure = () => {
      frame = 0;
      const y = position();
      if (y < ALWAYS_SHOWN_ABOVE_PX) {
        last = y;
        setHidden(false);
      } else if (Math.abs(y - last) >= DIRECTION_PX) {
        setHidden(y > last);
        last = y;
      }
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return hidden;
}

/**
 * A view's heading. It slides away while the reader scrolls down and comes back
 * as soon as they scroll up. On a narrow screen the button beside it opens the
 * side menu; `icon` shows only where the menu stays open and the button is gone.
 */
export function PageTitle({
  icon,
  count,
  children
}: {
  icon: ReactNode;
  /** What the view is showing, such as "120 items". */
  count?: string;
  children: ReactNode;
}) {
  const setOpen = useAppMenuStore((state) => state.setOpen);
  const hidden = useHiddenWhileScrollingDown();
  return (
    <div className={`page-header mb-4${hidden ? ' is-scrolled-away' : ''}`}>
      <button
        type="button"
        className="app-menu-button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
      >
        <PanelLeft aria-hidden="true" />
      </button>
      <h1 className="uppercase font-semibold file-detail-section-title page-title">
        {icon}
        {children}
      </h1>
      {count ? (
        <span className="page-header-count text-muted-foreground text-sm">
          {count}
        </span>
      ) : null}
    </div>
  );
}
