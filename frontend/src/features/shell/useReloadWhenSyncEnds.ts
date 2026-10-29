import { useEffect, useRef } from 'react';

/** Calls `reload` when a favorites sync that was running is no longer running. */
export function useReloadWhenSyncEnds(status: string | undefined, reload: () => void): void {
  const wasRunning = useRef(false);
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (wasRunning.current && status !== 'running') latest.current();
    wasRunning.current = status === 'running';
  }, [status]);
}
