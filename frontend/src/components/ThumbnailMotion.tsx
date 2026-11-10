import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE } from '@/api';
export function ThumbnailMotion({ poster, remote, providerGif }: { poster: string | null; remote?: string | null; providerGif?: boolean }) {
  const url = poster?.startsWith('/thumbnails/') ? `${API_BASE}${poster}` : poster;
  if (url?.startsWith(`${API_BASE}/thumbnails/`) && (url.endsWith('-motion.jpg') || (providerGif && url.endsWith('.jpg')))) {
    // Fetched like Explore's previews: the video element's own request gives up on a GIF that
    // takes seconds to convert.
    return <NearViewportMotion key={url} src={`${url}?motion=1`} fetchPreview />;
  }
  if (remote?.startsWith('/explore/media/')) {
    return <NearViewportMotion key={remote} src={`${API_BASE}${remote}`} fetchPreview />;
  }
  return null;
}

function releaseOnDetach(video: HTMLVideoElement | null) {
  if (!video) return;
  return () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}

/** Tiles that may play at once. Each one holds a video decoder, and the iPhone web view is
    closed and reloaded when too many run together. */
export const MAX_PLAYING_TILES = 6;
let freeSlots = MAX_PLAYING_TILES;
const waiting: Array<() => void> = [];

/** Calls `grant` once a slot is free; the returned function gives the slot back or leaves the queue. */
function claimSlot(grant: () => void): () => void {
  let held = false;
  const take = () => {
    held = true;
    freeSlots -= 1;
    grant();
  };
  if (freeSlots > 0) take();
  else waiting.push(take);
  return () => {
    if (held) {
      freeSlots += 1;
      waiting.shift()?.();
    } else {
      waiting.splice(waiting.indexOf(take), 1);
    }
  };
}

function NearViewportMotion({ src, fetchPreview = false }: { src: string; fetchPreview?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);
  const [slot, setSlot] = useState(false);
  const fail = useCallback(() => setFailed(true), []);

  useEffect(() => {
    if (!near || failed) return;
    const release = claimSlot(() => setSlot(true));
    return () => {
      release();
      setSlot(false);
    };
  }, [near, failed]);

  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let intersecting = false;
    const update = () => setNear(intersecting && !reduced.matches);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    }, { rootMargin: '64px 0px' });
    observer.observe(element);
    reduced.addEventListener('change', update);
    return () => {
      observer.disconnect();
      reduced.removeEventListener('change', update);
    };
  }, []);

  return (
    <span ref={anchor} aria-hidden="true" className="pointer-events-none absolute inset-0">
      {near && !failed && slot ? (
        <MotionVideo src={src} fetchPreview={fetchPreview} onError={fail} />
      ) : null}
    </span>
  );
}

function MotionVideo({ src, fetchPreview, onError }: { src: string; fetchPreview: boolean; onError: () => void }) {
  const [blob, setBlob] = useState<string | null>(null);
  useEffect(() => {
    if (!fetchPreview) return;
    const controller = new AbortController();
    let url: string | undefined;
    void fetch(src, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
        return response.blob();
      })
      .then((preview) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(preview);
        setBlob(url);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[developer] Cannot load the animated thumbnail.', error);
        onError();
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [fetchPreview, onError, src]);
  const source = fetchPreview ? blob : src;
  return source ? (
    <video
      ref={releaseOnDetach}
      src={source}
      muted
      loop
      autoPlay
      playsInline
      className="gallery-thumb-img size-full"
      onPlaying={(event) => event.currentTarget.classList.add('is-loaded')}
      onError={onError}
    />
  ) : null;
}
