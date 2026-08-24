import type { ProviderHighlight, TagGroup } from './FileDetailPanel';
import { resolveSourceLabel, resolveTopMatchSourceName } from './sourceLabels';

import type { FileTag, ProviderRun } from '@/api';

/**
 * Derivations shared by the detail panel and the swipe preview. They live
 * apart from the controller so both sides read one implementation: the
 * preview showed empty sections for as long as it had no way to build these
 * for the neighbouring file.
 */

export type ProviderKind = 'SAUCENAO' | 'FLUFFLE';

export const providerScoreThresholds: Record<ProviderKind, number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};

export const resolveProviderScore = (
  provider: ProviderKind,
  result: { score?: number | null; distance?: number | null }
): number | null => {
  if (provider !== 'FLUFFLE') {
    return typeof result.score === 'number' ? result.score : null;
  }
  if (typeof result.score === 'number') return result.score;
  if (typeof result.distance === 'number') return result.distance;
  return null;
};

const canonicalSauces: Record<string, string> = {
  'e621.net': 'e621',
  'www.e621.net': 'e621',
  'static1.e621.net': 'e621',
  'static2.e621.net': 'e621',
  'static3.e621.net': 'e621',
  'static4.e621.net': 'e621',
  'danbooru.donmai.us': 'danbooru',
  'www.danbooru.donmai.us': 'danbooru'
};

export const normalizeSauceKey = (value: string) => value.trim().toLowerCase();

export const canonicalizeSauceKey = (value: string): string => {
  const key = normalizeSauceKey(value);
  if (canonicalSauces[key]) return canonicalSauces[key];
  if (key.endsWith('.e621.net')) return 'e621';
  return key;
};

export const normalizeSourceName = (value: string): string => {
  let cleaned = value.trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/^index\s*#?\d+:\s*/i, '');
  cleaned = cleaned.replace(/\s+–\s+/g, ' - ');
  if (cleaned.includes(' - ')) {
    cleaned = cleaned.split(' - ')[0].trim();
  }
  return cleaned;
};

export const looksLikeFilename = (value: string): boolean => {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.includes('/') || lower.includes('\\')) return true;
  return /\.[a-z0-9]{2,5}$/.test(lower);
};

export const sauceKeyFromResult = (
  sourceUrl: string | null | undefined,
  sourceName: string | null | undefined
): string | null => {
  if (sourceName) {
    const cleaned = normalizeSourceName(sourceName);
    if (cleaned && !looksLikeFilename(cleaned)) {
      return canonicalizeSauceKey(cleaned);
    }
  }
  if (sourceUrl) {
    try {
      return canonicalizeSauceKey(
        new URL(sourceUrl).hostname.replace(/^www\./, '')
      );
    } catch {
      return canonicalizeSauceKey(sourceUrl);
    }
  }
  return null;
};

/**
 * Collapses a file's stored tags into the pills the detail view shows.
 *
 * Tags are keyed by the tag they alias to, not by their own name, so a file
 * carrying both `1girls` and `female` renders one pill. The originals ride
 * along because removing that pill has to suppress every one of them, and
 * the user has to be told which.
 */
export const buildTagGroups = (
  fileTags: readonly FileTag[]
): readonly TagGroup[] => {
  const map = new Map<
    string,
    {
      tag: string;
      originals: string[];
      category: string;
      sources: Set<string>;
      score: number | null;
    }
  >();
  for (const tag of fileTags) {
    const canonical = tag.canonicalTag || tag.tag;
    const key = `${tag.category}:${canonical}`;
    const existing = map.get(key);
    const score = typeof tag.score === 'number' ? tag.score : null;
    if (existing) {
      existing.sources.add(tag.source);
      if (!existing.originals.includes(tag.tag)) {
        existing.originals.push(tag.tag);
      }
      if (
        score !== null &&
        (existing.score === null || score > existing.score)
      ) {
        existing.score = score;
      }
    } else {
      map.set(key, {
        tag: canonical,
        originals: [tag.tag],
        category: tag.category,
        sources: new Set([tag.source]),
        score
      });
    }
  }
  const grouped = Array.from(map.values())
    .map((entry) => ({ ...entry, originals: [...entry.originals].sort() }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  const order = [
    'artist',
    'character',
    'copyright',
    'species',
    'general',
    'meta',
    'lore',
    'invalid',
    'other'
  ];
  const categories = new Map<string, typeof grouped>();
  for (const entry of grouped) {
    const key = entry.category || 'other';
    const bucket = categories.get(key) ?? [];
    bucket.push(entry);
    categories.set(key, bucket);
  }
  const ordered = Array.from(categories.entries()).sort((a, b) => {
    const idxA = order.indexOf(a[0]);
    const idxB = order.indexOf(b[0]);
    if (idxA === -1 && idxB === -1) return a[0].localeCompare(b[0]);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });
  return ordered.map(([category, tags]) => ({ category, tags }));
};

export const buildTagSourceSummary = (
  fileTags: readonly FileTag[],
  booruSiteNameById: Readonly<Record<string, string>>
): string => {
  if (fileTags.length === 0) return 'none';
  const sources = Array.from(
    new Set(
      fileTags.map((tag) =>
        resolveSourceLabel(tag.source, booruSiteNameById).toLowerCase()
      )
    )
  );
  return sources.join(', ');
};

export type HighlightContext = {
  displayFilterActive: boolean;
  displaySet: ReadonlySet<string>;
  booruSiteNameById: Readonly<Record<string, string>>;
};

export const buildProviderHighlights = (
  providerInfo: readonly ProviderRun[],
  { displayFilterActive, displaySet, booruSiteNameById }: HighlightContext
): readonly ProviderHighlight[] => {
  const latestByProvider = new Map<string, ProviderRun>();
  providerInfo.forEach((run) => {
    if (!latestByProvider.has(run.provider)) {
      latestByProvider.set(run.provider, run);
    }
  });

  const highlights: ProviderHighlight[] = [];

  for (const [provider, run] of latestByProvider.entries()) {
    const threshold = providerScoreThresholds[provider as ProviderKind] ?? 0;
    const results: Array<{
      sourceUrl?: string | null;
      sourceName?: string | null;
      score?: number | null;
      distance?: number | null;
    }> =
      Array.isArray(run.results) && run.results.length > 0
        ? run.results
        : [
            {
              sourceUrl: run.sourceUrl ?? null,
              score: run.score ?? null,
              sourceName: null,
              distance: null
            }
          ];
    for (const result of results) {
      if (!result?.sourceUrl) continue;
      if (displayFilterActive) {
        const key = sauceKeyFromResult(
          result.sourceUrl,
          result.sourceName ?? null
        );
        if (!key || !displaySet.has(key)) continue;
      }
      const score = resolveProviderScore(provider as ProviderKind, result);
      if (score === null || score < threshold) continue;
      const distance =
        typeof result.distance === 'number'
          ? result.distance
          : Math.max(0, Math.round(100 - score));
      const sourceKey = sauceKeyFromResult(
        result.sourceUrl,
        result.sourceName ?? null
      );
      highlights.push({
        id: `${run.id}-${result.sourceUrl}`,
        provider,
        sourceUrl: result.sourceUrl,
        sourceName: resolveTopMatchSourceName(
          {
            sourceKey,
            sourceName: result.sourceName,
            provider
          },
          booruSiteNameById
        ),
        score,
        distance
      });
    }
  }

  return highlights;
};
