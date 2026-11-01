import { Link, useLocation } from '@tanstack/react-router';
import { Compass, History, Images, Rss, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef } from 'react';

import { handleViewReselect } from './viewReselect';

import type { ExploreFeed } from '@/api';
import { DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { EDGE_PX } from '@/lib/edgeSwipeBack';
import { useAppMenuStore } from '@/stores/appMenuStore';
import { useExploreUiStore } from '@/stores/exploreUiStore';
import { useGalleryUiStore } from '@/stores/galleryUiStore';

type MenuItem = {
  label: string;
  icon: LucideIcon;
  to: '/app/explore' | '/app/gallery' | '/app/settings';
  feed?: ExploreFeed;
};

const TOP_ITEMS: MenuItem[] = [
  { label: 'Explore', icon: Compass, to: '/app/explore' },
  { label: 'Gallery', icon: Images, to: '/app/gallery' },
  { label: 'Subscriptions', icon: Rss, to: '/app/explore', feed: 'subscribed' },
  { label: 'History', icon: History, to: '/app/explore', feed: 'history' }
];
const SETTINGS_ITEM: MenuItem = {
  label: 'Settings',
  icon: Settings,
  to: '/app/settings'
};

// Keep in step with the width at which app.css keeps the menu showing.
const PERMANENT_MENU = '(min-width: 1024px)';
/** Travel from the edge that opens the menu, so a tap stays a tap. */
const SWIPE_OPEN_PX = 48;
/** Scrolling near the edge drifts sideways too; the swipe has to lead by this. */
const SWIPE_DOMINANCE = 2;

const useMenuLocation = () => {
  const { pathname, search } = useLocation();
  return { pathname, feed: (search as { feed?: ExploreFeed }).feed };
};

// Tapping the open view again starts it over: its search is cleared (and the
// page goes back to the top, see handleViewReselect).
const clearViewSearch = ({ to, feed }: MenuItem): void => {
  if (to === '/app/gallery') {
    const gallery = useGalleryUiStore.getState();
    gallery.setGalleryTagInput('');
    gallery.setGalleryTagQuery('');
  } else if (to === '/app/explore' && !feed) {
    // Explore takes a search handed to it; an empty one clears the box.
    useExploreUiStore.getState().setPendingSearch('');
  }
};

function MenuLink({
  item,
  detailOpen,
  onReselect
}: {
  item: MenuItem;
  detailOpen: boolean;
  onReselect?: () => void;
}) {
  const { pathname, feed } = useMenuLocation();
  const active = pathname.startsWith(item.to) && feed === item.feed;
  // A Settings page lights up Settings, whose link still leads back to the list.
  const onThisPage = active && pathname.replace(/\/$/, '') === item.to;
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      search={
        item.to === '/app/gallery'
          ? { fileId: undefined, fs: undefined }
          : item.to === '/app/explore'
            ? { post: undefined, feed: item.feed }
            : undefined
      }
      className={`app-menu-link${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        // With a file or post open the link goes back to the list, so it is
        // not a reselect.
        handleViewReselect(event, onThisPage && !detailOpen, () =>
          clearViewSearch(item)
        );
        if (onThisPage) onReselect?.();
      }}
    >
      <Icon aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function MenuBody({
  detailOpen,
  onReselect
}: {
  detailOpen: boolean;
  onReselect?: () => void;
}) {
  return (
    <nav className="app-menu-body" aria-label="Main menu">
      <p className="app-menu-brand">GoonCave</p>
      {TOP_ITEMS.map((item) => (
        <MenuLink
          key={item.label}
          item={item}
          detailOpen={detailOpen}
          onReselect={onReselect}
        />
      ))}
      <div className="app-menu-end">
        <MenuLink
          item={SETTINGS_ITEM}
          detailOpen={detailOpen}
          onReselect={onReselect}
        />
      </div>
    </nav>
  );
}

/**
 * The views, in a column on the left. A wide screen keeps it showing. A narrow
 * one slides it in and pushes the page aside, from the button by the title or a
 * swipe from the left edge. Pages with a way back of their own keep that edge
 * for it.
 */
export function AppMenu({ detailOpen }: { detailOpen: boolean }) {
  const open = useAppMenuStore((state) => state.open);
  const setOpen = useAppMenuStore((state) => state.setOpen);
  const { pathname, feed } = useMenuLocation();
  const canSwipeOpen = useRef(false);
  canSwipeOpen.current =
    !detailOpen &&
    ['/app/gallery', '/app/explore', '/app/games', '/app/settings'].includes(
      pathname.replace(/\/$/, '')
    );

  useEffect(() => {
    setOpen(false);
  }, [pathname, feed, setOpen]);

  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 &&
        touch.clientX <= EDGE_PX &&
        canSwipeOpen.current &&
        !document.querySelector('[role="dialog"]')
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const across = touch.clientX - start.x;
      if (
        across < SWIPE_OPEN_PX ||
        across < Math.abs(touch.clientY - start.y) * SWIPE_DOMINANCE
      ) {
        return;
      }
      start = null;
      setOpen(true);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
    };
  }, [setOpen]);

  // A phone turned sideways can cross the width: the drawer's trap would stay
  // on with the drawer itself gone.
  useEffect(() => {
    const permanent = window.matchMedia(PERMANENT_MENU);
    const close = () => {
      if (permanent.matches) setOpen(false);
    };
    permanent.addEventListener('change', close);
    return () => permanent.removeEventListener('change', close);
  }, [setOpen]);

  return (
    <>
      <aside className={`app-menu${detailOpen ? ' is-hidden' : ''}`}>
        <MenuBody detailOpen={detailOpen} />
      </aside>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogOverlay className="app-menu-scrim" />
          <DialogPrimitive.Content
            className="app-menu-drawer"
            aria-describedby={undefined}
            // Radix hands focus back only to its own Trigger. The button sits at
            // the top of the page, and must not scroll the reader up to it.
            onCloseAutoFocus={() =>
              document
                .querySelector<HTMLElement>('.app-menu-button')
                ?.focus({ preventScroll: true })
            }
          >
            <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
            <MenuBody
              detailOpen={detailOpen}
              onReselect={() => setOpen(false)}
            />
            <DialogPrimitive.Close className="app-menu-close" aria-label="Close menu">
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPortal>
      </DialogPrimitive.Root>
    </>
  );
}
