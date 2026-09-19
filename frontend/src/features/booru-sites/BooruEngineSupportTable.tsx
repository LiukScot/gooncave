import { ENGINE_LABELS } from './shared';

import type { BooruEngineCatalog } from '@/api';
import { useBooruEngineCatalog } from '@/hooks/booru-sites';

type EngineCatalogEntry = BooruEngineCatalog['engines'][number];

const FEATURE_COLUMNS: {
  key: string;
  label: string;
  hint: string;
  available: (engine: EngineCatalogEntry) => boolean;
}[] = [
  {
    key: 'favorites',
    label: 'Favorites',
    hint: 'Sync favorites, and add or remove them remotely',
    available: (engine) => engine.defaultCapabilities.favorites
  },
  {
    key: 'tags',
    label: 'Tags',
    hint: 'Import tags from a post',
    available: (engine) => engine.defaultCapabilities.tags
  },
  {
    key: 'sourceMatch',
    label: 'Source match',
    hint: 'Recognise its post URLs from a reverse image search',
    available: (engine) => engine.defaultCapabilities.sourceMatch
  },
  {
    key: 'exploreNew',
    label: 'New',
    hint: 'Show newest posts in Explore',
    available: (engine) => engine.supportedExploreSorts.includes('new')
  },
  {
    key: 'exploreHot',
    label: 'Hot',
    hint: 'Show trending posts in Explore',
    available: (engine) => engine.supportedExploreSorts.includes('hot')
  },
  {
    key: 'explorePopular',
    label: 'Popular',
    hint: 'Show top posts for a time window in Explore',
    available: (engine) => engine.supportedExploreSorts.includes('popular')
  },
  {
    key: 'tagSearch',
    label: 'Tag search',
    hint: 'Filter Explore results by tags',
    available: (engine) => engine.supportsExploreTagSearch
  },
  {
    key: 'vote',
    label: 'Vote',
    hint: 'Upvote or downvote a post',
    available: (engine) => engine.defaultCapabilities.vote
  },
  {
    key: 'relations',
    label: 'Relations',
    hint: 'Show parent and child posts',
    available: (engine) => engine.supportsRelations
  },
  {
    key: 'pools',
    label: 'Pools',
    hint: 'Show ordered post sets such as comics',
    available: (engine) => engine.supportsPools
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

  const rows = (data?.engines ?? []).map((engine) => ({
    key: engine.type,
    label: ENGINE_LABELS[engine.type] ?? engine.type,
    engine
  }));

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
                {FEATURE_COLUMNS.map((column) => (
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
                  </td>
                  {FEATURE_COLUMNS.map((column) => (
                    <SupportCell
                      key={column.key}
                      available={column.available(row.engine)}
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
