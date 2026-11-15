import { Link, useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { BooruSite, PoolSubscription } from '@/api';
import { FoldedBox } from '@/components/FoldedBox';
import { HelpPopover } from '@/components/HelpPopover';
import { RemoteImage } from '@/features/explore/RemoteImage';
import { normalizeSubscriptionSearch } from '@/features/explore/subscriptionFeed';
import { SiteLogo } from '@/features/file-detail/SourcesDialog';
import { TagSearchInput } from '@/features/library/TagSearchInput';
import {
  PanelSection,
  PanelToggle,
  SearchPanel,
  type FilterChip
} from '@/features/shell/SearchPanel';
import { useBooruSites } from '@/hooks/booru-sites';
import {
  useAddSubscriptionTag,
  useArtistSubscriptionMutation,
  usePoolSubscriptionMutation,
  useSubscriptionPools,
  useSubscriptions,
  useUpdateSubscriptionTags
} from '@/hooks/settings';
import { useErrorToast } from '@/lib/useErrorToast';
import { useExploreUiStore } from '@/stores/exploreUiStore';

// About three rows of pills: a longer block of searches or artists folds there.
const PILLS_FOLD = '7rem';
// About one row of pool covers.
const COVERS_FOLD = '17rem';

const HELP =
  "Searches, artists and pools are stored in GoonCave and run on every configured booru. Spaces and operators such as score:>10 are kept. A single name that is an artist is followed as one: it is also synced both ways with each FurAffinity account’s watchlist, so following or unfollowing on either side is copied to the other. Other tags are never followed on FurAffinity.";

const rows = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/** The logo of each site where a followed entry has results. */
function SiteLogos({ sites }: { sites: BooruSite[] }) {
  return (
    <span className="subscription-item-origin">
      {sites.map((site) => (
        <span key={site.id} role="img" aria-label={site.name}>
          <SiteLogo url={site.baseUrl} className="subscription-item-logo" />
        </span>
      ))}
    </span>
  );
}

/** One followed thing: the part that opens it, then its remove button. */
function SubscriptionItem({
  className,
  open,
  removeLabel,
  removeDisabled,
  onRemove
}: {
  className: string;
  open: ReactNode;
  removeLabel: string;
  removeDisabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className={`subscription-item ${className}`}>
      {open}
      <button
        type="button"
        className="subscription-item-remove"
        aria-label={removeLabel}
        title={removeLabel}
        disabled={removeDisabled}
        onClick={onRemove}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Searches, artists or pools: a titled block with how many it shows, folded past `fold`. */
function SubscriptionGroup({
  title,
  count,
  fold,
  className,
  children
}: {
  title: string;
  count: number;
  /** Any CSS length. */
  fold: string;
  className: string;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="appearance-group" aria-label={title}>
      <h3 className="appearance-group-title">
        {title} · {count}
      </h3>
      <FoldedBox maxHeight={fold}>
        <div className={className}>{children}</div>
      </FoldedBox>
    </section>
  );
}

function Subscriptions() {
  const subscriptions = useSubscriptions();
  const updateTags = useUpdateSubscriptionTags();
  useErrorToast(updateTags.error);
  const addTag = useAddSubscriptionTag();
  useErrorToast(addTag.error);
  const setPendingSearch = useExploreUiStore((state) => state.setPendingSearch);
  const navigate = useNavigate();
  const tags = subscriptions.data?.tags ?? [];
  const artists = subscriptions.data?.artists ?? [];
  const siteHits = subscriptions.data?.siteHits ?? {};
  const sites = (useBooruSites().data ?? []).filter((site) => site.enabled);
  const artistErrors = subscriptions.data?.artistErrors ?? [];
  const poolQuery = useSubscriptionPools();
  const pools = poolQuery.data?.pools ?? [];
  const followPool = usePoolSubscriptionMutation(true);
  const unfollowPool = usePoolSubscriptionMutation(false);
  const followArtist = useArtistSubscriptionMutation(true);
  const unfollowArtist = useArtistSubscriptionMutation(false);
  const artistError =
    followArtist.error?.message ?? unfollowArtist.error?.message;
  const [filterText, setFilterText] = useState('');
  const [hiddenSites, setHiddenSites] = useState<Set<string>>(new Set());
  const query = filterText.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(query);
  const sitesOf = (entry: string) =>
    sites.filter((site) => siteHits[entry]?.includes(site.id));
  // An entry without results anywhere stays visible only while no site is hidden.
  const shows = (entry: string) =>
    matches(entry) &&
    (hiddenSites.size === 0 ||
      sitesOf(entry).some((site) => !hiddenSites.has(site.id)));
  const shownTags = tags.filter(shows);
  const shownArtists = artists.filter(shows);
  const shownPools = pools.filter(
    (pool) => matches(pool.name) && !hiddenSites.has(pool.siteId)
  );
  const enabledSites = sites.filter((site) => !hiddenSites.has(site.id)).length;
  const filters: FilterChip[] = [
    ...(query
      ? [
          {
            key: 'text',
            label: `“${filterText.trim()}”`,
            clear: () => setFilterText('')
          }
        ]
      : []),
    ...(hiddenSites.size > 0
      ? [
          {
            key: 'sites',
            label: `${enabledSites} of ${sites.length} sites`,
            clear: () => setHiddenSites(new Set())
          }
        ]
      : [])
  ];
  const savedTags = tags.join('\n');
  const [newSearch, setNewSearch] = useState('');
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => setDraft(null), [savedTags]);

  const value = draft ?? savedTags;
  const dirty = rows(value).join('\n') !== savedTags;
  const normalizedNew = normalizeSubscriptionSearch(newSearch);
  const alreadyFollowed =
    tags.includes(normalizedNew) || artists.includes(normalizedNew);

  const save = async (next: string[]) => {
    try {
      await updateTags.mutateAsync(next);
      return true;
    } catch {
      // The mutation error is shown under the list.
      return false;
    }
  };

  const add = async () => {
    if (!normalizedNew || alreadyFollowed) return;
    try {
      await addTag.mutateAsync({ search: normalizedNew });
      setNewSearch('');
    } catch {
      // The mutation error is shown as a toast, and the typed text stays.
    }
  };

  const remove = async (search: string) => {
    const before = tags;
    if (!(await save(tags.filter((tag) => tag !== search)))) return;
    toast.success(`Unsubscribed from “${search}”`, {
      action: { label: 'Undo', onClick: () => void save(before) }
    });
  };

  const removePool = async (pool: PoolSubscription) => {
    const target = { siteId: pool.siteId, poolId: pool.poolId };
    try {
      await unfollowPool.mutateAsync(target);
    } catch (error) {
      toast.error((error as Error).message);
      return;
    }
    toast.success(`Unsubscribed from ${pool.name}`, {
      action: {
        label: 'Undo',
        onClick: () =>
          followPool
            .mutateAsync(target)
            .catch((error: Error) => toast.error(error.message))
      }
    });
  };

  const removeArtist = async (artist: string) => {
    try {
      await unfollowArtist.mutateAsync(artist);
    } catch {
      // The mutation error is shown under the list.
      return;
    }
    toast.success(`Unfollowed ${artist}`, {
      action: {
        label: 'Undo',
        onClick: () =>
          followArtist
            .mutateAsync(artist)
            .catch((error: Error) => toast.error(error.message))
      }
    });
  };

  const openSearch = (search: string) => {
    setPendingSearch(search);
    void navigate({ to: '/app/explore', search: { post: undefined } });
  };

  return (
    <section className="settings-section">
      <form
        className="flex items-center gap-2 mb-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className="visually-hidden" htmlFor="subscription-new-search">
          New search
        </label>
        <TagSearchInput
          id="subscription-new-search"
          scope="vocabulary"
          placeholder="tags · ~either · -not · score:>5"
          value={newSearch}
          onChange={setNewSearch}
          onClear={() => setNewSearch('')}
          onSubmit={() => void add()}
        />
        <button
          className="btn btn-primary btn-sm shrink-0"
          type="submit"
          disabled={!normalizedNew || alreadyFollowed || addTag.isPending}
        >
          {alreadyFollowed ? 'Subscribed' : 'Subscribe'}
        </button>
        <HelpPopover text={HELP} />
      </form>

      <SearchPanel
        title="Filter subscriptions"
        filters={filters}
        search={
          <input
            className="form-control"
            type="search"
            name="subscription-filter"
            autoComplete="off"
            aria-label="Filter subscriptions by name"
            placeholder="Name"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
          />
        }
      >
        <PanelSection
          label="Sites"
          aside={sites.length > 0 ? `${enabledSites} of ${sites.length}` : undefined}
        >
          <div className="panel-pills">
            {sites.map((site) => (
              <PanelToggle
                key={site.id}
                pressed={!hiddenSites.has(site.id)}
                onToggle={() =>
                  setHiddenSites((current) => {
                    const next = new Set(current);
                    if (!next.delete(site.id)) next.add(site.id);
                    return next;
                  })
                }
                icon={<SiteLogo url={site.baseUrl} className="panel-pill-logo" />}
              >
                {site.name}
              </PanelToggle>
            ))}
          </div>
        </PanelSection>
      </SearchPanel>

      {tags.length || artists.length || pools.length ? (
        shownTags.length || shownArtists.length || shownPools.length ? (
          <>
            <SubscriptionGroup title="Searches" count={shownTags.length} fold={PILLS_FOLD} className="subscription-pills">
              {shownTags.map((search) => (
                <SubscriptionItem
                  key={search}
                  className="subscription-pill"
                  removeLabel={`Unsubscribe from ${search}`}
                  removeDisabled={updateTags.isPending}
                  onRemove={() => void remove(search)}
                  open={
                    <button
                      type="button"
                      className="subscription-item-open"
                      onClick={() => openSearch(search)}
                    >
                      <SiteLogos sites={sitesOf(search)} />
                      <span className="subscription-item-title">{search}</span>
                    </button>
                  }
                />
              ))}
            </SubscriptionGroup>
            <SubscriptionGroup title="Artists" count={shownArtists.length} fold={PILLS_FOLD} className="subscription-pills">
              {shownArtists.map((artist) => (
                <SubscriptionItem
                  key={`artist:${artist}`}
                  className="subscription-pill"
                  removeLabel={`Unfollow ${artist}`}
                  removeDisabled={unfollowArtist.isPending}
                  onRemove={() => void removeArtist(artist)}
                  open={
                    <span className="subscription-item-open">
                      <SiteLogos sites={sitesOf(artist)} />
                      <span className="subscription-item-title">{artist}</span>
                    </span>
                  }
                />
              ))}
            </SubscriptionGroup>
            <SubscriptionGroup title="Pools" count={shownPools.length} fold={COVERS_FOLD} className="subscription-covers">
              {shownPools.map((pool) => (
                <SubscriptionItem
                  key={`${pool.siteId}:${pool.poolId}`}
                  className="subscription-cover-card"
                  removeLabel={`Unsubscribe from ${pool.name}`}
                  removeDisabled={unfollowPool.isPending}
                  onRemove={() => void removePool(pool)}
                  open={
                    <Link
                      className="subscription-item-open"
                      to="/app/pool"
                      search={{ site: pool.siteId, pool: pool.poolId }}
                    >
                      {pool.coverUrl ? (
                        <RemoteImage
                          src={pool.coverUrl}
                          alt=""
                          className="subscription-cover"
                          loading="lazy"
                          decoding="async"
                          // danbooru's CDN answers 403 without a Referer; `origin`
                          // sends the host and never the path.
                          referrerPolicy="origin"
                          fallback={<span className="subscription-cover" />}
                        />
                      ) : (
                        <span className="subscription-cover" />
                      )}
                      <span className="subscription-item-title">{pool.name}</span>
                      <span className="subscription-item-meta">
                        <SiteLogos sites={sites.filter((site) => site.id === pool.siteId)} />{' '}
                        {pool.siteName} · {pool.postCount}{' '}
                        {pool.postCount === 1 ? 'page' : 'pages'}
                      </span>
                    </Link>
                  }
                />
              ))}
            </SubscriptionGroup>
          </>
        ) : (
          <p className="text-muted-foreground text-sm mb-3">
            Nothing followed matches these filters.
          </p>
        )
      ) : subscriptions.isLoading ? null : (
        <p className="text-muted-foreground text-sm mb-3">
          Nothing followed yet. Type a search or an artist name above, hit
          Subscribe next to a search in Explore, or open a comic or a pool and
          hit Subscribe at the top.
        </p>
      )}
      {artistErrors.map((failure) => (
        <p className="text-destructive text-sm mb-3" key={failure.siteId}>
          The watchlist of {failure.siteName} could not be synced:{' '}
          {failure.error} Artists you follow or unfollow here are kept and sent
          to FurAffinity on the next sync. Check the account in{' '}
          <Link to="/app/settings/accounts">Accounts</Link>, then reopen this
          page.
        </p>
      ))}
      {subscriptions.error ? (
        <p className="text-destructive text-sm mb-3">
          {subscriptions.error.message}
        </p>
      ) : null}
      {poolQuery.error ? (
        <p className="text-destructive text-sm mb-3">
          {poolQuery.error.message}
        </p>
      ) : null}
      {artistError ? (
        <p className="text-destructive text-sm mb-3">{artistError}</p>
      ) : null}

      <details className="subscription-text-editor">
        <summary className="text-sm font-medium">Edit as text</summary>
        <label
          className="block font-medium mt-3 mb-2"
          htmlFor="subscription-tags"
        >
          One search per row
        </label>
        <textarea
          className="form-control mb-2"
          id="subscription-tags"
          name="subscription-tags"
          rows={7}
          spellCheck={false}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center gap-3">
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={!dirty || updateTags.isPending}
            onClick={() => void save(rows(value))}
          >
            {updateTags.isPending ? 'Saving…' : 'Save searches'}
          </button>
          {dirty ? (
            <span className="text-muted-foreground text-xs">
              Unsaved changes
            </span>
          ) : null}
        </div>
      </details>
    </section>
  );
}

export function SubscriptionsSettings() {
  return (
    <div className="col-12">
      <Subscriptions />
    </div>
  );
}
