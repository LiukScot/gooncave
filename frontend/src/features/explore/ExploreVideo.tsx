import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';

import { VideoPlayer } from '@/features/file-detail/VideoPlayer';
import { logDeveloper } from '@/lib/windowErrorLog';

/** A start slower than this is logged, to find which sites and files are slow. */
const SLOW_START_MS = 3000;

const REASONS: Record<number, string> = {
  1: 'stopped',
  2: 'network error',
  3: 'cannot decode',
  4: 'format or address not supported'
};

/** What the log may say about a video's address: the host and the extension, never the path. */
const describeSource = (src: string): string => {
  try {
    const url = new URL(src, location.href);
    const ext = /\.([a-z0-9]{2,5})$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? 'no extension';
    return `${ext} from ${url.host}`;
  } catch {
    return 'an unreadable address';
  }
};

/**
 * A post's video in Explore. When it cannot load it says so with a way to try again, and the app
 * log records slow starts and failures by site, so a report shows which videos are affected.
 */
export function ExploreVideo({
  siteName,
  src,
  ref,
  ...props
}: ComponentProps<typeof VideoPlayer> & { siteName: string; src: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<number | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const shownAt = useRef(performance.now());
  // The caller's ref is a new function at each render; a stable one keeps the element from
  // being detached and attached again, which would reset the listeners below every time.
  const callerRef = useRef(ref);
  useLayoutEffect(() => {
    callerRef.current = ref;
  });
  const attach = useCallback((video: HTMLVideoElement | null) => {
    setElement(video);
    const caller = callerRef.current;
    if (typeof caller === 'function') caller(video);
    else if (caller) caller.current = video;
  }, []);

  useEffect(() => {
    if (!element) return;
    let askedAt: number | null = null;
    const source = describeSource(src);
    const play = () => {
      askedAt ??= performance.now();
    };
    const playing = () => {
      if (askedAt === null) return;
      const waited = performance.now() - askedAt;
      askedAt = null;
      if (waited > SLOW_START_MS) {
        logDeveloper(`An Explore video on ${siteName} took ${(waited / 1000).toFixed(1)} s to start (${source}).`);
      }
    };
    const error = () => {
      const code = element.error?.code ?? 0;
      logDeveloper(
        `An Explore video on ${siteName} did not load: ${REASONS[code] ?? `error ${code}`} (${source}, ` +
          `after ${((performance.now() - shownAt.current) / 1000).toFixed(1)} s).`
      );
      setFailure(code);
    };
    element.addEventListener('play', play);
    element.addEventListener('waiting', play);
    element.addEventListener('playing', playing);
    element.addEventListener('error', error);
    return () => {
      element.removeEventListener('play', play);
      element.removeEventListener('waiting', play);
      element.removeEventListener('playing', playing);
      element.removeEventListener('error', error);
    };
  }, [element, siteName, src]);

  if (failure !== null) {
    return (
      <div className="file-detail-media file-detail-media-error" role="alert">
        <p className="font-medium">This video could not be played.</p>
        <p className="text-muted-foreground text-sm">
          {failure === 4
            ? `${siteName} sent a format this device cannot play, or refused the request. Open the post on ${siteName} to watch it there.`
            : `The video stopped loading from ${siteName}. Check the connection and try again.`}
        </p>
        <button
          className="btn btn-outline-light btn-sm"
          type="button"
          onClick={() => {
            shownAt.current = performance.now();
            setFailure(null);
            setAttempt((current) => current + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <VideoPlayer
      key={attempt}
      {...props}
      src={src}
      ref={attach}
    />
  );
}
