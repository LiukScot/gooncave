import { useEffect, useState } from 'react';

import {
  useArtistSubscriptionMutation,
  useSubscriptions,
  useUpdateSubscriptionTags
} from '@/hooks/settings';

const rows = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function SubscriptionsSettings() {
  const subscriptions = useSubscriptions();
  const updateTags = useUpdateSubscriptionTags();
  const follow = useArtistSubscriptionMutation(true);
  const unfollow = useArtistSubscriptionMutation(false);
  const savedTags = (subscriptions.data?.tags ?? []).join('\n');
  const [draft, setDraft] = useState<string | null>(null);
  const [artistDrafts, setArtistDrafts] = useState<Record<string, string>>({});

  useEffect(() => setDraft(null), [savedTags]);

  const value = draft ?? savedTags;
  const dirty = rows(value).join('\n') !== savedTags;
  const artistMutationError =
    follow.error?.message ?? unfollow.error?.message;

  return (
    <div className="col-12">
      <section className="settings-section">
        <h2 className="h5 mb-1">Tag subscriptions</h2>
        <p className="text-muted-foreground text-xs mb-3">
          Stored only in GoonCave. The Subscribed tab searches your configured
          booru sites for posts matching these tags, newest first.
        </p>
        <label className="block font-medium mb-2" htmlFor="subscription-tags">
          One tag per row
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
            onClick={() => updateTags.mutate(rows(value))}
          >
            {updateTags.isPending ? 'Saving…' : 'Save tags'}
          </button>
          {dirty ? (
            <span className="text-muted-foreground text-xs">Unsaved changes</span>
          ) : null}
        </div>
        {updateTags.error ? (
          <p className="text-destructive text-sm mt-2 mb-0">
            {updateTags.error.message}
          </p>
        ) : null}
      </section>

      <section className="settings-section">
        <h2 className="h5 mb-1">FurAffinity artists</h2>
        <p className="text-muted-foreground text-xs mb-3">
          This is a live mirror of each FurAffinity account’s watchlist.
          Following or unfollowing here immediately changes that remote
          account; artists are not stored as a second local list.
        </p>

        {subscriptions.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading watchlists…</p>
        ) : subscriptions.data?.artistSources.length ? (
          subscriptions.data.artistSources.map((source) => {
            const artistDraft = artistDrafts[source.siteId] ?? '';
            return (
              <div className="list-group mb-3" key={source.siteId}>
                <div className="list-group-item">
                  <div className="font-medium mb-2">{source.siteName}</div>
                  <div className="flex gap-2">
                    <label
                      className="visually-hidden"
                      htmlFor={`follow-${source.siteId}`}
                    >
                      Artist username
                    </label>
                    <input
                      className="form-control form-control-sm"
                      id={`follow-${source.siteId}`}
                      name={`follow-${source.siteId}`}
                      type="text"
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
                      type="button"
                      disabled={!artistDraft.trim() || follow.isPending}
                      onClick={async () => {
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
                      Follow
                    </button>
                  </div>
                  {source.error ? (
                    <p className="text-destructive text-sm mt-2 mb-0">
                      {source.error}
                    </p>
                  ) : source.artists.length ? (
                    <div className="list-group mt-3">
                      {source.artists.map((artist) => (
                        <div
                          className="list-group-item flex items-center gap-2 py-2"
                          key={artist.toLowerCase()}
                        >
                          <span className="grow">{artist}</span>
                          <button
                            className="btn btn-outline-danger btn-sm"
                            type="button"
                            aria-label={`Unfollow ${artist}`}
                            disabled={unfollow.isPending}
                            onClick={() =>
                              unfollow.mutate({ siteId: source.siteId, artist })
                            }
                          >
                            Unfollow
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm mt-2 mb-0">
                      This account is not watching any artists.
                    </p>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-muted-foreground text-sm">
            No enabled FurAffinity account is configured. Add one under
            Settings → Accounts to follow artists.
          </p>
        )}

        {subscriptions.error ? (
          <p className="text-destructive text-sm">
            {subscriptions.error.message}
          </p>
        ) : null}
        {artistMutationError ? (
          <p className="text-destructive text-sm">{artistMutationError}</p>
        ) : null}
      </section>
    </div>
  );
}
