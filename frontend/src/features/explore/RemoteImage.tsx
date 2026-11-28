import React, { useEffect, useState } from 'react';

import { mediaSrc } from './exploreMedia';
import { postRemoved } from './explorePostDetails';

import { useOnline } from '@/lib/online';

// A booru CDN that refuses a burst (FurAffinity's Cloudflare answers 403)
// lets requests through again within a minute or two.
const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

type RemoteImageProps = Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'onError'
> & {
  src: string;
  /** Shown once every retry has failed. */
  fallback: React.ReactNode;
  /** A site's post: on the first failure the site is asked whether it removed it. */
  removed?: { post: { siteId: string; remoteId: string }; fallback: React.ReactNode };
};

/**
 * An <img> for a booru post's media that loads again after a failure.
 *
 * The browser never retries a broken image on its own: without this, a
 * thumbnail refused once stayed an alt text until the page was reloaded.
 * Between tries the element is hidden rather than removed, so the tile keeps
 * its size.
 */
export function RemoteImage({
  src,
  fallback,
  removed,
  className,
  ...imgProps
}: RemoteImageProps): React.ReactElement {
  const [state, setState] = useState({ src, attempt: 0, failed: false, reconnects: 0, gone: false });
  const current = state.src === src ? state : { src, attempt: 0, failed: false, reconnects: 0, gone: false };
  if (current !== state) setState(current);

  // Whatever failed offline is worth trying at once, with its retries back.
  const online = useOnline();
  useEffect(() => {
    if (!online) return;
    setState((previous) =>
      previous.failed
        ? { ...previous, attempt: 0, failed: false, reconnects: previous.reconnects + 1 }
        : previous
    );
  }, [online]);

  const siteId = removed?.post.siteId;
  const remoteId = removed?.post.remoteId;
  const firstFailure = current.failed && current.attempt === 0;
  useEffect(() => {
    if (!firstFailure || siteId === undefined || remoteId === undefined) return;
    let live = true;
    void postRemoved({ siteId, remoteId }).then((gone) => {
      if (live && gone) setState((previous) => (previous.src === src ? { ...previous, gone } : previous));
    });
    return () => {
      live = false;
    };
  }, [firstFailure, siteId, remoteId, src]);

  const retriesLeft = current.attempt < RETRY_DELAYS_MS.length;
  useEffect(() => {
    if (!current.failed || !retriesLeft || current.gone) return;
    const timer = setTimeout(() => {
      setState((previous) =>
        previous.src === src
          ? { ...previous, attempt: previous.attempt + 1, failed: false }
          : previous
      );
    }, RETRY_DELAYS_MS[current.attempt]);
    return () => clearTimeout(timer);
  }, [current.failed, current.attempt, current.gone, retriesLeft, src]);

  if (current.gone && removed) return <>{removed.fallback}</>;
  if (current.failed && !retriesLeft) return <>{fallback}</>;
  return (
    <img
      // A new element per try: setting the same src again does not reload.
      key={`${current.reconnects}-${current.attempt}`}
      {...imgProps}
      src={mediaSrc(src)}
      className={`${className ?? ''}${current.failed ? ' invisible' : ''}`}
      onError={() =>
        setState((previous) =>
          previous.src === src ? { ...previous, failed: true } : previous
        )
      }
    />
  );
}
