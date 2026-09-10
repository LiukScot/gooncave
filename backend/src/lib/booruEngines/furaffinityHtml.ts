import { normalizeTag } from './helpers';
import type { RemotePost, TagResult } from './types';

export type FurAffinitySubmissionPage = {
  missing: boolean;
  tags: TagResult[];
  fileUrl: string | null;
  action: 'fav' | 'unfav' | null;
  actionPath: string | null;
};

export class FurAffinityPageError extends Error {}

export const assertNotChallenge = (html: string): void => {
  const lower = html.toLowerCase();
  if (
    lower.includes('just a moment') ||
    lower.includes('/cdn-cgi/challenge-platform') ||
    lower.includes('cf-challenge')
  ) {
    throw new FurAffinityPageError(
      'FurAffinity blocked the request with a browser challenge'
    );
  }
};

export const listingIds = (html: string): string[] => [
  ...new Set(
    [...html.matchAll(/<figure[^>]*\bid=["']sid-(\d+)["']/gi)].map(
      (match) => match[1]
    )
  )
];

export const nextFavoritesCursor = (html: string): string | null =>
  /<form[^>]*\baction=["'](\/favorites\/[^"'/]+\/\d+\/next)["']/i.exec(
    html
  )?.[1] ?? null;

const submissionImageTag = (html: string): string | null =>
  /<img[^>]*\bid=["']submissionImg["'][^>]*>/i.exec(html)?.[0] ?? null;

const attribute = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;

const tagPriority: Record<string, number> = {
  general: 0,
  meta: 1,
  species: 2,
  artist: 3
};

export const parseFurAffinityTags = (dataTags: string | null): TagResult[] => {
  if (!dataTags) return [];
  const tags = new Map<string, TagResult>();
  for (const token of dataTags.split(/\s+/).filter(Boolean)) {
    let raw = token;
    let category = 'general';
    if (token.startsWith('u_')) {
      raw = token.slice(2).replace(/^_+/, '');
      category = 'artist';
    } else if (token.startsWith('s_')) {
      raw = token.slice(2);
      if (raw === 'all' || raw === 'unspecified_any') continue;
      category = 'species';
    } else if (token.startsWith('c_') || token.startsWith('t_')) {
      raw = token.slice(2);
      if (raw === 'all' || raw === 'unspecified_any') continue;
      category = 'meta';
    }
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const existing = tags.get(tag);
    if (
      !existing ||
      (tagPriority[category] ?? 0) > (tagPriority[existing.category] ?? 0)
    ) {
      tags.set(tag, { tag, category });
    }
  }
  return [...tags.values()];
};

export type FurAffinityListingPage = {
  posts: RemotePost[];
  nextCursor: string | null;
};

const timestampFromThumb = (url: string | null): string | null => {
  const seconds = url ? /-(\d{10})(?:\.[a-z0-9]+)?(?:[?#]|$)/i.exec(url)?.[1] : null;
  if (!seconds) return null;
  const date = new Date(Number(seconds) * 1_000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

const listingFigure = /<figure[^>]*\bid=["']sid-(\d+)["'][^>]*>/i;

export const parseFurAffinityListingPage = (
  html: string,
  kind: 'browse' | 'subscriptions'
): FurAffinityListingPage => {
  assertNotChallenge(html);
  const structurallyValid =
    kind === 'browse'
      ? /\bid=["']pageid-browse["']/i.test(html)
      : /\bid=["']messagecenter-(?:new-)?submissions["']/i.test(html);
  if (!structurallyValid) {
    throw new FurAffinityPageError(
      `FurAffinity returned an unexpected ${kind === 'browse' ? 'browse' : 'submissions'} page`
    );
  }

  const posts: RemotePost[] = [];
  for (const raw of html.split(/<\/figure>/i)) {
    const start = raw.search(listingFigure);
    if (start < 0) continue;
    const chunk = raw.slice(start);
    const figure = listingFigure.exec(chunk);
    const remoteId = figure?.[1];
    if (!remoteId) continue;
    const figureTag = figure[0];
    const imageTag = /<img\b[^>]*>/i.exec(chunk)?.[0] ?? '';
    const previewUrl = normalizeFurAffinityMediaUrl(attribute(imageTag, 'src'));
    const artist =
      /<a[^>]*\bhref=["']\/user\/([^"'/]+)\/?["']/i.exec(chunk)?.[1] ??
      null;
    const width = Number(attribute(imageTag, 'data-width'));
    const height = Number(attribute(imageTag, 'data-height'));
    posts.push({
      remoteId,
      previewUrl,
      sampleUrl: previewUrl,
      fileUrl: null,
      width: Number.isFinite(width) ? Math.round(width) : null,
      height: Number.isFinite(height) ? Math.round(height) : null,
      score: null,
      rating: /\br-(general|mature|adult)\b/i.exec(figureTag)?.[1]?.toLowerCase() ?? null,
      md5: null,
      createdAt: timestampFromThumb(previewUrl),
      tags: parseFurAffinityTags(attribute(imageTag, 'data-tags')),
      favCount: null,
      uploader: artist,
      fileExt: null,
      fileSize: null,
      favorited: null,
      voted: null,
      parentId: null,
      hasChildren: false,
      poolIds: null
    });
  }

  const nextCursor =
    kind === 'subscriptions'
      ? Array.from(html.matchAll(/<a\b[^>]*>/gi), ([tag]) => tag)
          .filter((tag) => {
            const classes = (attribute(tag, 'class') ?? '').split(/\s+/);
            return (
              (classes.includes('more') || classes.includes('more-half')) &&
              !classes.includes('prev')
            );
          })
          .map((tag) => attribute(tag, 'href'))
          .find((href) =>
            /^\/msg\/submissions\/new~\d+@48\/$/.test(href ?? '')
          ) ?? null
      : null;
  return { posts, nextCursor };
};

export const parseFurAffinityWatchlist = (
  html: string,
  username: string
): string[] => {
  assertNotChallenge(html);
  if (!/<title>\s*Buddy list\s*--\s*Fur Affinity \[dot\] net/i.test(html)) {
    throw new FurAffinityPageError('FurAffinity returned an unexpected watchlist page');
  }
  const byKey = new Map<string, string>();
  for (const match of html.matchAll(/<a[^>]*\bhref=["']\/user\/([^"'/]+)\/?["']/gi)) {
    const artist = match[1];
    const key = artist.toLowerCase();
    if (key === username.toLowerCase() || byKey.has(key)) continue;
    byKey.set(key, artist);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
};

export const normalizeFurAffinityMediaUrl = (
  raw: string | null
): string | null => {
  if (!raw) return null;
  try {
    const decoded = raw.replace(/&amp;/g, '&');
    const url = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!/(^|\.)furaffinity\.net$/i.test(url.hostname)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
};

export const parseSubmissionPage = (
  html: string,
  postId: string
): FurAffinitySubmissionPage => {
  assertNotChallenge(html);
  const image = submissionImageTag(html);
  if (!image) {
    if (/submission you are trying to find is not in our database/i.test(html)) {
      return {
        missing: true,
        tags: [],
        fileUrl: null,
        action: null,
        actionPath: null
      };
    }
    throw new FurAffinityPageError(
      'FurAffinity returned an unexpected submission page'
    );
  }

  const actionMatch = new RegExp(
    `href=["']\\/(fav|unfav)\\/${postId}\\/?\\?key=([0-9a-f]+)["']`,
    'i'
  ).exec(html);
  const action = (actionMatch?.[1]?.toLowerCase() as 'fav' | 'unfav') ?? null;
  const actionPath = actionMatch
    ? `/${action}/${postId}/?key=${actionMatch[2]}`
    : null;
  return {
    missing: false,
    tags: parseFurAffinityTags(attribute(image, 'data-tags')),
    fileUrl: normalizeFurAffinityMediaUrl(
      attribute(image, 'data-fullview-src')
    ),
    action,
    actionPath
  };
};
