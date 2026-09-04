/**
 * The search box holds a whole query, so completion works on the term the
 * caret is in rather than the value as a whole, and it has to hand back the
 * operator that term was typed with.
 */
export type ActiveTagTerm = {
  /** The term with its `~` or `-` stripped, which is what to look up. */
  query: string;
  /** The prefix to put back when the suggestion is inserted. */
  prefix: string;
};

const SEPARATOR = /[,\s]/;

/**
 * The term the caret sits in. Returns null while the caret is on a
 * separator, on a `score:` metatag (nothing to suggest for a number), or on
 * a bare operator.
 */
export const activeTagTerm = (
  value: string,
  caret: number
): ActiveTagTerm | null => {
  const position = Math.max(0, Math.min(caret, value.length));
  let start = position;
  while (start > 0 && !SEPARATOR.test(value[start - 1])) start -= 1;
  let end = position;
  while (end < value.length && !SEPARATOR.test(value[end])) end += 1;

  const token = value.slice(start, end);
  if (!token) return null;

  const prefix = token.startsWith('~') || token.startsWith('-') ? token[0] : '';
  const query = token.slice(prefix.length);
  if (!query) return null;
  if (query.toLowerCase().startsWith('score:')) return null;
  return { query, prefix };
};

/**
 * Swaps the term under the caret for `tag`, keeping the rest of the query
 * and the operator the term carried. A trailing space follows so the next
 * term can be typed straight away.
 */
export const replaceActiveTagTerm = (
  value: string,
  caret: number,
  tag: string
): { value: string; caret: number } => {
  const position = Math.max(0, Math.min(caret, value.length));
  let start = position;
  while (start > 0 && !SEPARATOR.test(value[start - 1])) start -= 1;
  let end = position;
  while (end < value.length && !SEPARATOR.test(value[end])) end += 1;

  const token = value.slice(start, end);
  const prefix = token.startsWith('~') || token.startsWith('-') ? token[0] : '';
  // Only add the separator when the term is not already followed by one,
  // otherwise completing a term mid-query doubles the space every time.
  const spaced = end < value.length && SEPARATOR.test(value[end]);
  const replacement = `${prefix}${tag}${spaced ? '' : ' '}`;
  const next = value.slice(0, start) + replacement + value.slice(end);
  return { value: next, caret: start + replacement.length + (spaced ? 1 : 0) };
};

/**
 * Adds `tag` to a query that may already hold terms, as one more thing every
 * result has to match. Any existing occurrence of the same tag is dropped
 * first, under whatever operator it carried, so adding a tag already excluded
 * replaces it instead of building `female -female`, which matches nothing.
 */
export const appendTagTerm = (current: string, tag: string): string => {
  const terms = current.trim() ? current.trim().split(/\s+/) : [];
  return [
    ...terms.filter((term) => term.replace(/^[~-]/, '') !== tag),
    tag
  ].join(' ');
};
