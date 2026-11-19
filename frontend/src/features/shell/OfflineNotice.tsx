import { useNavigate } from '@tanstack/react-router';

/**
 * Shown offline where a page from the booru sites has nothing saved on this device: the core
 * answers Explore, Subscriptions and Pools from its cache, so only what was never loaded is missing.
 */
export function OfflineNotice({ className }: { className?: string }) {
  const navigate = useNavigate();
  // Offline the gallery shows only what is on this device.
  const showDownloaded = () =>
    void navigate({ to: '/app/gallery', search: { fileId: undefined, fs: undefined } });
  return (
    <div className={className}>
      <p className="block">
        No signal in the cave. Nothing here is saved on this device yet, so it comes back when
        you reconnect.
      </p>
      <button className="btn btn-outline-light btn-sm mt-2" type="button" onClick={showDownloaded}>
        Show downloaded files
      </button>
    </div>
  );
}
