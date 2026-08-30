import { useEffect, useState } from 'react';

import { parseBlacklistInput } from './blacklist';

import {
  useBlacklistSettings,
  useUpdateBlacklistSettings
} from '@/hooks/settings';

type BlacklistTarget = 'applyToExplore' | 'applyToGallery';

const TARGETS: {
  key: BlacklistTarget;
  label: string;
  description: string;
}[] = [
  {
    key: 'applyToExplore',
    label: 'Explore',
    description: 'Hide booru results carrying a blacklisted tag.'
  },
  {
    key: 'applyToGallery',
    label: 'Gallery',
    description: 'Hide your own files carrying a blacklisted tag.'
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
  const error = (update.error as Error | null)?.message ?? null;

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

      <div className="list-group">
        {TARGETS.map(({ key, label, description }) => (
          <div key={key} className="list-group-item flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <label className="block font-medium" htmlFor={`blacklist-${key}`}>
                {label}
              </label>
              <span className="block text-muted-foreground text-xs">
                {description}
              </span>
            </span>
            <input
              className="form-check-input shrink-0"
              type="checkbox"
              id={`blacklist-${key}`}
              name={`blacklist-${key}`}
              checked={settings[key]}
              onChange={() => toggle(key)}
            />
          </div>
        ))}
      </div>

      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
    </div>
  );
}
