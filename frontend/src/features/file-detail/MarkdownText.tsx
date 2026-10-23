import { useState, type ReactNode } from 'react';

// The subset the core emits for post descriptions (see post_text.rs there):
// spoiler, labelled link, bold, underline, strike, italic, bare link — in
// that order, so `**` is tried before `*`. Emphasis may run over several
// lines, never over a blank one; a spoiler may.
const BODY = String.raw`(?:(?!\n\n)[\s\S])+?`;
const INLINE = new RegExp(
  String.raw`\|\|([\s\S]+?)\|\||\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(${BODY})\*\*|__(${BODY})__|~~(${BODY})~~|\*(${BODY})\*|(https?:\/\/[^\s<>)\]]+)`
);

/** Hidden until clicked, so a spoiler is never read by accident. */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return <span className="file-detail-spoiler-text">{children}</span>;
  return (
    <button
      type="button"
      className="file-detail-spoiler"
      aria-label="Show spoiler"
      onClick={() => setShown(true)}
    >
      Spoiler
    </button>
  );
}

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
    const [, spoiler, label, href, bold, underline, strike, italic, bareUrl] =
      match;
    if (spoiler) nodes.push(<Spoiler key={key}>{renderInline(spoiler, key)}</Spoiler>);
    else if (label) nodes.push(link(key, href, label));
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

// Runs of quoted lines become a block quote, whose own lines are read the
// same way, so `>>` nests. Plain runs keep their line breaks for the
// container's `white-space: pre-line`.
const renderBlocks = (lines: string[], keyPrefix: string): ReactNode[] => {
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    const quoted = QUOTE.test(lines[index]);
    while (index + 1 < lines.length && QUOTE.test(lines[index + 1]) === quoted) {
      index += 1;
    }
    const run = lines.slice(start, index + 1);
    if (!quoted) {
      blocks.push(...renderInline(run.join('\n'), `${keyPrefix}t${start}`), '\n');
      continue;
    }
    const inner = renderBlocks(
      run.map((line) => line.replace(QUOTE, '')),
      `${keyPrefix}q${start}.`
    );
    if (inner.at(-1) === '\n') inner.pop();
    blocks.push(
      <blockquote key={`${keyPrefix}b${start}`} className="file-detail-source-quote">
        {inner}
      </blockquote>
    );
  }
  return blocks;
};

/**
 * Renders the Markdown subset as React elements. Everything else stays the
 * text it was: there is no HTML path, so a description cannot inject markup,
 * and only http(s) links become links.
 *
 * The container is expected to keep line breaks (`white-space: pre-line`).
 */
export function MarkdownText({ text }: { text: string }) {
  return <>{renderBlocks(text.split('\n'), '')}</>;
}
