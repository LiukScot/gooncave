import type { BooruSite } from '@/api';

type Engine = BooruSite['engine'];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

// Mirrors core/src/booru_engines.rs `post_url`. Gelbooru reads its id from the query string.
const POST_PATHS: Record<Exclude<Engine, 'gelbooru'>, RegExp[]> = {
  e621: [/^\/posts\/([^/]+)$/],
  danbooru: [/^\/posts\/([^/]+)$/],
  moebooru: [/^\/post\/show\/([^/]+)$/],
  sankaku: [/^\/post\/show\/([^/]+)$/, /^\/posts\/([^/]+)$/],
  philomena: [/^\/images\/([^/]+)$/, /^\/(\d+)$/],
  shimmie: [/^\/post\/view\/([^/]+)$/],
  szurubooru: [/^\/post\/([^/]+)$/],
  furaffinity: [/^\/view\/([^/]+)$/]
};

const remoteIdOf = (engine: Engine, url: URL): string | null => {
  const path = url.pathname.replace(/\/$/, '');
  let id: string | null = null;
  if (engine === 'gelbooru') {
    if (
      path === '/index.php' &&
      url.searchParams.get('page') === 'post' &&
      url.searchParams.get('s') === 'view'
    ) {
      id = url.searchParams.get('id');
    }
  } else {
    for (const pattern of POST_PATHS[engine]) {
      const match = pattern.exec(path);
      if (match) {
        id = match[1];
        break;
      }
    }
  }
  return id !== null && ID_PATTERN.test(id) ? id : null;
};

// rule34 serves its API from api.rule34.xxx and its pages from rule34.xxx.
const comparableHost = (hostname: string): string =>
  hostname.replace(/^(www|api)\./, '');

/**
 * Returns the site and post id when `text` is a link to a post on one of
 * `sites`, or null when it is a tag search.
 */
export function postLinkTarget(
  text: string,
  sites: Pick<BooruSite, 'id' | 'engine' | 'baseUrl'>[]
): { siteId: string; remoteId: string } | null {
  // Not a link: a tag search.
  if (!URL.canParse(text.trim())) return null;
  const link = new URL(text.trim());
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return null;

  const host = comparableHost(link.hostname);
  for (const site of sites) {
    // A site saved with a broken address cannot own the link.
    if (!URL.canParse(site.baseUrl)) continue;
    if (comparableHost(new URL(site.baseUrl).hostname) !== host) continue;
    const remoteId = remoteIdOf(site.engine, link);
    if (remoteId !== null) return { siteId: site.id, remoteId };
  }
  return null;
}
