import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Compass,
  EyeOff,
  Heart,
  History,
  Images,
  LoaderCircle,
  Play,
  Rss,
  Settings2,
  WifiOff
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ExploreDetailPanel } from './ExploreDetailPanel';
import { gridImageUrlFor, isGifPost, isVideoUrl, mediaSrc } from './exploreMedia';
import { loadFurAffinityGridPreview } from './explorePostDetails';
import { ExploreReadFooter } from './ExploreReadFooter';
import { isCurrentPeriod, periodLabel } from './popularPeriod';
import { PopularPeriodNote } from './PopularPeriodNote';
import { RemoteImage } from './RemoteImage';
import {
  normalizeSubscriptionSearch,
  subscriptionReasons
} from './subscriptionFeed';
import { explorePostKey, useExploreController } from './useExploreController';


import { LIBRARY_SITE_ID, type ExploreFeed, type ExplorePost, type ExploreSort, type ExploreWindow } from '@/api';
import { SiteLogo } from '@/features/file-detail/SourcesDialog';
import { CardVideo } from '@/features/library/CardVideo';
import { GallerySourceIcon, GallerySourceIconList } from '@/features/library/GallerySourceIcon';
import {
  gallerySourceIconForSite,
  type GallerySourceIcon as GallerySourceIconValue
} from '@/features/library/gallerySourceIcons';
import {
  distributeIntoColumns,
  TALLEST_TILE_RATIO,
  tileRatio
} from '@/features/library/masonry';
import { tagFilters } from '@/features/library/tagInputTokens';
import { TagSearchInput } from '@/features/library/TagSearchInput';
import { useScrolledPastRead } from '@/features/read-marks/useScrolledPastRead';
import { PageTitle } from '@/features/shell/PageTitle';
import {
  PanelChoice,
  PanelSection,
  PanelToggle,
  SearchPanel,
  type ActiveFilter,
  type FilterChip
} from '@/features/shell/SearchPanel';
import { useDeviceProfile } from '@/hooks/device';
import { useExtraSettings, useSubscriptionTags, useUpdateSubscriptionTags } from '@/hooks/settings';
import { explainOfflineFile, useOnline } from '@/lib/online';
import { useErrorToast } from '@/lib/useErrorToast';
import { transitionView } from '@/lib/viewTransitions';
import { useAppMenuStore } from '@/stores/appMenuStore';

const THUMB_SIZE = 220;
const MIN_COLUMNS = 2;

const HOT_HELP =
  "Ranks each site's Hot picks together. Score is compared with other posts from the same site, then older posts lose rank.";

const SORTS: { value: ExploreSort; label: string; help?: string }[] = [
  { value: 'hot', label: 'Hot', help: HOT_HELP },
  { value: 'popular', label: 'Score' },
  { value: 'new', label: 'New' }
];

const WINDOWS: { value: ExploreWindow; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' }
];

/** Same measurement the gallery uses, so both grids break at the same widths. */
function useColumnCount(maxGridColumns: number) {
  const [columnCount, setColumnCount] = useState(MIN_COLUMNS);
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = (width: number) => {
      const available = Math.max(MIN_COLUMNS, Math.floor(width / THUMB_SIZE));
      setColumnCount(maxGridColumns > 0 ? Math.min(available, maxGridColumns) : available);
    };
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      measure(entry.contentRect.width)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxGridColumns]);
  return [columnCount, measureRef] as const;
}

export function ExploreView({
  feed,
  onLibraryChange
}: {
  feed?: ExploreFeed;
  onLibraryChange?: () => void | Promise<void>;
}) {
  const ctl = useExploreController({ feed, onLibraryChange });
  const { maxGridColumns } = useExtraSettings();
  const subscriptionsAvailable = useDeviceProfile().data?.capabilities?.subscriptions !== false;
  const subscriptions = useSubscriptionTags();
  const addSubscription = useUpdateSubscriptionTags();
  useErrorToast(addSubscription.error);
  const navigate = useNavigate();
  const { siteErrors } = ctl;
  const retrySearch = useRef(ctl.retrySearch);
  retrySearch.current = ctl.retrySearch;
  // A site that failed is named rather than silently dropped: an expired API key looks
  // exactly like "no results" otherwise.
  useEffect(() => {
    const ids = siteErrors.map((siteError) => {
      const id = `explore-site-error-${siteError.siteId}`;
      toast.error(`${siteError.siteName}: ${siteError.error}`, {
        id,
        duration: 10_000,
        action: { label: 'Retry search', onClick: () => void retrySearch.current() },
        cancel: {
          label: 'Check accounts',
          onClick: () => void navigate({ to: '/app/settings/accounts' })
        }
      });
      return id;
    });
    return () => ids.forEach((id) => toast.dismiss(id));
  }, [siteErrors, navigate]);
  const currentSearch = normalizeSubscriptionSearch(ctl.tagInput);
  // Subscriptions and History are feeds of their own; a search does not apply to them.
  const isFeed = ctl.sort === 'subscribed' || ctl.sort === 'history';
  const [title, TitleIcon] =
    ctl.sort === 'subscribed'
      ? (['Subscriptions', Rss] as const)
      : ctl.sort === 'history'
        ? (['History', History] as const)
        : (['Explore', Compass] as const);
  // Loaded so far: a booru search has no total to quote.
  const count = `${ctl.posts.length}${ctl.hasMore ? '+' : ''} ${ctl.posts.length === 1 && !ctl.hasMore ? 'post' : 'posts'}`;
  const enabledSites = ctl.searchableSites.filter(
    (site) => !ctl.disabledSiteIds.has(site.id)
  ).length;
  const query = ctl.tagInput.trim();
  const narrowed: ActiveFilter[] = [
    ...(isFeed ? [] : tagFilters(query, ctl.setTagInput)),
    ...(enabledSites < ctl.searchableSites.length
      ? [{
          key: 'sites',
          label: `${enabledSites} of ${ctl.searchableSites.length} sites`,
          clear: ctl.enableAllSites
        }]
      : []),
    ...(ctl.unreadOnly
      ? [{ key: 'unread', label: 'Unread only', clear: ctl.toggleUnreadOnly }]
      : [])
  ];
  const clearFilters = narrowed.length > 0 ? (
    <button
      type="button"
      className="btn btn-outline-light btn-sm mt-2"
      onClick={() => narrowed.forEach((filter) => filter.clear())}
    >
      Clear filters
    </button>
  ) : null;
  const sortLabel = SORTS.find(({ value }) => value === ctl.sort)?.label;
  const filters: FilterChip[] = [
    ...narrowed,
    ...(isFeed
      ? []
      : [{
          key: 'order',
          label: ctl.sort === 'popular'
            ? `Order: ${sortLabel} · ${WINDOWS.find(({ value }) => value === ctl.popularWindow)?.label.toLowerCase()}`
            : `Order: ${sortLabel}`,
          clear: ctl.sort === 'new' ? undefined : () => ctl.setSort('new')
        }])
  ];
  const searchSubscribed = subscriptions.data?.tags.includes(currentSearch) ?? false;
  const [columnCount, masonryRef] = useColumnCount(maxGridColumns);
  // Scrolling History must not move its posts back to the top.
  const readGridRef = useScrolledPastRead(
    'post',
    ctl.readTrackingEnabled && ctl.sort !== 'history' && !ctl.selectedPost,
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

  const stacks = ctl.stacks;
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

  let detail: React.ReactNode = null;
  if (ctl.selectedPost) {
    const post = ctl.selectedPost;
    const key = explorePostKey(post);
    detail = (
      <ExploreDetailPanel
        post={post}
        prevPost={ctl.prevPost}
        nextPost={ctl.nextPost}
        prevPreview={ctl.prevPreview}
        nextPreview={ctl.nextPreview}
        supportsVote={ctl.siteById.get(post.siteId)?.supportsVote ?? false}
        canVote={ctl.siteById.get(post.siteId)?.canVote ?? false}
        canFavorite={ctl.siteById.get(post.siteId)?.canFavorite ?? false}
        favorited={ctl.isFavorited(post)}
        voted={ctl.voteOf(post)}
        voteBusy={ctl.pendingVoteKey === key}
        favoriteBusy={ctl.pendingFavoriteKey === key}
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

  // The grid stays mounted under an open post, so closing it shows the decoded tiles again.
  return (
    <>
      {detail}
      <div hidden={detail !== null}>
        <div className="page-chrome">
          <PageTitle
            icon={<TitleIcon className="page-title-icon" aria-hidden="true" />}
            count={ctl.posts.length > 0 ? count : undefined}
          >
            {title}
          </PageTitle>
          <div className="row g-4">
            <div className="col-12">
              <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
                <div className="card-body">
                  {ctl.sort === 'history' ? null : (
                    <SearchPanel
                      title={
                        isFeed
                          ? 'Filter this feed'
                          : 'Search and filter Explore'
                      }
                      actions={
                        currentSearch && !isFeed || ctl.readTrackingEnabled ? (
                          <div className="panel-pills">
                            {currentSearch && !isFeed ? (
                              <button
                                type="button"
                                className="btn btn-outline-light panel-pill"
                                // PUT replaces the whole list: never send it before the list has loaded.
                                disabled={!subscriptionsAvailable || !subscriptions.isSuccess || searchSubscribed || addSubscription.isPending}
                                title={subscriptionsAvailable ? undefined : 'Subscriptions are not available in this development build.'}
                                onClick={() => addSubscription.mutate([...(subscriptions.data?.tags ?? []), currentSearch])}
                              >
                                <Rss aria-hidden="true" />
                                {searchSubscribed ? 'Subscribed' : 'Subscribe'}
                              </button>
                            ) : null}
                            {ctl.readTrackingEnabled ? (
                              <PanelToggle
                                pressed={ctl.unreadOnly}
                                onToggle={ctl.toggleUnreadOnly}
                                icon={<EyeOff aria-hidden="true" />}
                              >
                                Unread only
                              </PanelToggle>
                            ) : null}
                          </div>
                        ) : null
                      }
                      filters={filters}
                      search={
                        isFeed ? undefined : (
                          <TagSearchInput
                            id="explore-tag-search"
                            scope="vocabulary"
                            value={ctl.tagInput}
                            onChange={ctl.setTagInput}
                            onClear={() => ctl.setTagInput('')}
                            onSubmit={ctl.submitSearch}
                            placeholder="tags · ~either · -not · score:>5"
                          />
                        )
                      }
                    >
                      <PanelSection
                        label="Sites"
                        aside={
                          ctl.searchableSites.length > 0
                            ? `${enabledSites} of ${ctl.searchableSites.length}`
                            : undefined
                        }
                      >
                        {ctl.searchableSites.length === 0 ? (
                          <p className="text-muted-foreground text-sm">
                            No searchable sites yet.{' '}
                            <Link to="/app/settings/accounts">Configure accounts</Link>
                          </p>
                        ) : (
                          <div className="panel-pills">
                            {ctl.searchableSites.map((site) => (
                              <PanelToggle
                                key={site.id}
                                pressed={!ctl.disabledSiteIds.has(site.id)}
                                onToggle={() => ctl.toggleSite(site.id)}
                                icon={<SiteLogo url={site.baseUrl} className="panel-pill-logo" />}
                              >
                                {site.name}
                              </PanelToggle>
                            ))}
                          </div>
                        )}
                      </PanelSection>
                      {isFeed ? null : (
                        <PanelSection label="Order by">
                          <PanelChoice
                            label="Order by"
                            value={ctl.sort}
                            options={SORTS}
                            onChange={ctl.setSort}
                          />
                          {ctl.sort === 'popular' ? (
                            <>
                              <PanelChoice
                                label="Score time window"
                                value={ctl.popularWindow}
                                options={WINDOWS}
                                onChange={ctl.setPopularWindow}
                              />
                              {/* The period being shown, with arrows for bounded windows. */}
                              <div
                                className="btn-group panel-choice explore-period"
                                role="group"
                                aria-label="Score period"
                              >
                                {ctl.popularWindow !== 'all' && (
                                  <button
                                    type="button"
                                    className="btn btn-outline-light"
                                    onClick={() => ctl.stepPeriod(-1)}
                                    aria-label={`Previous ${ctl.popularWindow}`}
                                    title={`Previous ${ctl.popularWindow}`}
                                  >
                                    <ChevronLeft aria-hidden="true" />
                                  </button>
                                )}
                                <span className="btn btn-outline-light explore-period-label">
                                  {periodLabel(ctl.popularWindow, ctl.popularDate)}
                                </span>
                                {ctl.popularWindow !== 'all' && (
                                  <button
                                    type="button"
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
                                    <ChevronRight aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            </>
                          ) : null}
                        </PanelSection>
                      )}
                    </SearchPanel>
                  )}
                  {ctl.sort === 'subscribed' ? (
                    <div className="mb-4">
                      <Link
                        to="/app/settings/subscriptions"
                        className="btn btn-outline-light btn-sm"
                      >
                        <Settings2 className="size-4" aria-hidden="true" />
                        Manage subscriptions
                      </Link>
                    </div>
                  ) : null}

                  {ctl.slowSites.map((site) => (
                    <div
                      key={site.siteId}
                      className="explore-site-error text-sm mb-2 flex flex-wrap items-center gap-2"
                      role="status"
                    >
                      <span className="text-muted-foreground">
                        {site.siteName} is taking a long time to answer.
                      </span>
                      <button
                        type="button"
                        className="btn btn-outline-light btn-sm"
                        data-test-id="explore-skip-site"
                        onClick={site.skip}
                      >
                        Skip {site.siteName}
                      </button>
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
                  ) : ctl.posts.length === 0 &&
                    (ctl.loading || ctl.sitesLoading) ? (
                    <div
                      className="explore-loading text-muted-foreground"
                      role="status"
                    >
                      <LoaderCircle
                        className="size-8 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      Loading images…
                    </div>
                  ) : ctl.posts.length === 0 ? (
                    <p className="explore-empty text-muted-foreground">
                      {ctl.unreadOnly && ctl.readHidden && !ctl.hasMore
                          ? 'You have read everything here.'
                        : ctl.sort === 'history' && !ctl.readTrackingEnabled
                          ? (
                              <>
                                History is off, so nothing is being kept here.{' '}
                                <Link to="/app/settings/extra">Turn on History in Extra</Link>
                              </>
                            )
                        : ctl.sort === 'history'
                          ? 'Posts you scroll past or open in Explore, and files you open in the Gallery, show up here, newest first.'
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
                                  <span className="block">
                                    No new posts match your subscriptions.{' '}
                                    <Link to="/app/settings/subscriptions">
                                      Manage subscriptions
                                    </Link>
                                    .
                                  </span>
                                  {clearFilters}
                                </>
                              )
                        : ctl.searchableSites.length === 0
                          ? <>
                              No sites support this search yet.{' '}
                              <Link to="/app/settings/accounts">Configure booru accounts</Link>
                            </>
                          : (
                              <>
                                <span className="block">No posts match this search.</span>
                                {clearFilters}
                              </>
                            )}
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
                                  sourceIcon={(active) => {
                                    if (active.siteId === LIBRARY_SITE_ID) {
                                      return { key: 'local', label: active.siteName, iconUrl: null };
                                    }
                                    const site = ctl.siteById.get(active.siteId);
                                    return gallerySourceIconForSite(site ?? {
                                      id: active.siteId,
                                      name: active.siteName,
                                      presetKey: active.engine,
                                      baseUrl: active.sourceUrl
                                    });
                                  }}
                                  subscriptionReasons={(active) => ctl.sort === 'subscribed' ? subscriptionReasons(active, ctl.subscribedTags, ctl.subscribedPools) : null}
                                  onOpen={(active) =>
                                    transitionView(
                                      'detail-open',
                                      () => ctl.openPost(active),
                                      `[data-detail-anchor=${JSON.stringify(explorePostKey(active))}] img`
                                    )
                                  }
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
                  {ctl.sort === 'popular' &&
                  ctl.popularWindow !== 'all' &&
                  ctl.tagQuery.trim() &&
                  !ctl.hasMore &&
                  !ctl.loading &&
                  !ctl.sitesLoading ? (
                    <PopularPeriodNote
                      window={ctl.popularWindow}
                      date={ctl.popularDate}
                      onAllTime={() => ctl.setPopularWindow('all')}
                      onNewest={() => ctl.setSort('new')}
                    />
                  ) : null}
                  <ExploreReadFooter
                    posts={ctl.posts}
                    hasMore={ctl.hasMore}
                    readHidden={ctl.readHidden}
                    // Loading more of History must not move its posts back to the top either.
                    readTrackingEnabled={ctl.readTrackingEnabled && ctl.sort !== 'history'}
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
      </div>
    </>
  );
}

export function ExploreCard({
  posts,
  hasRelations,
  supportsVote,
  canFavorite,
  favorited,
  voted,
  voteBusy,
  favoriteBusy,
  sourceIcon,
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
  sourceIcon: (post: ExplorePost) => GallerySourceIconValue;
  subscriptionReasons: (post: ExplorePost) => string[] | null;
  onOpen: (post: ExplorePost) => void;
  onVote: (post: ExplorePost, score: 1 | -1) => void;
  onFavorite: (post: ExplorePost) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [playingVideoKey, setPlayingVideoKey] = useState<string | null>(null);
  const [animatedGifVisible, setAnimatedGifVisible] = useState(true);
  // The height a card far from the viewport keeps once it has released its media.
  const [awayHeight, setAwayHeight] = useState<number | null>(null);
  const cardFaceRef = useRef<HTMLDivElement>(null);
  const inlineVideoRef = useRef<HTMLVideoElement>(null);
  const [needsFullPreviewKey, setNeedsFullPreviewKey] = useState<string | null>(null);
  const [resolvedPreview, setResolvedPreview] = useState<{
    postKey: string;
    fileUrl: string;
  } | null>(null);
  const post = posts[activeIndex % posts.length];
  const online = useOnline();
  const isLibraryFile = post.siteId === LIBRARY_SITE_ID;
  const unavailable = !online && post.libraryLocation !== 'LOCAL';
  const postKey = explorePostKey(post);
  const stacked = posts.length > 1;
  const activeSourceIcon = sourceIcon(post);
  const sourceIcons = Array.from(
    new Map(posts.map((candidate) => {
      const icon = sourceIcon(candidate);
      return [icon.key, icon];
    })).values()
  );
  const sourceNames = sourceIcons.map((icon) => icon.label).join(', ');
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
  const animatedGif = isGifPost(post);
  const gridPost = animatedGif && !animatedGifVisible
    ? { ...post, fileUrl: null }
    : post;
  const gridUrl = !online && post.libraryThumbUrl
    ? post.libraryThumbUrl
    : isLibraryFile && post.previewUrl
      ? post.previewUrl
      : resolvedPreview?.postKey === postKey
        ? resolvedPreview.fileUrl
        : gridImageUrlFor(gridPost, rawRatio !== null && rawRatio < TALLEST_TILE_RATIO);
  // Booru thumbnails are stills even for video, so without this badge a
  // clip is indistinguishable from a picture until it is opened.
  const isVideo = isVideoUrl(post.fileUrl);
  const isPlayingVideo = isVideo && playingVideoKey === postKey;
  useEffect(() => {
    const cardFace = cardFaceRef.current;
    const video = inlineVideoRef.current;
    if (!cardFace || (!isPlayingVideo && !animatedGif)) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // The open menu pushes cards off screen; the reader has not left them.
        if (useAppMenuStore.getState().open) return;
        if (!entry.isIntersecting) video?.pause();
        if (animatedGif) setAnimatedGifVisible(entry.isIntersecting);
      },
      {
        rootMargin: `${cardFace.getBoundingClientRect().height || THUMB_SIZE}px 0px`
      }
    );
    observer.observe(cardFace);
    return () => observer.disconnect();
  }, [animatedGif, isPlayingVideo, postKey]);
  // A decoded sample is megabytes; a long feed keeps hundreds of cards, so cards more than a
  // screen away give their media back and hold their height with an empty box.
  useEffect(() => {
    const cardFace = cardFaceRef.current;
    if (!cardFace) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A grid hidden under an open post has no size; its cards keep their media.
        if (entry.boundingClientRect.height === 0) return;
        if (useAppMenuStore.getState().open) return;
        if (!entry.isIntersecting) setPlayingVideoKey(null);
        setAwayHeight(entry.isIntersecting ? null : entry.boundingClientRect.height);
      },
      { rootMargin: `${window.innerHeight}px 0px` }
    );
    observer.observe(cardFace);
    return () => observer.disconnect();
  }, []);
  // The score and heart; a playing video takes them into its own row.
  const actions = isLibraryFile || !online ? null : (
    <span className="explore-card-actions">
      {canVote ? (
        <button
          type="button"
          className={`gallery-chip gallery-vote-button${currentVote === 1 ? ' is-voted' : ''}`}
          data-test-id="explore-upvote"
          aria-label={`${currentVote === 1 ? 'Undo upvote' : 'Upvote'}; score ${post.score ?? 'unavailable'}`}
          aria-pressed={currentVote === 1}
          disabled={currentVoteBusy}
          onClick={() => onVote(post, 1)}
        >
          <ChevronUp className="size-3" aria-hidden="true" />
          <span>{post.score ?? '—'}</span>
        </button>
      ) : null}
      <button
        type="button"
        className={`explore-action-btn${isFavorited ? ' is-active' : ''}`}
        aria-label={isFavorited ? 'Remove from favorites' : 'Favorite and save'}
        aria-pressed={isFavorited}
        aria-busy={currentFavoriteBusy}
        disabled={!favoriteAllowed}
        title={
          favoriteAllowed
            ? isFavorited
              ? 'Remove from favorites and delete the saved copy'
              : 'Favorite and save to your library now'
            : `Favorites are unavailable for ${post.siteName}. Check supported features and credentials in Settings → Accounts.`
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
  );
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
      className={`gallery-thumb explore-thumb${thumbRatio ? ' is-sized' : ''}${unavailable ? ' is-offline' : ''}`}
      style={
        {
          '--gallery-thumb-max': `${THUMB_SIZE}px`,
          ...(thumbRatio ? { '--gallery-thumb-ratio': thumbRatio } : {})
        } as React.CSSProperties
      }
    >
      <div ref={cardFaceRef} className="explore-card-face">
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-left w-full h-full"
        data-test-id="explore-card"
        data-detail-anchor={explorePostKey(post)}
        data-read-key={explorePostKey(post)}
        aria-label={`${isLibraryFile ? 'Open file' : `Open post ${post.remoteId}`} from ${post.siteName}${
          isVideo ? ' (video)' : ''
        }${subscriptionLabel}${scoreLabel}${
          related ? ', has related posts' : ''
        }${unavailable ? ', cannot open while offline' : ''}`}
        aria-disabled={unavailable || undefined}
        onClick={() => (unavailable ? explainOfflineFile() : onOpen(post))}
      >
        {awayHeight !== null ? (
          <div data-test-id="explore-card-placeholder" style={{ height: awayHeight }} />
        ) : gridUrl && !isPlayingVideo ? (
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
              event.currentTarget.classList.add('is-loaded');
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
        {unavailable ? (
          <span className="gallery-offline-mark" data-test-id="card-offline" title="Not on this device: it opens when you reconnect">
            <WifiOff aria-hidden="true" />
          </span>
        ) : null}
      </button>
      {isPlayingVideo && post.fileUrl ? (
        <>
          <CardVideo
            ref={inlineVideoRef}
            src={mediaSrc(post.fileUrl)}
            testId="explore-inline-video"
            onOpen={() => onOpen(post)}
            trailing={actions}
          />
        </>
      ) : null}
      {isVideo && gridUrl && !isPlayingVideo && online ? (
        <button
          type="button"
          className="explore-video-play"
          data-test-id="explore-video-play"
          aria-label={`Play video ${post.remoteId} from ${post.siteName}`}
          onClick={() => setPlayingVideoKey(postKey)}
        >
          <Play aria-hidden="true" fill="currentColor" className="size-10 p-2" />
        </button>
      ) : null}
      {reasons?.length ? (
        <span className="explore-card-chips right-2">
          <span
            className="gallery-chip max-w-40 truncate"
            data-test-id="explore-subscription-reasons"
            title={`Subscribed for ${reasons.join(', ')}`}
          >
            {reasons.join(', ')}
          </span>
        </span>
      ) : null}
      {related ? (
        <span className="explore-card-bottom-left">
          <span
            className="gallery-chip"
            data-test-id="explore-relations"
            title="Part of a parent/child post group"
          >
            <Images className="size-3" aria-hidden="true" />
          </span>
        </span>
      ) : null}
      {/* The merged grid interleaves sites, so every card keeps its source
          visible. A duplicate stack exposes every available source. */}
      {stacked ? (
        <button
          type="button"
          className="gallery-source-icons explore-source-icons is-stacked"
          aria-label={`Current source ${post.siteName}. Switch to the next duplicate. Sources: ${sourceNames}. ${activeIndex + 1} of ${posts.length}.`}
          title={`Switch source (${activeIndex + 1} of ${posts.length})`}
          onClick={() => setActiveIndex((index) => (index + 1) % posts.length)}
        >
          <GallerySourceIconList
            icons={sourceIcons}
            activeKey={activeSourceIcon.key}
          />
        </button>
      ) : (
        <div
          className="gallery-source-icons explore-source-icons"
          role="group"
          aria-label={`Source: ${sourceNames}`}
        >
          <GallerySourceIcon icon={activeSourceIcon} />
        </div>
      )}
      {isPlayingVideo ? null : actions}
      </div>
    </div>
  );
}
