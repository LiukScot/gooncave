/**
 * A small in-memory cache with a time limit and a size cap.
 *
 * For booru answers the detail view asks for on every open: the same listing
 * is otherwise fetched again each time a reader steps between posts of the
 * same set. Nothing here is persisted — a restart simply refetches.
 */
export const createTtlCache = <T>(ttlMs: number, limit: number) => {
  const entries = new Map<string, { at: number; value: T }>();
  return {
    get(key: string): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      if (entries.size >= limit && !entries.has(key)) {
        // Insertion order: the oldest key goes, which is close enough to LRU
        // for a cache this size.
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { at: Date.now(), value });
    }
  };
};
