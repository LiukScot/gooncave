import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, Clock, Images, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { stackGalleryFiles, type GalleryStack } from './galleryDuplicateStacks';
import { GallerySourceIcon } from './GallerySourceIcon';
import { gallerySourceIcons } from './gallerySourceIcons';

import type { BooruSite, DuplicateGroup, FileItem } from '@/api';
import { API_BASE } from '@/api';
import { formatVoteCooldown } from '@/features/file-detail/vote';
import {
  estimateMasonryTileHeight,
  tileRatio
} from '@/features/library/masonry';
import { queueRead } from '@/features/read-marks/readQueue';
import {
  averageRowHeight,
  readerMovedPast,
  ROWS_BEHIND
} from '@/features/read-marks/useScrolledPastRead';
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

function useMasonryMetrics(maxGridColumns: number) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      const availableColumns = Math.max(
        MIN_COLUMNS,
        Math.floor(width / THUMB_SIZE)
      );
      const columns = maxGridColumns > 0
        ? Math.min(availableColumns, maxGridColumns)
        : availableColumns;
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
  }, [maxGridColumns]);
  return [metrics, measureRef] as const;
}

/** What a rendered tile has to beat before it counts as read. */
type ReadCandidate = {
  /** Where the page stood the first time this tile was rendered. */
  seenAtScrollY: number;
  /** The tile's bottom edge in document coordinates. */
  end: number;
};

export function VirtualGalleryMasonry({
  files,
  duplicateGroups = [],
  sourceSites = [],
  voteSystemEnabled,
  maxGridColumns = 0,
  oldestPositionFolderId = null,
  markReadOnScrollPast = false,
  onFileOpen,
  onUpvote
}: {
  files: FileItem[];
  duplicateGroups?: DuplicateGroup[];
  sourceSites?: BooruSite[];
  voteSystemEnabled: boolean;
  maxGridColumns?: number;
  oldestPositionFolderId?: string | null;
  /** Record files the reader scrolls past, for the Unread only filter. */
  markReadOnScrollPast?: boolean;
  onFileOpen: (file: FileItem) => void;
  onUpvote: (fileId: string) => Promise<void>;
}) {
  const [metrics, masonryRef] = useMasonryMetrics(maxGridColumns);
  const stacks = useMemo(
    () => stackGalleryFiles(files, duplicateGroups, oldestPositionFolderId),
    [files, duplicateGroups, oldestPositionFolderId]
  );
  const getItemKey = useCallback((index: number) => stacks[index].anchor.id, [stacks]);
  const estimateSize = useCallback(
    (index: number) => {
      const file = stacks[index].anchor;
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
    [stacks, metrics.columnWidth]
  );
  const virtualizer = useWindowVirtualizer({
    count: stacks.length,
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

  const virtualItems = virtualizer.getVirtualItems();
  const candidatesRef = useRef(new Map<string, ReadCandidate>());
  const markedRef = useRef(new Set<string>());
  const totalSize = virtualizer.getTotalSize();

  // "Scrolled past" has to be read off the virtualizer rather than from an
  // IntersectionObserver: a tile is unmounted as soon as it leaves the
  // overscan window, which happens around the same place the observer's line
  // sits, so most of them would go away before ever being reported.
  //
  // Same three-part rule the explore grid uses. A tile has to have been
  // rendered here (a restored scroll offset renders a fresh window, so
  // everything above it was never on screen in this mount), it has to be
  // ROWS_BEHIND rows above the viewport, and the page has to have scrolled
  // since it was rendered (switching the filter changes the list's length and
  // carries tiles over the line while the reader has not moved).
  useEffect(() => {
    if (!markReadOnScrollPast) {
      candidatesRef.current.clear();
      markedRef.current.clear();
      return;
    }
    const scrollY = window.scrollY;
    for (const item of virtualItems) {
      const id = stacks[item.index]?.anchor.id;
      if (!id || markedRef.current.has(id)) continue;
      const existing = candidatesRef.current.get(id);
      candidatesRef.current.set(id, {
        seenAtScrollY: existing?.seenAtScrollY ?? scrollY,
        end: item.end
      });
    }
    const readLine =
      scrollY -
      ROWS_BEHIND * averageRowHeight(totalSize, stacks.length, metrics.columns);
    for (const [id, candidate] of candidatesRef.current) {
      if (candidate.end > readLine) continue;
      if (!readerMovedPast(candidate.seenAtScrollY, scrollY)) continue;
      candidatesRef.current.delete(id);
      markedRef.current.add(id);
      queueRead('file', id);
    }
  }, [
    stacks,
    markReadOnScrollPast,
    metrics.columns,
    totalSize,
    virtualItems
  ]);

  return (
    <div
      className="gallery-masonry is-virtual"
      ref={masonryRef}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualItems.map((item) => {
        const stack = stacks[item.index];
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
              key={stack.anchor.id}
              stack={stack}
              sourceSites={sourceSites}
              voteSystemEnabled={voteSystemEnabled}
              onFileOpen={onFileOpen}
              onUpvote={onUpvote}
            />
          </div>
        );
      })}
    </div>
  );
}

function GalleryCard({
  stack,
  sourceSites,
  voteSystemEnabled,
  onFileOpen,
  onUpvote
}: {
  stack: GalleryStack;
  sourceSites: BooruSite[];
  voteSystemEnabled: boolean;
  onFileOpen: (file: FileItem) => void;
  onUpvote: (fileId: string) => Promise<void>;
}) {
  const file = stack.anchor;
  const [voteBusy, setVoteBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!file.nextVoteAt) return;
    setNow(Date.now());
    const remaining = Date.parse(file.nextVoteAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [file.nextVoteAt]);
  const cooldownText = formatVoteCooldown(file.nextVoteAt, now);
  const sourceIcons = gallerySourceIcons(stack.members, sourceSites);
  const voteScore = file.voteScore;
  const hasRelations = file.hasRelations;
  const thumbRatio = tileRatio(
    stack.anchor.thumbUrl && stack.anchor.width && stack.anchor.height
      ? stack.anchor.width / stack.anchor.height
      : null
  );

  return (
    <div
      className={`gallery-thumb${thumbRatio ? ' is-sized' : ''}`}
      style={
        {
          '--gallery-thumb-max': `${THUMB_SIZE}px`,
          ...(thumbRatio ? { '--gallery-thumb-ratio': thumbRatio } : {})
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-left w-full h-full"
        data-test-id="file-card"
        aria-label={`Open ${file.path}${
          file.mediaType === 'VIDEO' ? ' (video)' : ''
        }${
          voteSystemEnabled && voteScore > 0
            ? `, score ${voteScore}`
            : ''
        }${hasRelations ? ', has related posts' : ''}`}
        onClick={() => onFileOpen(file)}
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
          <span className="gallery-chip gallery-chip-bottom left-2">
            {formatDuration(file.durationMs)}
          </span>
        ) : null}
        {hasRelations ? (
          <span
            data-test-id="card-relations"
            className="gallery-chip right-2"
            title="Part of a parent/child post group"
          >
            <Images className="size-3" aria-hidden="true" />
          </span>
        ) : null}
      </button>
      {voteSystemEnabled ? (
        <button
          type="button"
          data-test-id="card-upvote"
          className="gallery-chip gallery-chip-bottom gallery-vote-button right-2"
          disabled={voteBusy || cooldownText !== null}
          aria-label={cooldownText
            ? `Votable again in ${cooldownText}; score ${voteScore}`
            : `Upvote; score ${voteScore}`}
          title={cooldownText ? `Votable again in ${cooldownText}` : 'Upvote'}
          onClick={async () => {
            if (voteBusy || cooldownText) return;
            setVoteBusy(true);
            try {
              await onUpvote(file.id);
            } finally {
              setVoteBusy(false);
            }
          }}
        >
          {cooldownText
            ? <Clock className="size-3" aria-hidden="true" />
            : <ChevronUp className="size-3" aria-hidden="true" />}
          <span>{voteScore}</span>
        </button>
      ) : null}
      <div className="gallery-source-icons" role="group" aria-label={`Sources: ${sourceIcons.map((icon) => icon.label).join(', ')}`}>
        {sourceIcons.map((icon) => <GallerySourceIcon key={icon.key} icon={icon} />)}
      </div>
    </div>
  );
}
