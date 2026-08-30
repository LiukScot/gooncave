/**
 * The manual tag blacklist. One list, applied in two different ways: the
 * gallery pushes it into the server-side tag query as exclusions, Explore
 * drops posts client-side because the booru results already carry tags.
 */

/** Mirrors the backend's `normalizeTag`, which is what the list is stored as. */
export const normalizeTag = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w:()-]+/g, '')
    .toLowerCase();

const TERM_SEPARATOR = /[,\s]+/;

/** Splits the settings textarea into tags; commas, spaces and newlines all cut. */
export const parseBlacklistInput = (value: string): string[] =>
  Array.from(
    new Set(value.split(TERM_SEPARATOR).map(normalizeTag).filter(Boolean))
  );

/**
 * The blacklist minus anything the user is explicitly searching for. Without
 * this the gallery would send `wolf -wolf` and Explore would hide every
 * result of a search the user typed on purpose.
 */
export const effectiveBlacklist = (
  blacklist: string[],
  tagQuery: string
): string[] => {
  const searched = new Set(
    tagQuery
      .split(TERM_SEPARATOR)
      .map((term) => normalizeTag(term.replace(/^[~-]/, '')))
      .filter(Boolean)
  );
  return blacklist.filter((tag) => !searched.has(tag));
};

/** Adds the blacklist to a gallery search as `-tag` exclusions. */
export const applyBlacklistToQuery = (
  tagQuery: string,
  blacklist: string[]
): string =>
  [
    tagQuery.trim(),
    ...effectiveBlacklist(blacklist, tagQuery).map((tag) => `-${tag}`)
  ]
    .filter(Boolean)
    .join(' ');

/** True when any of the post's tags is on the list. */
export const isBlacklisted = (
  tags: { tag: string }[],
  blacklist: Set<string>
): boolean => {
  if (blacklist.size === 0) return false;
  return tags.some(({ tag }) => blacklist.has(normalizeTag(tag)));
};
