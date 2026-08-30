import { ENGINE_LABELS } from './shared';

import type { BooruEngineCapabilities } from '@/api';
import { useBooruEngineCatalog } from '@/hooks/booru-sites';


const CAPABILITY_COLUMNS: {
  key: keyof BooruEngineCapabilities;
  label: string;
  hint: string;
}[] = [
  { key: 'favorites', label: 'Favorites', hint: 'Sync favorites, and add or remove them remotely' },
  { key: 'tags', label: 'Tags', hint: 'Import tags from a post' },
  { key: 'sourceMatch', label: 'Source match', hint: 'Recognise its post URLs from a reverse image search' },
  { key: 'search', label: 'Search', hint: 'Appear in Explore' },
  { key: 'vote', label: 'Vote', hint: 'Upvote or downvote a post' }
];

/**
 * Sources that are documented and decided but not registered yet. A row here
 * disappears on its own once the engine ships, because the catalog then
 * returns it and it is filtered out below.
 */
const PLANNED: {
  type: string;
  label: string;
  capabilities: BooruEngineCapabilities;
}[] = [
  {
    type: 'furaffinity',
    label: 'FurAffinity',
    capabilities: {
      favorites: true,
      tags: true,
      sourceMatch: true,
      search: false,
      vote: false
    }
  }
];

function SupportCell({ available }: { available: boolean }) {
  return (
    <td className="text-center">
      <span
        aria-hidden="true"
        className={available ? 'text-success' : 'text-destructive'}
      >
        {available ? '✓' : '✗'}
      </span>
      <span className="visually-hidden">
        {available ? 'available' : 'not available'}
      </span>
    </td>
  );
}

export function BooruEngineSupportTable({
  className
}: {
  className?: string;
}) {
  const { data, isLoading, error } = useBooruEngineCatalog();

  const rows = [
    ...(data?.engines ?? []).map((engine) => ({
      key: engine.type,
      label: ENGINE_LABELS[engine.type] ?? engine.type,
      capabilities: engine.defaultCapabilities,
      planned: false
    })),
    ...PLANNED.filter(
      (candidate) =>
        !(data?.engines ?? []).some((engine) => engine.type === candidate.type)
    ).map((candidate) => ({
      key: candidate.type,
      label: candidate.label,
      capabilities: candidate.capabilities,
      planned: true
    }))
  ];

  return (
    <section className={className}>
      <h3 className="text-foreground text-sm mb-1">Supported features</h3>
      <p className="text-muted-foreground text-sm mb-2">
        What each source can do.
      </p>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading engines…</div>
      ) : error ? (
        <div className="text-destructive text-sm">
          Could not load the engine list: {(error as Error).message}
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-dark table-borderless mt-2 mb-0 text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="text-left">
                  Source
                </th>
                {CAPABILITY_COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className="text-center">
                    <abbr title={column.hint}>{column.label}</abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    {row.label}
                    {row.planned ? (
                      <span className="text-muted-foreground"> · planned</span>
                    ) : null}
                  </td>
                  {CAPABILITY_COLUMNS.map((column) => (
                    <SupportCell
                      key={column.key}
                      available={row.capabilities[column.key]}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
