import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, Images, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { FileItem } from '@/api';
import { API_BASE } from '@/api';
import {
  estimateMasonryTileHeight,
  tileRatio
} from '@/features/library/masonry';
import { formatDuration } from '@/lib/format';

const THUMB_SIZE = 220;
const MIN_COLUMNS = 2;

type MasonryMetrics = {
  columns: number;
  columnWidth: number;
  gap: number;
  scrollMargin: number;
};

const initialMetrics: MasonryMetrics = {
  columns: MIN_COLUMNS,
  columnWidth: THUMB_SIZE,
  gap: 0,
  scrollMargin: 0
};

function useMasonryMetrics() {
  const [metrics, setMetrics] = useState(initialMetrics);
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      const columns = Math.max(
        MIN_COLUMNS,
        Math.floor(width / THUMB_SIZE)
      );
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      const columnWidth = Math.max(
        0,
        (width - gap * (columns - 1)) / columns
      );
      const scrollMargin = element.getBoundingClientRect().top + window.scrollY;
      setMetrics((current) => {
        if (
          current.columns === columns &&
          current.columnWidth === columnWidth &&
          current.gap === gap &&
          current.scrollMargin === scrollMargin
        ) {
          return current;
        }
        return { columns, columnWidth, gap, scrollMargin };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [metrics, measureRef] as const;
}

export function VirtualGalleryMasonry({
  files,
  voteSystemEnabled,
  onFileOpen
}: {
  files: FileItem[];
  voteSystemEnabled: boolean;
  onFileOpen: (file: FileItem) => void;
}) {
  const [metrics, masonryRef] = useMasonryMetrics();
  const getItemKey = useCallback((index: number) => files[index].id, [files]);
  const estimateSize = useCallback(
    (index: number) => {
      const file = files[index];
      const ratio =
        file.thumbUrl && file.width && file.height
          ? file.width / file.height
          : null;
      return estimateMasonryTileHeight(
        metrics.columnWidth,
        ratio,
        THUMB_SIZE
      );
    },
    [files, metrics.columnWidth]
  );
  const virtualizer = useWindowVirtualizer({
    count: files.length,
    lanes: metrics.columns,
    gap: metrics.gap,
    scrollMargin: metrics.scrollMargin,
    getItemKey,
    estimateSize,
    overscan: metrics.columns * 2
  });
  useEffect(() => {
    virtualizer.measure();
  }, [metrics.columnWidth, virtualizer]);

  return (
    <div
      className="gallery-masonry is-virtual"
      ref={masonryRef}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const file = files[item.index];
        return (
          <div
            key={item.key}
            data-index={item.index}
            className="gallery-masonry-item"
            style={{
              width: metrics.columnWidth,
              transform: `translate(${item.lane * (metrics.columnWidth + metrics.gap)}px, ${item.start - metrics.scrollMargin}px)`
            }}
          >
            <GalleryCard
              file={file}
              voteSystemEnabled={voteSystemEnabled}
              onFileOpen={onFileOpen}
            />
          </div>
        );
      })}
    </div>
  );
}

function GalleryCard({
  file,
  voteSystemEnabled,
  onFileOpen
}: {
  file: FileItem;
  voteSystemEnabled: boolean;
  onFileOpen: (file: FileItem) => void;
}) {
  const thumbRatio = tileRatio(
    file.thumbUrl && file.width && file.height ? file.width / file.height : null
  );

  return (
    <button
      type="button"
      className="border-0 bg-transparent p-0 text-left w-full"
      data-test-id="file-card"
      aria-label={`Open ${file.path}${
        file.mediaType === 'VIDEO' ? ' (video)' : ''
      }${
        voteSystemEnabled && file.voteScore > 0
          ? `, score ${file.voteScore}`
          : ''
      }${file.hasRelations ? ', has related posts' : ''}`}
      onClick={() => onFileOpen(file)}
    >
      <div
        className={`gallery-thumb${thumbRatio ? ' is-sized' : ''}`}
        style={
          {
            '--gallery-thumb-max': `${THUMB_SIZE}px`,
            ...(thumbRatio ? { '--gallery-thumb-ratio': thumbRatio } : {})
          } as React.CSSProperties
        }
      >
        {file.thumbUrl ? (
          <img
            src={`${API_BASE}${file.thumbUrl}`}
            alt={file.path}
            width={file.width ?? THUMB_SIZE}
            height={file.height ?? THUMB_SIZE}
            className="gallery-thumb-img rounded"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
          />
        ) : (
          <div
            className="rounded flex items-center justify-center bg-background"
            style={{ height: THUMB_SIZE }}
          >
            <span className="text-muted-foreground text-sm">
              {file.mediaType.toLowerCase()}
            </span>
          </div>
        )}
        {file.mediaType === 'VIDEO' && file.thumbUrl ? (
          <Play
            aria-hidden="true"
            fill="currentColor"
            className="absolute inset-0 m-auto size-10 rounded-full bg-background/70 p-2 text-foreground"
          />
        ) : null}
        {file.durationMs ? (
          <span className="gallery-chip left-2">
            {formatDuration(file.durationMs)}
          </span>
        ) : null}
        {voteSystemEnabled && file.voteScore > 0 ? (
          <span data-test-id="card-score" className="gallery-chip right-2">
            <ChevronUp className="size-3" aria-hidden="true" />
            {file.voteScore}
          </span>
        ) : null}
        {file.hasRelations ? (
          <span
            data-test-id="card-relations"
            className="gallery-chip gallery-chip-bottom right-2"
            title="Part of a parent/child post group"
          >
            <Images className="size-3" aria-hidden="true" />
          </span>
        ) : null}
      </div>
    </button>
  );
}
