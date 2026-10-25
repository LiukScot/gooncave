import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

const POLL_MS = 3000;

const GAP_PX = 8;

/**
 * Tells the reader while the core repairs favorite links that point at the wrong file. It looks
 * like a toast but is not one: sonner pauses every toast's timer while the pointer is over its
 * stack, so one that never ends would hold the others up. The toasts rise above it instead.
 */
/** `hidden` keeps it off a picture's detail view, which takes the whole screen. */
export function LibraryRepairNotice({ hidden }: { hidden: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.duplicates.libraryRepair(),
    queryFn: () => api.getLibraryRepair(),
    refetchInterval: (query) => (query.state.data?.running ? POLL_MS : false)
  });
  const wasRunning = useRef(false);
  const running = data?.running === true;
  const percent = data?.percent ?? 0;

  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    // Explore marks a post as saved from these links.
    queryClient.invalidateQueries({ queryKey: ['explore'] });
  }, [running, queryClient]);

  const shown = running && !hidden;
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!shown || !box.current) return;
    const root = document.documentElement;
    root.style.setProperty('--repair-lift', `${box.current.offsetHeight + GAP_PX}px`);
    return () => {
      root.style.removeProperty('--repair-lift');
    };
  }, [shown, percent]);

  if (!shown) return null;
  return (
    <div ref={box} className="floating-capsule library-repair-notice" role="status">
      <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
      <div className="library-repair-text">
        <strong>We&apos;re fixing some errors in the database: {percent}%</strong>
        <span>Some favorites may change meanwhile. If you close the app it continues where it stopped.</span>
      </div>
    </div>
  );
}
