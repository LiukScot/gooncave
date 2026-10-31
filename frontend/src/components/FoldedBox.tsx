import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Content cut at a fixed height with a fade and a "Show more" button. The
 * button appears only when the content is taller than the cut, so a short
 * body is never folded.
 */
export function FoldedBox({
  children,
  className = '',
  maxHeight = '12rem'
}: {
  children: ReactNode;
  className?: string;
  /** Any CSS length. */
  maxHeight?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Measured while folded: an expanded body has no cut to compare with, and
  // keeping the last answer stops the button vanishing under the reader.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [expanded, children]);

  const folded = overflows && !expanded;
  return (
    <div className={className}>
      <div
        ref={bodyRef}
        className={folded ? 'folded-box is-cut' : undefined}
        style={expanded ? undefined : { maxHeight, overflow: 'hidden' }}
      >
        {children}
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
