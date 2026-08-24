import { useState } from 'react';

import { useConfirm } from '@/components/confirm-dialog';
import { formatDateTime } from '@/features/file-detail/utils';
import {
  useAddTagAlias,
  useRefreshTagDatabase,
  useRemoveTagAlias,
  useTagAliases,
  useTagDatabase
} from '@/hooks/tags';

export function TagDatabaseSettings() {
  const status = useTagDatabase();
  const aliases = useTagAliases();
  const refresh = useRefreshTagDatabase();
  const addAlias = useAddTagAlias();
  const removeAlias = useRemoveTagAlias();
  const confirm = useConfirm();

  const [antecedent, setAntecedent] = useState('');
  const [consequent, setConsequent] = useState('');

  const error =
    (refresh.error as Error | null)?.message ??
    (addAlias.error as Error | null)?.message ??
    (removeAlias.error as Error | null)?.message ??
    (status.error as Error | null)?.message ??
    null;

  const submitAlias = async () => {
    if (!antecedent.trim() || !consequent.trim()) return;
    await addAlias.mutateAsync({ antecedent, consequent });
    setAntecedent('');
    setConsequent('');
  };

  const dropAlias = async (tag: string, target: string) => {
    const confirmed = await confirm('Remove this alias?', {
      title: 'Remove alias',
      confirmLabel: 'Remove',
      destructive: true,
      details: `${tag} → ${target}`
    });
    if (confirmed) await removeAlias.mutateAsync(tag);
  };

  return (
    <div className="col-12">
      {error ? (
        <div className="text-destructive text-sm mb-3">{error}</div>
      ) : null}

      <div className="list-group mb-4">
        <div className="list-group-item flex items-center gap-3">
          <span className="flex-1 min-w-0">
            <span className="block font-medium">Tag database</span>
            <span className="block text-muted-foreground text-xs">
              {status.data
                ? `${status.data.aliases.toLocaleString()} aliases, ${status.data.implications.toLocaleString()} implications` +
                  (status.data.importedAt
                    ? ` · updated ${formatDateTime(status.data.importedAt)}`
                    : ' · never imported')
                : 'Loading…'}
            </span>
            <span className="block text-muted-foreground text-xs">
              Imported from the public e621 export and refreshed weekly.
            </span>
          </span>
          <button
            className="btn btn-outline-light btn-sm"
            type="button"
            onClick={() => void refresh.mutateAsync()}
            disabled={refresh.isPending}
          >
            {refresh.isPending ? 'Updating…' : 'Update now'}
          </button>
        </div>
      </div>

      <div className="mb-2 font-medium">Your aliases</div>
      <p className="text-muted-foreground text-xs mb-3">
        Your own aliases win over the imported ones. Both tags are searched as
        the second one. The tag database is shared by every account on this
        instance, so an alias added here changes what everyone&rsquo;s searches
        match.
      </p>

      <div className="flex flex-wrap gap-2 items-end mb-3">
        <span>
          <label
            className="block text-muted-foreground text-xs mb-1"
            htmlFor="tag-alias-from"
          >
            Tag
          </label>
          <input
            id="tag-alias-from"
            name="tag-alias-from"
            type="text"
            className="form-control form-control-sm bg-background text-foreground border-secondary tag-alias-input"
            placeholder="one_girl"
            value={antecedent}
            onChange={(event) => setAntecedent(event.target.value)}
          />
        </span>
        <span aria-hidden="true" className="pb-2">
          →
        </span>
        <span>
          <label
            className="block text-muted-foreground text-xs mb-1"
            htmlFor="tag-alias-to"
          >
            Searched as
          </label>
          <input
            id="tag-alias-to"
            name="tag-alias-to"
            type="text"
            className="form-control form-control-sm bg-background text-foreground border-secondary tag-alias-input"
            placeholder="female"
            value={consequent}
            onChange={(event) => setConsequent(event.target.value)}
          />
        </span>
        <button
          className="btn btn-outline-light btn-sm"
          type="button"
          onClick={() => void submitAlias()}
          disabled={addAlias.isPending}
        >
          Add
        </button>
      </div>

      {aliases.data && aliases.data.aliases.length > 0 ? (
        <div className="list-group">
          {aliases.data.aliases.map((alias) => (
            <div
              key={alias.antecedent}
              className="list-group-item flex items-center gap-3"
            >
              <span className="flex-1 min-w-0">
                {alias.antecedent} → {alias.consequent}
              </span>
              <button
                className="btn btn-outline-danger btn-sm"
                type="button"
                onClick={() =>
                  void dropAlias(alias.antecedent, alias.consequent)
                }
                aria-label={`Remove alias ${alias.antecedent}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground text-sm">
          No aliases of your own yet.
        </div>
      )}
    </div>
  );
}
