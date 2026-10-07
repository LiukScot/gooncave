import { useLayoutEffect, useRef } from 'react';

import { restoreScrollTo } from '@/features/file-detail/restoreScrollTo';

/** Restore the results only while they are the page the reader is viewing. */
export function useExploreGridScrollRestore(
  scrollY: number | null,
  gridVisible: boolean
): void {
  const leftGridRef = useRef(false);
  useLayoutEffect(() => {
    if (scrollY === null) return;
    if (!gridVisible) {
      leftGridRef.current = true;
      return;
    }
    if (leftGridRef.current) return;
    return restoreScrollTo(scrollY);
  }, [gridVisible, scrollY]);
}
