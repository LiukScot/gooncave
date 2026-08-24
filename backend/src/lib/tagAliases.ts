/**
 * e621 parks tags it does not want under these consequents. Following them
 * would stamp `invalid_tag` onto real files (`2d` and `ai_generated` both
 * alias to it) or replace a character name with a disambiguation stub
 * (`susie` → `susie_(disambiguation)`), so the tag is left as it is.
 */
export const isUnusableConsequent = (tag: string): boolean =>
  tag === 'invalid_tag' || tag.endsWith('_(disambiguation)');

/**
 * Follows an alias to the tag it finally lands on. e621's own table is
 * already flat, but a hand-written alias can point at another alias, so
 * chains are walked to their end. A cycle resolves to the tag the walk
 * started from rather than throwing: an unusable alias must not take the
 * whole import down with it.
 */
export const resolveAlias = (
  tag: string,
  aliases: ReadonlyMap<string, string>
): string => {
  const seen = new Set<string>([tag]);
  let current = tag;
  for (;;) {
    const next = aliases.get(current);
    if (!next || isUnusableConsequent(next) || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
};

/**
 * Expands direct tag implications into every ancestor each tag reaches.
 *
 * Search and the detail view both need the full chain (`husky` → `dog` →
 * `canine` → `mammal`), and walking it per query would mean a recursive
 * query on every search. e621 ships a `descendant_names` column that looks
 * like this closure but disagrees with the graph on hundreds of rows, so it
 * is recomputed here instead of trusted.
 *
 * Cycles are dropped rather than followed. The result never contains a tag
 * as its own ancestor.
 */
export const buildImplicationClosure = (
  implications: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, Set<string>> => {
  const closure = new Map<string, Set<string>>();

  const walk = (tag: string, stack: Set<string>): Set<string> => {
    const cached = closure.get(tag);
    if (cached) return cached;
    if (stack.has(tag)) return new Set();

    const ancestors = new Set<string>();
    stack.add(tag);
    for (const parent of implications.get(tag) ?? []) {
      if (parent === tag) continue;
      ancestors.add(parent);
      for (const grandparent of walk(parent, stack)) {
        if (grandparent !== tag) ancestors.add(grandparent);
      }
    }
    stack.delete(tag);

    closure.set(tag, ancestors);
    return ancestors;
  };

  for (const tag of implications.keys()) walk(tag, new Set());
  return closure;
};
