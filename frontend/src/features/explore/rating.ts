import type { BooruEngineType } from '@/api';

/**
 * The rating letter a booru reports, spelled out.
 *
 * The letters are not shared vocabulary: on danbooru `s` is Sensitive and
 * `g` is General, while e621 has no `g` at all and uses `s` for Safe. Only
 * the disagreement that misleads is special-cased — calling a danbooru
 * `s` post "Safe" says the opposite of what the booru means.
 *
 * An engine that spells its rating out in full (gelbooru) keeps its own
 * word, capitalised.
 */
export const ratingLabel = (
  rating: string,
  engine: BooruEngineType
): string => {
  const key = rating.toLowerCase();
  if (key === 's') return engine === 'danbooru' ? 'Sensitive' : 'Safe';
  const shared: Record<string, string> = {
    g: 'General',
    q: 'Questionable',
    e: 'Explicit'
  };
  return shared[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
};
