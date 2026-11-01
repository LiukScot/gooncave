import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/api';
import { isOnline, useOnline } from '@/lib/online';


type Failure = { state: 'checking' } | { state: 'failed'; reason: string };

const OFFLINE = 'You are offline and the original is not on this device. It opens when you reconnect.';
const UNREADABLE = 'The file is on this device, but this viewer cannot show its format.';

/**
 * Renders the open file's original and, when it does not load, says why with a way to try again.
 * A file that is not on this device loads from the sync folder or a booru when opened, so this is
 * where a missing connection shows up.
 */
export function OriginalMedia({
  fileId,
  render
}: {
  fileId: string;
  render: (props: { key: number; onError: () => void }) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [retried, setRetried] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const online = useOnline();
  const failed = failure?.state === 'failed';

  useEffect(() => {
    if (online && failed) tryAgain();
    // Only reconnecting retries; a failure while connected waits for the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // Closing the file, or moving to another, lets the core drop an original that opening it downloaded.
  useEffect(
    () => () => {
      api.releaseOriginal(fileId).catch((error: unknown) => console.warn('Could not release the opened file', fileId, error));
    },
    [fileId]
  );

  const tryAgain = () => {
    setFailure(null);
    setAttempt((current) => current + 1);
  };

  // The element only reports that loading failed; the core puts the reason in the response body.
  const explain = async () => {
    setFailure({ state: 'checking' });
    try {
      const reason = await api.contentError(fileId);
      if (reason !== null) {
        setFailure({ state: 'failed', reason: isOnline() ? reason : OFFLINE });
      } else if (retried) {
        // The core serves the file, so the browser is what cannot read it: retrying would loop.
        setFailure({ state: 'failed', reason: UNREADABLE });
      } else {
        // Asking for the reason fetched the original, so it may load now.
        setRetried(true);
        tryAgain();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFailure({ state: 'failed', reason: `GoonCave did not answer: ${message}` });
    }
  };

  if (failure?.state === 'checking') {
    return (
      <div className="file-detail-media file-detail-media-error" role="status">
        <p className="text-muted-foreground text-sm">Checking why this file did not open…</p>
      </div>
    );
  }
  if (failure) {
    return (
      <div className="file-detail-media file-detail-media-error" role="alert">
        <p className="font-medium">This file could not be opened.</p>
        <p className="text-muted-foreground text-sm">{failure.reason}</p>
        <button className="btn btn-outline-light btn-sm" type="button" onClick={tryAgain}>
          Try again
        </button>
      </div>
    );
  }
  return render({ key: attempt, onError: () => void explain() });
}
