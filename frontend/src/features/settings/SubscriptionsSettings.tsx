import { Link, useNavigate } from '@tanstack/react-router';
import { BookImage, Search, UserRound, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { PoolSubscription } from '@/api';
import { RemoteImage } from '@/features/explore/RemoteImage';
import { normalizeSubscriptionSearch } from '@/features/explore/subscriptionFeed';
import { TagSearchInput } from '@/features/library/TagSearchInput';
import {
  useArtistSubscriptionMutation,
  usePoolSubscriptionMutation,
  useSubscriptionPools,
  useSubscriptions,
  useUpdateSubscriptionTags
} from '@/hooks/settings';
import { useErrorToast } from '@/lib/useErrorToast';
import { useExploreUiStore } from '@/stores/exploreUiStore';

const rows = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/** One followed thing: the part that opens it, then its remove button. */
function SubscriptionRow({
  open,
  removeLabel,
  removeDisabled,
  onRemove
}: {
  open: ReactNode;
  removeLabel: string;
  removeDisabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="list-group-item subscription-row">
      {open}
      <button
        type="button"
        className="btn btn-outline-light btn-sm subscription-row-remove"
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

function SearchSubscriptions() {
  const subscriptions = useSubscriptions();
  const updateTags = useUpdateSubscriptionTags();
  useErrorToast(updateTags.error);
  const setPendingSearch = useExploreUiStore((state) => state.setPendingSearch);
  const navigate = useNavigate();
  const tags = subscriptions.data?.tags ?? [];
  const savedTags = tags.join('\n');
  const [newSearch, setNewSearch] = useState('');
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => setDraft(null), [savedTags]);

  const value = draft ?? savedTags;
  const dirty = rows(value).join('\n') !== savedTags;
  const normalizedNew = normalizeSubscriptionSearch(newSearch);
  const alreadyFollowed = tags.includes(normalizedNew);

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
    if (await save([...tags, normalizedNew])) setNewSearch('');
  };

  const remove = async (search: string) => {
    const before = tags;
    if (!(await save(tags.filter((tag) => tag !== search)))) return;
    toast.success(`Unsubscribed from “${search}”`, {
      action: { label: 'Undo', onClick: () => void save(before) }
    });
  };

  const openSearch = (search: string) => {
    setPendingSearch(search);
    void navigate({ to: '/app/explore', search: { post: undefined } });
  };

  return (
    <section className="settings-section">
      <h2 className="h5 mb-1">Searches</h2>
      <p className="text-muted-foreground text-xs mb-3">
        Stored only in GoonCave and run on every configured booru. Spaces and
        operators such as score:&gt;10 are kept.
      </p>
      <form
        className="flex gap-2 mb-3"
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
          disabled={!normalizedNew || alreadyFollowed || updateTags.isPending}
        >
          {alreadyFollowed ? 'Subscribed' : 'Subscribe'}
        </button>
      </form>

      {tags.length ? (
        <div className="list-group list-group-segmented mb-3">
          {tags.map((search) => (
            <SubscriptionRow
              key={search}
              removeLabel={`Unsubscribe from ${search}`}
              removeDisabled={updateTags.isPending}
              onRemove={() => void remove(search)}
              open={
                <button
                  type="button"
                  className="subscription-row-open"
                  onClick={() => openSearch(search)}
                >
                  <Search className="subscription-row-icon" aria-hidden="true" />
                  <span className="subscription-row-text">
                    <span className="subscription-row-title">{search}</span>
                    <span className="subscription-row-meta">All sites</span>
                  </span>
                </button>
              }
            />
          ))}
        </div>
      ) : subscriptions.isLoading ? null : (
        <p className="text-muted-foreground text-sm mb-3">
          No searches yet. Type one above, or hit Subscribe next to a search in
          Explore.
        </p>
      )}

      <details className="subscription-text-editor">
        <summary className="text-sm font-medium">Edit as text</summary>
        <label className="block font-medium mt-3 mb-2" htmlFor="subscription-tags">
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
            <span className="text-muted-foreground text-xs">Unsaved changes</span>
          ) : null}
        </div>
      </details>
    </section>
  );
}

function PoolSubscriptions() {
  const pools = useSubscriptionPools();
  const follow = usePoolSubscriptionMutation(true);
  const unfollow = usePoolSubscriptionMutation(false);
  const list = pools.data?.pools ?? [];

  const remove = async (pool: PoolSubscription) => {
    const target = { siteId: pool.siteId, poolId: pool.poolId };
    try {
      await unfollow.mutateAsync(target);
    } catch (error) {
      toast.error((error as Error).message);
      return;
    }
    toast.success(`Unsubscribed from ${pool.name}`, {
      action: {
        label: 'Undo',
        onClick: () =>
          follow
            .mutateAsync(target)
            .catch((error: Error) => toast.error(error.message))
      }
    });
  };

  return (
    <section className="settings-section">
      <h2 className="h5 mb-1">Pools</h2>
      <p className="text-muted-foreground text-xs mb-3">
        New pages added to a pool show up in Subscriptions.
      </p>
      {list.length ? (
        <div className="list-group list-group-segmented">
          {list.map((pool) => (
            <SubscriptionRow
              key={`${pool.siteId}:${pool.poolId}`}
              removeLabel={`Unsubscribe from ${pool.name}`}
              removeDisabled={unfollow.isPending}
              onRemove={() => void remove(pool)}
              open={
                <Link
                  className="subscription-row-open"
                  to="/app/pool"
                  search={{ site: pool.siteId, pool: pool.poolId }}
                >
                  <BookImage className="subscription-row-icon" aria-hidden="true" />
                  <span className="subscription-row-text">
                    <span className="subscription-row-title">{pool.name}</span>
                    <span className="subscription-row-meta">
                      {pool.siteName} · {pool.postCount}{' '}
                      {pool.postCount === 1 ? 'page' : 'pages'}
                    </span>
                  </span>
                  {pool.coverUrl ? (
                    <RemoteImage
                      src={pool.coverUrl}
                      alt=""
                      className="subscription-row-cover rounded"
                      loading="lazy"
                      decoding="async"
                      // danbooru's CDN answers 403 without a Referer; `origin`
                      // sends the host and never the path.
                      referrerPolicy="origin"
                      fallback={<span className="subscription-row-cover rounded" />}
                    />
                  ) : (
                    <span className="subscription-row-cover rounded" />
                  )}
                </Link>
              }
            />
          ))}
        </div>
      ) : pools.isLoading ? null : (
        <p className="text-muted-foreground text-sm mb-0">
          No pools yet. Open a comic or a pool and hit Subscribe at the top.
        </p>
      )}
      {pools.error ? (
        <p className="text-destructive text-sm mt-2 mb-0">{pools.error.message}</p>
      ) : null}
    </section>
  );
}

function ArtistSubscriptions() {
  const subscriptions = useSubscriptions();
  const follow = useArtistSubscriptionMutation(true);
  const unfollow = useArtistSubscriptionMutation(false);
  const [artistDrafts, setArtistDrafts] = useState<Record<string, string>>({});
  const artistMutationError = follow.error?.message ?? unfollow.error?.message;

  return (
    <section className="settings-section">
      <h2 className="h5 mb-1">FurAffinity artists</h2>
      <p className="text-muted-foreground text-xs mb-3">
        This is a live mirror of each FurAffinity account’s watchlist.
        Following or unfollowing here immediately changes that remote account;
        artists are not stored as a second local list.
      </p>

      {subscriptions.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading watchlists…</p>
      ) : subscriptions.data?.artistSources.length ? (
        subscriptions.data.artistSources.map((source) => {
          const artistDraft = artistDrafts[source.siteId] ?? '';
          return (
            <div className="mb-3" key={source.siteId}>
              <div className="font-medium mb-2">{source.siteName}</div>
              <form
                className="flex gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    await follow.mutateAsync({
                      siteId: source.siteId,
                      artist: artistDraft.trim()
                    });
                    setArtistDrafts((current) => ({
                      ...current,
                      [source.siteId]: ''
                    }));
                  } catch {
                    // The mutation error stays beside the form, and the
                    // typed username remains available for correction.
                  }
                }}
              >
                <label className="visually-hidden" htmlFor={`follow-${source.siteId}`}>
                  Artist username
                </label>
                <input
                  className="form-control form-control-sm"
                  id={`follow-${source.siteId}`}
                  name={`follow-${source.siteId}`}
                  type="text"
                  autoComplete="off"
                  placeholder="Artist username"
                  value={artistDraft}
                  onChange={(event) =>
                    setArtistDrafts((current) => ({
                      ...current,
                      [source.siteId]: event.target.value
                    }))
                  }
                />
                <button
                  className="btn btn-primary btn-sm shrink-0"
                  type="submit"
                  disabled={!artistDraft.trim() || follow.isPending}
                >
                  Follow
                </button>
              </form>
              {source.error ? (
                <p className="text-destructive text-sm mt-2 mb-0">{source.error}</p>
              ) : source.artists.length ? (
                <div className="list-group list-group-segmented mt-3">
                  {source.artists.map((artist) => (
                    <SubscriptionRow
                      key={artist.toLowerCase()}
                      removeLabel={`Unfollow ${artist}`}
                      removeDisabled={unfollow.isPending}
                      onRemove={() =>
                        unfollow.mutate({ siteId: source.siteId, artist })
                      }
                      open={
                        <span className="subscription-row-open">
                          <UserRound
                            className="subscription-row-icon"
                            aria-hidden="true"
                          />
                          <span className="subscription-row-text">
                            <span className="subscription-row-title">{artist}</span>
                          </span>
                        </span>
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm mt-2 mb-0">
                  This account is not watching any artists.
                </p>
              )}
            </div>
          );
        })
      ) : (
        <p className="text-muted-foreground text-sm">
          No enabled FurAffinity account is configured. Add one under Settings →
          Accounts to follow artists.
        </p>
      )}

      {subscriptions.error ? (
        <p className="text-destructive text-sm">{subscriptions.error.message}</p>
      ) : null}
      {artistMutationError ? (
        <p className="text-destructive text-sm">{artistMutationError}</p>
      ) : null}
    </section>
  );
}

export function SubscriptionsSettings() {
  return (
    <div className="col-12">
      <SearchSubscriptions />
      <PoolSubscriptions />
      <ArtistSubscriptions />
    </div>
  );
}
