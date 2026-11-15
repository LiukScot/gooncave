import { useEffect, useState } from 'react';

import { parseBlacklistInput } from './blacklist';
import { TagDatabaseStatus } from './TagDatabaseStatus';

import { PanelMultiChoice } from '@/features/shell/SearchPanel';
import {
  useBlacklistSettings,
  useUpdateBlacklistSettings
} from '@/hooks/settings';

type BlacklistTarget = 'applyToExplore' | 'applyToSubscriptions' | 'applyToGallery';

const TARGETS: {
  key: BlacklistTarget;
  label: string;
}[] = [
  {
    key: 'applyToExplore',
    label: 'Explore'
  },
  {
    key: 'applyToSubscriptions',
    label: 'Subscriptions'
  },
  {
    key: 'applyToGallery',
    label: 'Gallery'
  }
];

export function BlacklistSettings() {
  const settings = useBlacklistSettings();
  const update = useUpdateBlacklistSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = settings.tags.join('\n');

  // Re-seeded only when the stored list itself changes — after a save, or
  // after an edit made elsewhere. A refetch that returns the same list
  // leaves whatever is being typed alone.
  useEffect(() => {
    setDraft(null);
  }, [saved]);

  const value = draft ?? saved;
  const dirty = parseBlacklistInput(value).join('\n') !== saved;
  const error = update.error?.message ?? null;

  const toggle = (key: BlacklistTarget) =>
    update.mutate({ [key]: !settings[key] });

  return (
    <div className="col-12">
      <p className="text-muted-foreground text-xs mb-3">
        One tag per line — spaces and commas split too, so a list copied from
        a booru can be pasted straight in. A tag you search for explicitly
        still shows, so the blacklist never leaves you with no results.
      </p>

      <label className="block font-medium mb-2" htmlFor="blacklist-tags">
        Blacklisted tags
      </label>
      <textarea
        className="form-control mb-2"
        id="blacklist-tags"
        name="blacklist-tags"
        rows={8}
        spellCheck={false}
        value={value}
        onChange={(event) => setDraft(event.target.value)}
      />

      <div className="flex items-center gap-3 mb-4">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={() =>
            update.mutate({ tags: parseBlacklistInput(value) })
          }
          disabled={update.isPending || !dirty}
        >
          {update.isPending ? 'Saving…' : 'Save list'}
        </button>
        {dirty ? (
          <span className="text-muted-foreground text-xs">Unsaved changes</span>
        ) : null}
      </div>

      <section className="appearance-group">
        <h2 className="appearance-group-title">
          Activate blacklist on
        </h2>
        <PanelMultiChoice
          label="Activate blacklist on"
          options={TARGETS.map(({ key, label }) => ({
            label,
            pressed: settings[key],
            onToggle: () => toggle(key)
          }))}
        />
      </section>

      <TagDatabaseStatus />

      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
    </div>
  );
}
