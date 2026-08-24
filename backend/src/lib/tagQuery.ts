import { normalizeTag } from './booruEngines/helpers';

export type ScoreComparison = '>' | '>=' | '<' | '<=' | '=';

export type ScoreFilter = {
  op: ScoreComparison;
  value: number;
  /** `-score:>5` keeps exactly the files the plain term would have dropped. */
  negated: boolean;
};

/**
 * A parsed tag search. `all` must every match, `any` needs one match when it
 * is non-empty, `none` must not match. Booru convention: `~` collects one
 * OR group that is ANDed with the rest, and there are no parentheses.
 *
 * `score` holds the `score:` metatag. Several of them narrow each other
 * (`score:>0 score:<10` is a range); like on the booru sites, a metatag
 * never joins a `~` group.
 */
export type TagQuery = {
  all: string[];
  any: string[];
  none: string[];
  score: ScoreFilter[];
};

export const emptyTagQuery = (): TagQuery => ({
  all: [],
  any: [],
  none: [],
  score: []
});

export const isTagQueryEmpty = (query: TagQuery): boolean =>
  query.all.length === 0 &&
  query.any.length === 0 &&
  query.none.length === 0 &&
  query.score.length === 0;

// `score:>=3`, `score:<0`, `score:5`. The comparison is optional and means
// equality when left out, which is how the booru sites spell it.
const SCORE_TOKEN = /^score:(>=|<=|>|<|=)?(-?\d+)$/;

const parseScoreToken = (
  token: string,
  negated: boolean
): ScoreFilter | null => {
  const match = SCORE_TOKEN.exec(token);
  if (!match) return null;
  return {
    op: (match[1] as ScoreComparison | undefined) ?? '=',
    value: Number(match[2]),
    negated
  };
};

/**
 * Splits a raw search box value into its buckets.
 *
 * `a b` and `a, b` both mean "a and b" — the comma stays supported because
 * the search box accepted it before the operators existed. `~a ~b` is "a or
 * b", `-a` is "not a". A prefix on its own (`-`, `~`) is dropped rather than
 * searched for literally, and so is a `score:` term that names no number.
 */
export const parseTagQuery = (value?: string): TagQuery => {
  const query = emptyTagQuery();
  if (!value) return query;

  for (const rawToken of value.split(/[,\s]+/)) {
    if (!rawToken) continue;
    const negated = rawToken.startsWith('-');
    const alternative = rawToken.startsWith('~');
    const token = negated || alternative ? rawToken.slice(1) : rawToken;

    if (token.toLowerCase().startsWith('score:')) {
      const score = parseScoreToken(token.toLowerCase(), negated);
      if (score) query.score.push(score);
      continue;
    }

    const tag = normalizeTag(token);
    if (!tag) continue;
    const bucket = negated ? query.none : alternative ? query.any : query.all;
    if (!bucket.includes(tag)) bucket.push(tag);
  }

  return query;
};
