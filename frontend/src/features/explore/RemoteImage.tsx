import React, { useEffect, useState } from 'react';

import { mediaSrc } from './exploreMedia';

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
  className,
  ...imgProps
}: RemoteImageProps): React.ReactElement {
  const [state, setState] = useState({ src, attempt: 0, failed: false });
  const current = state.src === src ? state : { src, attempt: 0, failed: false };
  if (current !== state) setState(current);

  const retriesLeft = current.attempt < RETRY_DELAYS_MS.length;
  useEffect(() => {
    if (!current.failed || !retriesLeft) return;
    const timer = setTimeout(() => {
      setState((previous) =>
        previous.src === src
          ? { src, attempt: previous.attempt + 1, failed: false }
          : previous
      );
    }, RETRY_DELAYS_MS[current.attempt]);
    return () => clearTimeout(timer);
  }, [current.failed, current.attempt, retriesLeft, src]);

  if (current.failed && !retriesLeft) return <>{fallback}</>;
  return (
    <img
      // A new element per try: setting the same src again does not reload.
      key={current.attempt}
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
