import { normalizeTag } from './booruEngines/helpers';

/**
 * A parsed tag search. `all` must every match, `any` needs one match when it
 * is non-empty, `none` must not match. Booru convention: `~` collects one
 * OR group that is ANDed with the rest, and there are no parentheses.
 */
export type TagQuery = {
  all: string[];
  any: string[];
  none: string[];
};

export const emptyTagQuery = (): TagQuery => ({ all: [], any: [], none: [] });

export const isTagQueryEmpty = (query: TagQuery): boolean =>
  query.all.length === 0 && query.any.length === 0 && query.none.length === 0;

/**
 * Splits a raw search box value into its three buckets.
 *
 * `a b` and `a, b` both mean "a and b" — the comma stays supported because
 * the search box accepted it before the operators existed. `~a ~b` is "a or
 * b", `-a` is "not a". A prefix on its own (`-`, `~`) is dropped rather than
 * searched for literally.
 */
export const parseTagQuery = (value?: string): TagQuery => {
  const query = emptyTagQuery();
  if (!value) return query;

  for (const token of value.split(/[,\s]+/)) {
    if (!token) continue;
    const negated = token.startsWith('-');
    const alternative = token.startsWith('~');
    const tag = normalizeTag(negated || alternative ? token.slice(1) : token);
    if (!tag) continue;
    const bucket = negated ? query.none : alternative ? query.any : query.all;
    if (!bucket.includes(tag)) bucket.push(tag);
  }

  return query;
};
