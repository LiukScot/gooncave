import { Link, useLocation } from '@tanstack/react-router';
import { Compass, Images, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { handleViewReselect } from './viewReselect';

import { AubergineIcon } from '@/components/icons/AubergineIcon';

type TabRoute =
  '/app/explore' | '/app/gallery' | '/app/games' | '/app/settings';

type Tab = {
  to: TabRoute;
  label: string;
  icon: LucideIcon | ((props: { className?: string }) => React.ReactElement);
  /** Drawn as the bar's accent shape instead of a bare icon. */
  prominent?: boolean;
};

const ALL_TABS: Tab[] = [
  { to: '/app/explore', label: 'Explore', icon: Compass, prominent: true },
  { to: '/app/gallery', label: 'Gallery', icon: Images },
  { to: '/app/games', label: 'Games', icon: AubergineIcon },
  { to: '/app/settings', label: 'Settings', icon: Settings }
];

// Ignore scroll direction this close to the top — content there barely
// scrolls, and it reads as jitter rather than an intentional swipe.
const SCROLL_HIDE_MIN_Y = 24;
const SCROLL_DELTA_THRESHOLD = 4;
// Gallery is the fallback: it owns /app itself and any route with no tab.
function tabIndexFromPathname(pathname: string, tabs: Tab[]): number {
  const found = tabs.findIndex((tab) => pathname.startsWith(tab.to));
  if (found !== -1) return found;
  const gallery = tabs.findIndex((tab) => tab.to === '/app/gallery');
  return gallery === -1 ? 0 : gallery;
}

/** The view switcher: a capsule at the bottom of the screen. Explore is the
 * accent shape; the other views are icons, and the open one widens to show
 * its name. */
export function AppTabBar({ hidden = false }: { hidden?: boolean }) {
  const { pathname } = useLocation();
  const activeIndex = tabIndexFromPathname(pathname, ALL_TABS);
  const [hiddenByScroll, setHiddenByScroll] = useState(false);

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

  return (
    <nav
      className={`floating-capsule app-tab-bar flex ${hiddenByScroll || hidden ? 'is-hidden' : ''}`}
      aria-label="view switcher"
    >
      {ALL_TABS.map((tab, index) => {
        const Icon = tab.icon;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            search={
              tab.to === '/app/gallery'
                ? { fileId: undefined, fs: undefined }
                : tab.to === '/app/explore'
                  ? { post: undefined }
                  : undefined
            }
            className={`app-tab-bar-link${tab.prominent ? ' is-prominent' : ''}${activeIndex === index ? ' is-active' : ''}`}
            // With a file or post open the link goes back to the list, so it
            // is not a reselect.
            onClick={(event) =>
              handleViewReselect(event, tab.to === pathname && !hidden)
            }
          >
            <span className="app-tab-bar-shape">
              <Icon className="app-tab-bar-icon" aria-hidden="true" />
            </span>
            <span className="app-tab-bar-label">
              <span>{tab.label}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
