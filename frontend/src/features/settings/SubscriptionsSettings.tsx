import { Link, useNavigate } from '@tanstack/react-router';
import { BookImage, Search, UserRound, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { PoolSubscription } from '@/api';
import { FoldedBox } from '@/components/FoldedBox';
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

function Subscriptions() {
  const subscriptions = useSubscriptions();
  const updateTags = useUpdateSubscriptionTags();
  useErrorToast(updateTags.error);
  const setPendingSearch = useExploreUiStore((state) => state.setPendingSearch);
  const navigate = useNavigate();
  const tags = subscriptions.data?.tags ?? [];
  const artists = subscriptions.data?.artists ?? [];
  const artistErrors = subscriptions.data?.artistErrors ?? [];
  const poolQuery = useSubscriptionPools();
  const pools = poolQuery.data?.pools ?? [];
  const followPool = usePoolSubscriptionMutation(true);
  const unfollowPool = usePoolSubscriptionMutation(false);
  const followArtist = useArtistSubscriptionMutation(true);
  const unfollowArtist = useArtistSubscriptionMutation(false);
  const [newArtist, setNewArtist] = useState('');
  const artistError =
    followArtist.error?.message ?? unfollowArtist.error?.message;
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
      <h2 className="h5 mb-1">Subscriptions</h2>
      <p className="text-muted-foreground text-xs mb-3">
        Searches, artists and pools are stored in GoonCave and run on every
        configured booru. Spaces and operators such as score:&gt;10 are kept.
        Artists are also synced both ways with each FurAffinity account’s
        watchlist: following or unfollowing on either side is copied to the
        other.
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

      <form
        className="flex gap-2 mb-3"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await followArtist.mutateAsync(newArtist.trim());
            setNewArtist('');
          } catch {
            // The mutation error is shown under the list, and the typed
            // username stays available for correction.
          }
        }}
      >
        <label className="visually-hidden" htmlFor="subscription-new-artist">
          Artist username
        </label>
        <input
          className="form-control form-control-sm"
          id="subscription-new-artist"
          name="subscription-new-artist"
          type="text"
          autoComplete="off"
          placeholder="Artist username"
          value={newArtist}
          onChange={(event) => setNewArtist(event.target.value)}
        />
        <button
          className="btn btn-primary btn-sm shrink-0"
          type="submit"
          disabled={!newArtist.trim() || followArtist.isPending}
        >
          Follow
        </button>
      </form>

      {tags.length || artists.length || pools.length ? (
        <FoldedBox maxHeight="64rem" className="mb-3">
          <div className="list-group list-group-segmented">
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
                    <Search
                      className="subscription-row-icon"
                      aria-hidden="true"
                    />
                    <span className="subscription-row-text">
                      <span className="subscription-row-title">{search}</span>
                      <span className="subscription-row-meta">All sites</span>
                    </span>
                  </button>
                }
              />
            ))}
            {artists.map((artist) => (
              <SubscriptionRow
                key={`artist:${artist}`}
                removeLabel={`Unfollow ${artist}`}
                removeDisabled={unfollowArtist.isPending}
                onRemove={() => void removeArtist(artist)}
                open={
                  <span className="subscription-row-open">
                    <UserRound
                      className="subscription-row-icon"
                      aria-hidden="true"
                    />
                    <span className="subscription-row-text">
                      <span className="subscription-row-title">{artist}</span>
                      <span className="subscription-row-meta">Artist</span>
                    </span>
                  </span>
                }
              />
            ))}
            {pools.map((pool) => (
              <SubscriptionRow
                key={`${pool.siteId}:${pool.poolId}`}
                removeLabel={`Unsubscribe from ${pool.name}`}
                removeDisabled={unfollowPool.isPending}
                onRemove={() => void removePool(pool)}
                open={
                  <Link
                    className="subscription-row-open"
                    to="/app/pool"
                    search={{ site: pool.siteId, pool: pool.poolId }}
                  >
                    <BookImage
                      className="subscription-row-icon"
                      aria-hidden="true"
                    />
                    <span className="subscription-row-text">
                      <span className="subscription-row-title">
                        {pool.name}
                      </span>
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
                        fallback={
                          <span className="subscription-row-cover rounded" />
                        }
                      />
                    ) : (
                      <span className="subscription-row-cover rounded" />
                    )}
                  </Link>
                }
              />
            ))}
          </div>
        </FoldedBox>
      ) : subscriptions.isLoading ? null : (
        <p className="text-muted-foreground text-sm mb-3">
          Nothing followed yet. Type a search or an artist above, hit Subscribe
          next to a search in Explore, or open a comic or a pool and hit
          Subscribe at the top.
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
