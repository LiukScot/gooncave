import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { MarkdownText } from './MarkdownText';

import { api, type ExplorePost, type FileSourceText } from '@/api';
import { FoldedBox } from '@/components/FoldedBox';
import { GallerySourceIcon } from '@/features/library/GallerySourceIcon';
import { gallerySourceIconForUrl } from '@/features/library/gallerySourceIcons';
import { useOnline } from '@/lib/online';
import { queryKeys } from '@/lib/query-keys';

// Asking again on every open would only repeat a request to a site that
// rate-limits, so the app keeps the text for an hour.
const KEEP_MS = 60 * 60 * 1000;

const NO_SOURCES: FileSourceText[] = [];

type SourceTextState = {
  /** The site gave no text, so it may exist but cannot be shown. */
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
};

type SourceTextProps = SourceTextState & { sources: FileSourceText[] };

const sourceTextState = (query: {
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}): SourceTextState => ({
  failed: query.isError,
  retrying: query.isFetching,
  onRetry: () => void query.refetch()
});

/**
 * What the uploader wrote on the posts a local file was saved from. Empty
 * for a file with no such source, or whose booru has no such text — and
 * while the answer is still on its way.
 */
export const useFileSourceText = (fileId: string): SourceTextProps => {
  const query = useQuery({
    queryKey: queryKeys.files.sourceText(fileId),
    queryFn: () => api.getFileSourceText(fileId),
    staleTime: KEEP_MS,
    gcTime: KEEP_MS
  });
  return {
    ...sourceTextState(query),
    sources: query.data?.sources ?? NO_SOURCES
  };
};

/** The same, for a post in explore: one source, the post itself. */
export const useExplorePostText = (
  post: Pick<ExplorePost, 'siteId' | 'remoteId' | 'siteName' | 'sourceUrl' | 'title' | 'description'>
): SourceTextProps => {
  const known = post.description !== undefined;
  const query = useQuery({
    queryKey: queryKeys.explorePostText(post.siteId, post.remoteId),
    queryFn: () => api.explorePostText(post.siteId, post.remoteId),
    enabled: !known,
    staleTime: KEEP_MS,
    gcTime: KEEP_MS
  });
  const data = known
    ? { title: post.title ?? null, description: post.description ?? null }
    : query.data;
  const state = sourceTextState(query);
  if (!data?.title && !data?.description) {
    return { ...state, sources: NO_SOURCES };
  }
  return {
    ...state,
    sources: [
      {
        siteName: post.siteName,
        sourceUrl: post.sourceUrl,
        title: data.title,
        description: data.description
      }
    ]
  };
};

function SourceText({ source }: { source: FileSourceText }) {
  const description = source.description ?? '';

  return (
    <div data-test-id="source-text">
      {source.title ? (
        <div className="font-semibold file-detail-label">{source.title}</div>
      ) : null}
      {description ? (
        <FoldedBox maxHeight="16rem" className={source.title ? 'mt-2' : undefined}>
          <div className="file-detail-source-text text-muted-foreground text-sm">
            <MarkdownText text={description} />
          </div>
        </FoldedBox>
      ) : null}
    </div>
  );
}

/** One icon per source post to switch between them; nothing with a single source. */
export function SourcePicks<Source extends Pick<FileSourceText, 'siteName' | 'sourceUrl'>>({
  sources,
  selected,
  onSelect,
  label: groupLabel
}: {
  sources: Source[];
  selected: Source;
  onSelect: (source: Source) => void;
  label: string;
}) {
  if (sources.length < 2) return null;
  return (
    <div className="file-detail-source-picks" role="group" aria-label={groupLabel}>
      {sources.map((source) => {
        // A file saved from two posts of one site would otherwise
        // show that site twice with nothing to tell them apart.
        const sameSite = sources.filter(
          (other) => other.siteName === source.siteName
        );
        const label =
          sameSite.length > 1
            ? `${source.siteName} (${sameSite.indexOf(source) + 1})`
            : source.siteName;
        const icon = gallerySourceIconForUrl(source.sourceUrl) ?? {
          key: source.sourceUrl,
          label,
          iconUrl: null
        };
        return (
          <button
            key={source.sourceUrl}
            type="button"
            className="file-detail-source-pick"
            aria-label={label}
            aria-pressed={source === selected}
            onClick={() => onSelect(source)}
          >
            <GallerySourceIcon
              icon={{ ...icon, label }}
              active={source === selected}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The title and description of one source post, with a menu to switch to
 * another when the file was saved from several. Without sources it renders
 * nothing, unless the site did not answer: then it says so and offers a retry,
 * or says the text waits for a connection while offline.
 */
export function SourceTextSection({
  sources,
  failed,
  retrying,
  onRetry
}: SourceTextProps) {
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const online = useOnline();
  if (sources.length === 0) {
    if (!failed) return null;
    return (
      <>
        <div className="file-detail-section-divider" />
        <div className="file-detail-section mb-4">
          <div className="file-detail-section-head">
            <div className="uppercase font-semibold file-detail-section-title">
              Description
            </div>
          </div>
          {online ? (
            <>
              <p className="text-muted-foreground text-sm" role="status">
                The uploader&apos;s description could not be read from the site. The
                site may be busy or offline, or your account on it may need a new
                key in Accounts.
              </p>
              <button
                type="button"
                className="btn btn-link btn-sm mt-1"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? 'Loading the description…' : 'Load the description'}
              </button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm" role="status">
              The uploader&apos;s description comes from the site, so it loads
              when you reconnect.
            </p>
          )}
        </div>
      </>
    );
  }
  // Falls back to the first source when the chosen one is not in this
  // file's list, which is what happens on moving to another file.
  const selected =
    sources.find((source) => source.sourceUrl === selectedUrl) ?? sources[0];

  return (
    <>
      <div className="file-detail-section-divider" />
      <div className="file-detail-section mb-4">
        <div className="file-detail-section-head">
          <div className="uppercase font-semibold file-detail-section-title">
            Description
          </div>
        </div>
        <SourcePicks
          sources={sources}
          selected={selected}
          onSelect={(source) => setSelectedUrl(source.sourceUrl)}
          label="Description source"
        />
        <SourceText key={selected.sourceUrl} source={selected} />
      </div>
    </>
  );
}
