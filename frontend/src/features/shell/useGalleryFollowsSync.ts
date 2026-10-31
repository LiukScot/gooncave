import { useEffect, useRef } from 'react';

import type { FavoriteSyncStatus } from '@/api';

// Past this the reader is looking at files that a new one on top would push down.
const TOP_OF_PAGE_PX = 8;
const atTop = () => window.scrollY <= TOP_OF_PAGE_PX;

/**
 * Keeps the gallery current with a favorites sync, whichever screen or timer
 * started it.
 *
 * While a sync runs, `showNew` is called each time it reports more added files,
 * but only when `showing` and at the top of the page: new files go first, and
 * putting them above a reader who scrolled would move what they are reading.
 * Otherwise the call waits until they are back at the top.
 *
 * When a sync ends, `reload` runs with `keepPlace` set when the reader is away
 * from the top. A run that started and ended between two readings of the status
 * counts too: it shows up as a different `startedAt`.
 */
export function useGalleryFollowsSync(
  sync: FavoriteSyncStatus | null | undefined,
  showing: boolean,
  showNew: () => void,
  reload: (keepPlace: boolean) => void
): void {
  const seen = useRef<{ running: boolean; startedAt: string | null; added: number } | null>(null);
  const waiting = useRef(false);
  const latest = useRef({ showing, showNew, reload });
  latest.current = { showing, showNew, reload };

  const status = sync?.status;
  const startedAt = sync?.startedAt ?? null;
  const added = sync?.progress?.providers.reduce((sum, provider) => sum + provider.added, 0) ?? 0;

  useEffect(() => {
    if (status === undefined) return;
    const before = seen.current;
    const running = status === 'running';
    const sameRun = before?.startedAt === startedAt;
    seen.current = { running, startedAt, added };
    if (!before) {
      if (running && added > 0) waiting.current = true;
    } else if (running) {
      if (added > (sameRun ? before.added : 0)) waiting.current = true;
    } else if (before.running || !sameRun) {
      const here = latest.current.showing && atTop();
      waiting.current = !here;
      latest.current.reload(!here);
      return;
    }
    if (waiting.current && latest.current.showing && atTop()) {
      waiting.current = false;
      latest.current.showNew();
    }
  }, [status, startedAt, added]);

  // Coming back to the top, or closing a file opened from there, shows what waited.
  useEffect(() => {
    if (!showing) return;
    const show = () => {
      if (!waiting.current || !atTop()) return;
      waiting.current = false;
      latest.current.showNew();
    };
    show();
    window.addEventListener('scroll', show, { passive: true });
    return () => window.removeEventListener('scroll', show);
  }, [showing]);
}
