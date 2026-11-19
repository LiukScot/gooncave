import { useNavigate } from '@tanstack/react-router';
import { WifiOff } from 'lucide-react';

import { PageTitle } from './PageTitle';

/** Takes the place of a view that lives on the booru sites. */
export function OfflineView({ feature }: { feature: string }) {
  const navigate = useNavigate();
  // Offline the gallery shows only what is on this device.
  const showDownloaded = () =>
    void navigate({ to: '/app/gallery', search: { fileId: undefined, fs: undefined } });
  return (
    <div className="page-chrome">
      <PageTitle icon={<WifiOff className="page-title-icon" aria-hidden="true" />}>
        {feature}
      </PageTitle>
      <div className="gallery-empty text-muted-foreground">
        <p>No signal in the cave. This page comes from the booru sites, so it comes back when you reconnect.</p>
        <button className="btn btn-outline-light btn-sm mt-2" type="button" onClick={showDownloaded}>
          Show downloaded files
        </button>
      </div>
    </div>
  );
}
