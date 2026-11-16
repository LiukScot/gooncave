import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** About four lines: folding these away would hide less than the button takes. */
const SLACK_REM = 6;

/**
 * Content cut at a fixed height with a fade and a "Show more" button. The
 * button appears only when the content is taller than the cut by more than a
 * few lines; content up to that is shown whole, so a short body is never folded.
 */
export function FoldedBox({
  children,
  className,
  maxHeight = '12rem',
  slackRem = SLACK_REM
}: {
  children: ReactNode;
  className?: string;
  /** Any CSS length. */
  maxHeight?: string;
  /** How much taller than the cut the content may be and still show whole. */
  slackRem?: number;
}) {
  const cutRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // The content is observed, not the cut: the cut keeps its height whatever
  // the content does, so only the content notices an image or a tag list
  // growing after the first paint. An expanded box has no cut to compare
  // with, so it keeps the last answer and the button stays under the reader.
  useLayoutEffect(() => {
    const cut = cutRef.current;
    const content = contentRef.current;
    if (!cut || !content || expanded) return;
    // Unfolded, the cut is already slackRem taller; folded, it is not.
    const slack = slackRem * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const measure = () =>
      setOverflows((folded) => content.offsetHeight > cut.clientHeight + (folded ? slack : 0) + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, slackRem]);

  return (
    <div className={className}>
      <div
        ref={cutRef}
        className={overflows && !expanded ? 'folded-box is-cut' : undefined}
        style={
          expanded
            ? undefined
            : { maxHeight: overflows ? maxHeight : `calc(${maxHeight} + ${slackRem}rem)`, overflow: 'hidden' }
        }
        // Tabbing into the hidden part would scroll the cut under its fade.
        onFocus={(event) => {
          if (event.target.matches(':focus-visible')) setExpanded(true);
        }}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {overflows ? (
        <button
          type="button"
          className="btn btn-link btn-sm mt-1"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
