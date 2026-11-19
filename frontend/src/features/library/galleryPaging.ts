/** Files fetched per scroll of the gallery. */
export const GALLERY_PAGE_SIZE = 200;

/**
 * Ceiling the backend puts on `limit` for GET /files. Reads as a duplicate of
 * a server constant because it is one: exceeding it is a 400, so the client
 * has to know where to stop asking.
 */
export const GALLERY_MAX_LIMIT = 1000;

/**
 * Keeps the loaded files in place, updated, without the deleted ones. A new file goes after them
 * only when the server puts it after every one of them; one that belongs among them is held back,
 * because appending it would show it far from its place. The next refresh from the top shows it.
 */
export function mergeGalleryRefresh<T extends { id: string }>(existing: T[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((file) => [file.id, file]));
  const loaded = new Set(existing.map((file) => file.id));
  const lastLoaded = fresh.findLastIndex((file) => loaded.has(file.id));
  const result: T[] = [];
  for (const file of existing) {
    const updated = byId.get(file.id);
    if (updated) result.push(updated);
  }
  return [...result, ...fresh.slice(lastLoaded + 1)];
}

/**
 * How many files a fetch should ask for.
 *
 * A reset starts the list again from offset 0. When it is a genuinely new
 * list — a different sort, folder or query — one page is right, because
 * there is nothing to be back at. When it is a *refresh* of a list the user
 * has already scrolled through (a rescan finishing, an upload landing, or
 * returning to a folder still in the page cache), one page throws away every
 * file past the first two hundred: the page shortens under the reader, and
 * the scroll restore has nowhere left to land.
 *
 * `cachedOffset` is how deep that list already went, and is 0 when nothing is
 * cached under this key.
 *
 * @param cachedOffset files already loaded under this cache key, 0 if none
 * @returns a limit between one page and the server's ceiling
 */
export const resetFetchLimit = (cachedOffset: number): number => {
  if (!Number.isFinite(cachedOffset) || cachedOffset <= GALLERY_PAGE_SIZE) {
    return GALLERY_PAGE_SIZE;
  }
  // ponytail: one request rather than a re-paging loop. Past the ceiling the
  // list still comes back a page short of where it was and the reader has to
  // scroll for the rest — add the loop if a library that deep turns up.
  return Math.min(cachedOffset, GALLERY_MAX_LIMIT);
};

/**
 * Lists the gallery keeps to show again at once, one per sort, search and filter. Each holds
 * every file loaded under it, so without a limit a long session keeps every search it ever made.
 */
export const GALLERY_CACHED_LISTS = 20;

/** Saves `value` as the newest entry and drops the oldest past GALLERY_CACHED_LISTS. */
export function rememberGalleryList<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= GALLERY_CACHED_LISTS) break;
    cache.delete(oldest);
  }
}
