import type { ReactNode } from 'react';

// The subset the backend emits for post descriptions (see postText.ts
// there): labelled link, bold, underline, strike, italic, bare link — in
// that order, so `**` is tried before `*`.
const INLINE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(.+?)\*|(https?:\/\/[^\s<>)\]]+)/;

const link = (key: string, href: string, label: ReactNode) => (
  <a
    key={key}
    className="file-detail-source-link"
    href={href}
    target="_blank"
    rel="noreferrer noopener"
  >
    {label}
  </a>
);

const renderInline = (text: string, keyPrefix: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let rest = text;
  for (let index = 0; rest; index += 1) {
    const match = INLINE.exec(rest);
    if (!match) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const key = `${keyPrefix}.${index}`;
    const [, label, href, bold, underline, strike, italic, bareUrl] = match;
    if (label) nodes.push(link(key, href, label));
    else if (bold) nodes.push(<strong key={key}>{renderInline(bold, key)}</strong>);
    else if (underline) nodes.push(<u key={key}>{renderInline(underline, key)}</u>);
    else if (strike) nodes.push(<s key={key}>{renderInline(strike, key)}</s>);
    else if (italic) nodes.push(<em key={key}>{renderInline(italic, key)}</em>);
    else nodes.push(link(key, bareUrl, bareUrl));
    rest = rest.slice(match.index + match[0].length);
  }
  return nodes;
};

const QUOTE = /^>\s?/;

/**
 * Renders the Markdown subset as React elements. Everything else stays the
 * text it was: there is no HTML path, so a description cannot inject markup,
 * and only http(s) links become links.
 *
 * The container is expected to keep line breaks (`white-space: pre-line`).
 */
export function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!QUOTE.test(lines[index])) {
      blocks.push(...renderInline(lines[index], `l${index}`), '\n');
      continue;
    }
    const start = index;
    const quoted: ReactNode[] = [];
    while (index < lines.length && QUOTE.test(lines[index])) {
      quoted.push(
        ...renderInline(lines[index].replace(QUOTE, ''), `q${index}`),
        '\n'
      );
      index += 1;
    }
    index -= 1;
    blocks.push(
      <blockquote key={`b${start}`} className="file-detail-source-quote">
        {quoted.slice(0, -1)}
      </blockquote>
    );
  }
  return <>{blocks}</>;
}
