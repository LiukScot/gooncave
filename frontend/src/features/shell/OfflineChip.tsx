import { WifiOff } from 'lucide-react';

import { useOnline } from '@/lib/online';

/** Says the device is offline, beside a page's heading. */
export function OfflineChip() {
  const online = useOnline();
  // The status stays in the page so a screen reader announces the chip when it appears.
  return (
    <span role="status" className="offline-status">
      {online ? null : (
        <span className="offline-chip">
          <WifiOff aria-hidden="true" />
          Offline
        </span>
      )}
    </span>
  );
}
