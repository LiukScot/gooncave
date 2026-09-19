import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Heart,
  Images,
  Play,
  RefreshCw
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ExploreDetailPanel } from './ExploreDetailPanel';
import { gridImageUrlFor, isVideoUrl } from './exploreMedia';
import { loadFurAffinityGridPreview } from './explorePostDetails';
import { ExploreReadFooter } from './ExploreReadFooter';
import { isCurrentPeriod, periodLabel } from './popularPeriod';
import { RemoteImage } from './RemoteImage';
import { stackDuplicates } from './stackDuplicates';
import { subscriptionReasons } from './subscriptionFeed';
import { explorePostKey, useExploreController } from './useExploreController';

import type { ExplorePost, ExploreSort, ExploreWindow } from '@/api';
import { HelpPopover } from '@/components/HelpPopover';
import {
  distributeIntoColumns,
  TALLEST_TILE_RATIO,
  tileRatio
} from '@/features/library/masonry';
import { TagSearchInput } from '@/features/library/TagSearchInput';
import { useScrolledPastRead } from '@/features/read-marks/useScrolledPastRead';

const THUMB_SIZE = 220;
const MIN_COLUMNS = 2;

const SORTS: { key: ExploreSort; label: string }[] = [
  { key: 'hot', label: 'Hot' },
  { key: 'popular', label: 'Score' },
  { key: 'new', label: 'New' },
  { key: 'subscribed', label: 'Subscribed' }
];

const WINDOWS: ExploreWindow[] = ['day', 'week', 'month', 'year', 'all'];

const HOT_HELP =
  "Ranks each site's Hot picks together. Score is compared with other posts from the same site, then older posts lose rank.";

/** Same measurement the gallery uses, so both grids break at the same widths. */
function useColumnCount() {
  const [columnCount, setColumnCount] = useState(MIN_COLUMNS);
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = (width: number) =>
      setColumnCount(Math.max(MIN_COLUMNS, Math.floor(width / THUMB_SIZE)));
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      measure(entry.contentRect.width)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [columnCount, measureRef] as const;
}

export function ExploreView() {
  const ctl = useExploreController();
  const [columnCount, masonryRef] = useColumnCount();
  const readGridRef = useScrolledPastRead(
    'post',
    true,
    ctl.posts.length,
    columnCount
  );

  // Gelbooru-style APIs send a post's parent and never say whether a post
  // *has* children, so a parent looks like a lone post. Siblings are uploaded
  // together and land on the same page, so a post another one on screen calls
  // its parent is one — no request, and never a guess.
  const parentIdsOnScreen = useMemo(
    () =>
      new Set(
        ctl.posts
          .map((post) => post.parentId)
          .filter((id): id is string => Boolean(id))
      ),
    [ctl.posts]
  );

  const stacks = useMemo(
    () => ctl.exploreStackDuplicates
      ? stackDuplicates(ctl.posts)
      : ctl.posts.map((post) => [post]),
    [ctl.exploreStackDuplicates, ctl.posts]
  );
  const stackByFirstKey = useMemo(
    () => new Map(stacks.map((stack) => [explorePostKey(stack[0]), stack])),
    [stacks]
  );

  const masonryColumns = useMemo(
    () =>
      distributeIntoColumns(stacks.map((stack) => stack[0]), columnCount, (post) =>
        post.previewUrl && post.width && post.height
          ? post.width / post.height
          : null
      ),
    [stacks, columnCount]
  );

  if (ctl.selectedPost) {
    const post = ctl.selectedPost;
    const key = explorePostKey(post);
    return (
      <ExploreDetailPanel
        post={post}
        prevPost={ctl.prevPost}
        nextPost={ctl.nextPost}
        supportsVote={ctl.siteById.get(post.siteId)?.supportsVote ?? false}
        canVote={ctl.siteById.get(post.siteId)?.canVote ?? false}
        canFavorite={ctl.siteById.get(post.siteId)?.canFavorite ?? false}
        favorited={ctl.isFavorited(post)}
        voted={ctl.voteOf(post)}
        voteBusy={ctl.pendingVoteKey === key}
        favoriteBusy={ctl.pendingFavoriteKey === key}
        actionError={ctl.actionError}
        backLabel={ctl.backLabel}
        hasPrev={ctl.hasPrev}
        hasNext={ctl.hasNext}
        onGoRelative={ctl.goRelative}
        onClose={ctl.closeDetail}
        onVote={(score) => void ctl.votePost(post, score)}
        onFavorite={() => void ctl.toggleFavorite(post, ctl.isFavorited(post))}
        onSelectTag={(tag) => void ctl.selectTag(tag)}
        onOpenRelated={ctl.openExcursion}
      />
    );
  }

  return (
    <div className="page-chrome">
      <h1 className="uppercase font-semibold file-detail-section-title mb-4">
        Explore
      </h1>
      <div className="row g-4">
        <div
          className="col-12"
          onPointerDownCapture={(event) => {
            if (!ctl.isSiteFilterOpen) return;
            if (ctl.siteFilterRef.current?.contains(event.target as Node))
              return;
            ctl.setIsSiteFilterOpen(false);
          }}
        >
          <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
            <div className="card-body">
              <div className="gallery-controls flex flex-wrap items-center mb-2">
                <div className={`gallery-control-group gallery-control-search flex flex-wrap items-center gap-2${ctl.sort === 'subscribed' ? ' hidden' : ''}`}>
                  <label
                    className="text-muted-foreground text-sm"
                    htmlFor="explore-tag-search"
                  >
                    Search for tags:
                  </label>
                  <TagSearchInput
                    id="explore-tag-search"
                    scope="vocabulary"
                    value={ctl.tagInput}
                    onChange={ctl.setTagInput}
                    onSubmit={ctl.submitSearch}
                    placeholder="tags · ~either · -not"
                  />
                </div>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group explore-control-sort flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    Order by:
                  </span>
                  <div className="btn-group btn-group-sm" role="group">
                    {SORTS.map(({ key, label }) => (
                      key === 'hot' ? (
                        <div className="explore-hot-control" key={key}>
                          <button
                            className={`btn btn-${ctl.sort === key ? 'primary' : 'outline-light'}`}
                            onClick={() => ctl.setSort(key)}
                          >
                            {label}
                          </button>
                          <HelpPopover text={HOT_HELP} />
                        </div>
                      ) : (
                        <button
                          key={key}
                          className={`btn btn-${ctl.sort === key ? 'primary' : 'outline-light'}`}
                          onClick={() => ctl.setSort(key)}
                        >
                          {label}
                        </button>
                      )
                    ))}
                  </div>
                  {ctl.sort === 'popular' ? (
                    <>
                      <select
                        id="explore-window"
                        name="explore-window"
                        className="form-select form-select-sm bg-background text-foreground border-secondary explore-window-select"
                        value={ctl.popularWindow}
                        onChange={(event) =>
                          ctl.setPopularWindow(
                            event.target.value as ExploreWindow
                          )
                        }
                        aria-label="Score time window"
                      >
                        {WINDOWS.map((window) => (
                          <option key={window} value={window}>
                            {window === 'all' ? 'All time' : window}
                          </option>
                        ))}
                      </select>
                      {/* The period being shown, with arrows for bounded windows. */}
                      <div
                        className="btn-group btn-group-sm explore-period"
                        role="group"
                        aria-label="Score period"
                      >
                        {ctl.popularWindow !== 'all' && (
                          <button
                            className="btn btn-outline-light"
                            onClick={() => ctl.stepPeriod(-1)}
                            aria-label={`Previous ${ctl.popularWindow}`}
                            title={`Previous ${ctl.popularWindow}`}
                          >
                            ‹
                          </button>
                        )}
                        <span className="btn btn-outline-light explore-period-label">
                          {periodLabel(ctl.popularWindow, ctl.popularDate)}
                        </span>
                        {ctl.popularWindow !== 'all' && (
                          <button
                            className="btn btn-outline-light"
                            onClick={() => ctl.stepPeriod(1)}
                            // There is nothing to show past the current period,
                            // and a booru would answer an empty page for it.
                            disabled={isCurrentPeriod(
                              ctl.popularWindow,
                              ctl.popularDate
                            )}
                            aria-label={`Next ${ctl.popularWindow}`}
                            title={`Next ${ctl.popularWindow}`}
                          >
                            ›
                          </button>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">Sites:</span>
                  <div className="dropdown" ref={ctl.siteFilterRef}>
                    <button
                      className="btn btn-outline-light btn-sm dropdown-toggle"
                      type="button"
                      aria-expanded={ctl.isSiteFilterOpen}
                      onClick={() =>
                        ctl.setIsSiteFilterOpen(!ctl.isSiteFilterOpen)
                      }
                    >
                      {
                        ctl.searchableSites.filter(
                          (site) => !ctl.disabledSiteIds.has(site.id)
                        ).length
                      }{' '}
                      of{' '}
                      {ctl.searchableSites.length}
                    </button>
                    {ctl.isSiteFilterOpen ? (
                      <button
                        type="button"
                        className="dropdown-backdrop"
                        aria-label="Close site filter"
                        onClick={() => ctl.setIsSiteFilterOpen(false)}
                      />
                    ) : null}
                    <div
                      className={`dropdown-menu dropdown-menu-dark p-4${ctl.isSiteFilterOpen ? ' show' : ''}`}
                    >
                      {ctl.searchableSites.length === 0 ? (
                        <div className="text-muted-foreground text-sm">
                          No searchable sites yet. Add one under Settings →
                          Favorites accounts.
                        </div>
                      ) : (
                        ctl.searchableSites.map((site) => (
                          <div className="form-check mb-2" key={site.id}>
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id={`explore-site-${site.id}`}
                              name={`explore-site-${site.id}`}
                              checked={!ctl.disabledSiteIds.has(site.id)}
                              onChange={() => ctl.toggleSite(site.id)}
                            />
                            <label
                              className="form-check-label"
                              htmlFor={`explore-site-${site.id}`}
                            >
                              {site.name}
                            </label>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group flex items-center gap-2">
                  <button
                    type="button"
                    className={`btn btn-sm btn-${ctl.unreadOnly ? 'primary' : 'outline-light'} flex items-center gap-2`}
                    aria-pressed={ctl.unreadOnly}
                    onClick={ctl.toggleUnreadOnly}
                  >
                    {ctl.unreadOnly ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                    Unread only
                  </button>
                </div>
              </div>

              <hr className="border-secondary my-4" />

              {ctl.actionError ? (
                <div className="text-destructive text-sm mb-2">
                  {ctl.actionError}
                </div>
              ) : null}
              {/* A site that failed is named rather than silently dropped: an
              expired API key looks exactly like "no results" otherwise. */}
              {ctl.siteErrors.map((siteError) => (
                <div
                  key={siteError.siteId}
                  className="explore-site-error text-sm mb-2"
                  role="status"
                >
                  <span className="text-muted-foreground">
                    {siteError.siteName}:
                  </span>{' '}
                  <span className="text-destructive">{siteError.error}</span>
                </div>
              ))}
              {ctl.posts.length === 0 &&
              ctl.readHidden &&
              !ctl.loading &&
              !ctl.sitesLoading ? (
                <p className="text-muted-foreground py-5 text-center">
                  {ctl.hasMore
                    ? 'Everything loaded so far was already read.'
                    : 'You have read everything this search has.'}
                </p>
              ) : ctl.posts.length === 0 ? (
                <p className="text-muted-foreground">
                  {ctl.loading || ctl.sitesLoading
                    ? 'Loading posts…'
                    : ctl.unreadOnly && ctl.readHidden && !ctl.hasMore
                      ? 'You have read everything here.'
                    : ctl.sort === 'subscribed' && !ctl.hasSubscriptions
                      ? (
                          <>
                            Subscriptions collect new posts for tags you follow
                            and from artists watched on FurAffinity.{' '}
                            <Link to="/app/settings/subscriptions">
                              Configure subscriptions
                            </Link>
                            .
                          </>
                        )
                      : ctl.sort === 'subscribed'
                        ? (
                            <>
                              No new posts match your subscriptions.{' '}
                              <Link to="/app/settings/subscriptions">
                                Manage subscriptions
                              </Link>
                              .
                            </>
                          )
                    : ctl.searchableSites.length === 0
                      ? 'No searchable booru sites configured yet.'
                      : 'No posts match this search.'}
                </p>
              ) : (
                <>
                  <div
                    className="gallery-masonry"
                    ref={(element) => {
                      readGridRef.current = element;
                      const detach = masonryRef(element);
                      // React 19 calls the cleanup instead of re-invoking with
                      // null, so the node has to be dropped here or the ref keeps
                      // a detached grid alive.
                      return () => {
                        readGridRef.current = null;
                        detach?.();
                      };
                    }}
                  >
                    {masonryColumns.map((column, index) => (
                      <div key={index} className="gallery-masonry-column">
                        {column.map((post) => {
                          const key = explorePostKey(post);
                          return (
                            <ExploreCard
                              key={key}
                              posts={stackByFirstKey.get(key) ?? [post]}
                              hasRelations={(active) => Boolean(active.parentId) || active.hasChildren || parentIdsOnScreen.has(active.remoteId)}
                              supportsVote={(active) => ctl.siteById.get(active.siteId)?.canVote ?? false}
                              canFavorite={(active) => ctl.siteById.get(active.siteId)?.canFavorite ?? false}
                              favorited={ctl.isFavorited}
                              voted={ctl.voteOf}
                              voteBusy={(active) => ctl.pendingVoteKey === explorePostKey(active)}
                              favoriteBusy={(active) => ctl.pendingFavoriteKey === explorePostKey(active)}
                              subscriptionReasons={(active) => ctl.sort === 'subscribed' ? subscriptionReasons(active, ctl.subscribedTags) : null}
                              onOpen={(active) => ctl.openPost(active)}
                              onVote={(active, score) => void ctl.votePost(active, score)}
                              onFavorite={(active) =>
                                void ctl.toggleFavorite(
                                  active,
                                  ctl.isFavorited(active)
                                )
                              }
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
              <ExploreReadFooter
                posts={ctl.posts}
                hasMore={ctl.hasMore}
                readHidden={ctl.readHidden}
                unreadOnly={ctl.unreadOnly}
                loading={ctl.loading}
                onLoadMore={ctl.loadMore}
                onMarkLoadedRead={ctl.markLoadedRead}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExploreCard({
  posts,
  hasRelations,
  supportsVote,
  canFavorite,
  favorited,
  voted,
  voteBusy,
  favoriteBusy,
  subscriptionReasons,
  onOpen,
  onVote,
  onFavorite
}: {
  posts: ExplorePost[];
  /** Part of a parent/child group; the detail view lists the rest of it. */
  hasRelations: (post: ExplorePost) => boolean;
  supportsVote: (post: ExplorePost) => boolean;
  canFavorite: (post: ExplorePost) => boolean;
  favorited: (post: ExplorePost) => boolean;
  voted: (post: ExplorePost) => 1 | -1 | null;
  voteBusy: (post: ExplorePost) => boolean;
  favoriteBusy: (post: ExplorePost) => boolean;
  subscriptionReasons: (post: ExplorePost) => string[] | null;
  onOpen: (post: ExplorePost) => void;
  onVote: (post: ExplorePost, score: 1 | -1) => void;
  onFavorite: (post: ExplorePost) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSwitching, setIsSwitching] = useState(false);
  const [needsFullPreviewKey, setNeedsFullPreviewKey] = useState<string | null>(null);
  const [resolvedPreview, setResolvedPreview] = useState<{
    postKey: string;
    fileUrl: string;
  } | null>(null);
  const post = posts[activeIndex % posts.length];
  const postKey = explorePostKey(post);
  const stacked = posts.length > 1;
  useEffect(() => {
    if (post.engine !== 'furaffinity' || post.fileUrl || needsFullPreviewKey !== postKey) return;
    const controller = new AbortController();
    let current = true;
    loadFurAffinityGridPreview({ siteId: post.siteId, remoteId: post.remoteId }, controller.signal)
      .then((fileUrl) => {
        if (current && fileUrl) setResolvedPreview({ postKey, fileUrl });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[explore] FurAffinity preview resolution failed for ${post.remoteId}: ${message}`);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [needsFullPreviewKey, post.engine, post.fileUrl, post.siteId, post.remoteId, postKey]);
  const related = hasRelations(post);
  const canVote = supportsVote(post);
  const favoriteAllowed = canFavorite(post);
  const isFavorited = favorited(post);
  const currentVote = voted(post);
  const currentVoteBusy = voteBusy(post);
  const currentFavoriteBusy = favoriteBusy(post);
  const reasons = subscriptionReasons(post);
  const firstPost = posts[0];
  const rawRatio =
    firstPost.previewUrl && firstPost.width && firstPost.height
      ? firstPost.width / firstPost.height
      : null;
  const thumbRatio = tileRatio(rawRatio);
  const gridUrl = resolvedPreview?.postKey === postKey
    ? resolvedPreview.fileUrl
    : gridImageUrlFor(post, rawRatio !== null && rawRatio < TALLEST_TILE_RATIO);
  // Booru thumbnails are stills even for video, so without this badge a
  // clip is indistinguishable from a picture until it is opened.
  const isVideo = isVideoUrl(post.fileUrl);
  const noPreview = (
    <div
      className="rounded flex items-center justify-center bg-background h-full"
      style={{ minHeight: THUMB_SIZE }}
    >
      <span className="text-muted-foreground text-sm">no preview</span>
    </div>
  );
  const subscriptionLabel = reasons?.length
    ? `, subscribed for ${reasons.join(', ')}`
    : '';
  const scoreLabel =
    reasons === null && post.score !== null
      ? `, score ${post.score}`
      : '';

  return (
    <div
      className={`gallery-thumb explore-thumb${thumbRatio ? ' is-sized' : ''}`}
      style={
        {
          '--gallery-thumb-max': `${THUMB_SIZE}px`,
          ...(thumbRatio ? { '--gallery-thumb-ratio': thumbRatio } : {})
        } as React.CSSProperties
      }
    >
      <div className="explore-card-face">
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-left w-full h-full"
        data-test-id="explore-card"
        data-detail-anchor={explorePostKey(post)}
        data-read-key={explorePostKey(post)}
        aria-label={`Open post ${post.remoteId} from ${post.siteName}${
          isVideo ? ' (video)' : ''
        }${subscriptionLabel}${scoreLabel}${
          related ? ', has related posts' : ''
        }`}
        onClick={() => onOpen(post)}
      >
        {gridUrl ? (
          <RemoteImage
            src={gridUrl}
            alt={`Post ${post.remoteId} on ${post.siteName}`}
            width={post.width ?? THUMB_SIZE}
            height={post.height ?? THUMB_SIZE}
            className="gallery-thumb-img rounded"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            // Cloudflare in front of danbooru's CDN answers 403 to a request
            // that carries no Referer at all, so its thumbnails never loaded.
            // `origin` sends the instance host and never the path, which is
            // where the search terms would sit.
            referrerPolicy="origin"
            fallback={noPreview}
            onLoad={(event) => {
              if (post.engine !== 'furaffinity' || resolvedPreview?.postKey === postKey) return;
              const image = event.currentTarget;
              const scale = window.devicePixelRatio || 1;
              const bounds = image.getBoundingClientRect();
              if (
                image.naturalWidth < bounds.width * scale ||
                image.naturalHeight < bounds.height * scale
              ) {
                setNeedsFullPreviewKey(postKey);
              }
            }}
          />
        ) : (
          noPreview
        )}
      </button>
      {isVideo && gridUrl ? (
        <Play
          aria-hidden="true"
          fill="currentColor"
          className="absolute inset-0 m-auto size-10 rounded-full bg-background/70 p-2 text-foreground"
        />
      ) : null}
      {reasons?.length ? (
        <span
          className="gallery-chip right-2 max-w-40 truncate"
          data-test-id="explore-subscription-reasons"
          title={`Subscribed for ${reasons.join(', ')}`}
        >
          {reasons.join(', ')}
        </span>
      ) : reasons === null && post.score !== null ? (
        <span className="gallery-chip right-2" data-test-id="explore-score">
          <ChevronUp className="size-3" aria-hidden="true" />
          {post.score}
        </span>
      ) : null}
      {/* Bottom left, because the vote and favourite buttons own the corner
          the gallery puts this in. */}
      {related ? (
        <span
          className="gallery-chip gallery-chip-bottom left-2"
          data-test-id="explore-relations"
          title="Part of a parent/child post group"
        >
          <Images className="size-3" aria-hidden="true" />
        </span>
      ) : null}
      {/* Which site a post came from is not guessable from the picture, and
          the merged grid interleaves them. */}
      {stacked ? (
        <button
          type="button"
          className="gallery-chip left-2 explore-provider-chip explore-stack-switch"
          aria-label={`Switch from ${post.siteName} to next duplicate (${activeIndex + 1} of ${posts.length})`}
          title={`Switch provider (${activeIndex + 1} of ${posts.length})`}
          aria-disabled={isSwitching}
          onClick={() => {
            if (isSwitching) return;
            setActiveIndex((index) => (index + 1) % posts.length);
            if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
              setIsSwitching(true);
            }
          }}
        >
          <RefreshCw
            className={`size-3${isSwitching ? ' is-spinning' : ''}`}
            aria-hidden="true"
            onAnimationEnd={() => setIsSwitching(false)}
          />
          {post.siteName}
        </button>
      ) : (
        <span className="gallery-chip left-2 explore-provider-chip">{post.siteName}</span>
      )}
      <span className="explore-card-actions">
        {canVote ? (
          <>
            <button
              type="button"
              className={`explore-action-btn${currentVote === 1 ? ' is-up' : ''}`}
              aria-label="Vote up"
              aria-pressed={currentVote === 1}
              disabled={currentVoteBusy}
              onClick={() => onVote(post, 1)}
            >
              <ChevronUp className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`explore-action-btn${currentVote === -1 ? ' is-down' : ''}`}
              aria-label="Vote down"
              aria-pressed={currentVote === -1}
              disabled={currentVoteBusy}
              onClick={() => onVote(post, -1)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`explore-action-btn${isFavorited ? ' is-active' : ''}`}
          aria-label={isFavorited ? 'Remove from favorites' : 'Favorite and save'}
          aria-pressed={isFavorited}
          disabled={currentFavoriteBusy || !favoriteAllowed}
          title={
            favoriteAllowed
              ? isFavorited
                ? 'Remove from favorites and delete the saved copy'
                : 'Favorite and save to your library now'
              : `${post.siteName} cannot take favorites from this account`
          }
          onClick={() => onFavorite(post)}
        >
          <Heart
            className="size-4"
            aria-hidden="true"
            fill={isFavorited ? 'currentColor' : 'none'}
          />
        </button>
      </span>
      </div>
    </div>
  );
}
