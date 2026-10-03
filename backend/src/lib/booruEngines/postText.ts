import { stripTrailingSlash } from './helpers';

/**
 * Post descriptions arrive in each booru's own markup — DText, HTML, a
 * Markdown dialect. They leave here as one small Markdown subset, which is
 * all the client renders: `**bold**`, `*italic*`, `__underline__`,
 * `~~strike~~`, `[label](https://url)` and `> quote` lines. Nothing a post
 * contains ever reaches the page as HTML.
 *
 * ponytail: a literal `*` or `_` in the source is not escaped, so a
 * description that uses them as plain characters can gain stray emphasis.
 * Escape on the way in if that shows up in real posts.
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== '#') return HTML_ENTITIES[body.toLowerCase()] ?? entity;
    const code =
      body[1].toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  });

/** Trims every line and caps runs of blank lines at one. */
const tidyLines = (text: string): string | null =>
  text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;

const absoluteUrl = (url: string, baseUrl: string): string =>
  url.startsWith('//')
    ? `https:${url}`
    : url.startsWith('/')
      ? `${stripTrailingSlash(baseUrl)}${url}`
      : url;

const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Removes every match, then looks again: taking one out can leave the pieces
 * on either side of it spelling another (`<scr<script></script>ipt>`).
 */
const removeAll = (text: string, pattern: RegExp): string => {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(pattern, '');
  } while (current !== previous);
  return current;
};

/** HTML with its tags dropped and its line breaks kept. */
const stripHtml = (html: string): string =>
  decodeEntities(
    removeAll(
      html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n'),
      /<[^>]*>/g
    )
  );

// An element left unclosed runs to the end, as it does in a browser.
const withoutScripts = (html: string): string =>
  removeAll(html, /<(script|style)\b[\s\S]*?(?:<\/\1>|$)/gi).replace(
    /\r?\n\s*/g,
    ' '
  );

/** The readable text of an HTML fragment, with no formatting at all. */
export const htmlToText = (fragment: string | undefined): string | null =>
  fragment ? tidyLines(stripHtml(withoutScripts(fragment))) : null;

/**
 * FurAffinity routes outside links through its own redirect page; the link
 * shown is the one the uploader wrote.
 */
const unwrapRedirect = (url: string): string => {
  const wrapped = /\/externalurl\/\?q=([^&]+)/i.exec(url)?.[1];
  if (!wrapped) return url;
  try {
    return decodeURIComponent(wrapped);
  } catch {
    return url;
  }
};

/** An HTML fragment as the Markdown subset described at the top. */
export const htmlToMarkdown = (
  fragment: string | undefined,
  baseUrl: string
): string | null => {
  if (!fragment) return null;
  const marked = withoutScripts(fragment)
    .replace(
      /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_match, _quote: string, href: string, inner: string) => {
        // An avatar link has no text of its own; its image names the user.
        const label = (
          stripHtml(inner).trim() ||
          decodeEntities(/\balt=(["'])(.*?)\1/i.exec(inner)?.[2] ?? '')
        ).replace(/[[\]]/g, '');
        const url = unwrapRedirect(absoluteUrl(decodeEntities(href), baseUrl));
        if (!label) return '';
        return isWebUrl(url) ? `[${label}](${url.replace(/[()\s]/g, encodeURIComponent)})` : label;
      }
    )
    .replace(/<\/?(?:b|strong)\b[^>]*>/gi, '**')
    .replace(/<\/?(?:i|em)\b[^>]*>/gi, '*')
    .replace(/<\/?u\b[^>]*>/gi, '__')
    .replace(/<\/?(?:s|strike|del)\b[^>]*>/gi, '~~');
  return tidyLines(stripHtml(marked));
};

const DTEXT_LEFTOVER_TAGS =
  /\[\/?(?:sup|sub|quote|spoiler|code|table|thead|tbody|tr|td|th|section|color|tn|nodtext|expand)(?:[=,][^\]]*)?\]/gi;

/**
 * DText (e621, Danbooru) as the Markdown subset described at the top. Tags
 * with no counterpart there are dropped and their text kept.
 */
export const dtextToMarkdown = (
  dtext: string | null | undefined,
  baseUrl: string
): string | null => {
  if (!dtext) return null;
  const marked = dtext
    .replace(/\r\n?/g, '\n')
    .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, (_match, body: string) => {
      const lines = body.trim().split('\n');
      return `\n${lines.map((line) => `> ${line}`).join('\n')}\n`;
    })
    .replace(/\[\/?b\]/gi, '**')
    .replace(/\[\/?i\]/gi, '*')
    .replace(/\[\/?u\]/gi, '__')
    .replace(/\[\/?s\]/gi, '~~')
    .replace(
      /"([^"\n]+)":\[?((?:https?:\/\/|\/)[^\s\]]+)\]?/g,
      (_match, label: string, url: string) =>
        `[${label.replace(/[[\]]/g, '')}](${absoluteUrl(url, baseUrl)})`
    )
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^h[1-6]\.\s*(.+)$/gim, '**$1**')
    .replace(DTEXT_LEFTOVER_TAGS, '');
  return tidyLines(marked);
};
