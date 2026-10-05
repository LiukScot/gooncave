import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { MarkdownText } from './MarkdownText';

import { api, type ExplorePost, type FileSourceText } from '@/api';
import { queryKeys } from '@/lib/query-keys';

// Past this a description is folded behind "Show more", so a long one does
// not push the file's own details off the screen.
const FOLD_CHARS = 400;
const FOLD_LINES = 6;

// The server keeps the text for hours; asking again on every open would
// only repeat a request to a site that rate-limits.
const STALE_MS = 60 * 60 * 1000;

const NO_SOURCES: FileSourceText[] = [];

/**
 * What the uploader wrote on the posts a local file was saved from. Empty
 * for a file with no such source, or whose booru has no such text — and
 * while the answer is still on its way.
 */
export const useFileSourceText = (fileId: string): FileSourceText[] => {
  const { data } = useQuery({
    queryKey: queryKeys.files.sourceText(fileId),
    queryFn: () => api.getFileSourceText(fileId),
    staleTime: STALE_MS
  });
  return data?.sources ?? NO_SOURCES;
};

/** The same, for a post in explore: one source, the post itself. */
export const useExplorePostText = (
  post: Pick<ExplorePost, 'siteId' | 'remoteId' | 'siteName' | 'sourceUrl'>
): FileSourceText[] => {
  const { data } = useQuery({
    queryKey: queryKeys.explorePostText(post.siteId, post.remoteId),
    queryFn: () => api.explorePostText(post.siteId, post.remoteId),
    staleTime: STALE_MS
  });
  if (!data?.title && !data?.description) return NO_SOURCES;
  return [
    {
      siteName: post.siteName,
      sourceUrl: post.sourceUrl,
      title: data.title,
      description: data.description
    }
  ];
};

function SourceText({ source }: { source: FileSourceText }) {
  const [expanded, setExpanded] = useState(false);
  const description = source.description ?? '';
  const foldable =
    description.length > FOLD_CHARS ||
    description.split('\n').length > FOLD_LINES;

  return (
    <div data-test-id="source-text">
      {source.title ? (
        <div className="font-semibold file-detail-label">{source.title}</div>
      ) : null}
      {description ? (
        <div
          className={`file-detail-source-text text-muted-foreground text-sm${
            source.title ? ' mt-2' : ''
          }${foldable && !expanded ? ' is-folded' : ''}`}
        >
          <MarkdownText text={description} />
        </div>
      ) : null}
      {foldable ? (
        <button
          type="button"
          className="btn btn-link btn-sm mt-1"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The title and description of one source post, with a menu to switch to
 * another when the file was saved from several. Renders nothing without
 * sources.
 */
export function SourceTextSection({ sources }: { sources: FileSourceText[] }) {
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  if (sources.length === 0) return null;
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
          <div className="file-detail-section-actions">
            <select
              className="form-select form-select-sm bg-background text-foreground border-secondary file-detail-source-select"
              aria-label="Description source"
              value={selected.sourceUrl}
              onChange={(event) => setSelectedUrl(event.target.value)}
            >
              {sources.map((source) => {
                // A file saved from two posts of one site would otherwise
                // list that site twice with nothing to tell them apart.
                const sameSite = sources.filter(
                  (other) => other.siteName === source.siteName
                );
                return (
                  <option key={source.sourceUrl} value={source.sourceUrl}>
                    {sameSite.length > 1
                      ? `${source.siteName} (${sameSite.indexOf(source) + 1})`
                      : source.siteName}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
        <SourceText key={selected.sourceUrl} source={selected} />
      </div>
    </>
  );
}
