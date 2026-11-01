import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Content cut at a fixed height with a fade and a "Show more" button. The
 * button appears only when the content is taller than the cut, so a short
 * body is never folded.
 */
export function FoldedBox({
  children,
  className,
  maxHeight = '12rem'
}: {
  children: ReactNode;
  className?: string;
  /** Any CSS length. */
  maxHeight?: string;
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
    const measure = () =>
      setOverflows(content.offsetHeight > cut.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <div className={className}>
      <div
        ref={cutRef}
        className={overflows && !expanded ? 'folded-box is-cut' : undefined}
        style={expanded ? undefined : { maxHeight, overflow: 'hidden' }}
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
