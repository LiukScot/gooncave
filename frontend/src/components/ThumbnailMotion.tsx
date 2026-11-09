import { useEffect, useRef, useState } from 'react';

import { API_BASE } from '@/api';
export function ThumbnailMotion({ poster, remote }: { poster: string | null; remote?: string | null }) {
  const url = poster?.startsWith('/thumbnails/') ? `${API_BASE}${poster}` : poster;
  if (url?.startsWith(`${API_BASE}/thumbnails/`) && url.endsWith('-motion.jpg')) {
    return <NearViewportMotion key={url} src={`${url}?motion=1`} />;
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

function NearViewportMotion({ src, fetchPreview = false }: { src: string; fetchPreview?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);

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
      {near && !failed ? (
        <MotionVideo src={src} fetchPreview={fetchPreview} onError={() => setFailed(true)} />
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
        if (!controller.signal.aborted) {
          console.warn('[developer] Cannot load the animated thumbnail.', error);
        }
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [fetchPreview, src]);
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
