import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** About four lines: folding these away would hide less than the button takes. */
const SLACK_REM = 6;

/** Where a list folded by rows is cut, in pixels from its top, and where its fade starts. */
type RowCut = { height: number; fadeFrom: number };

/**
 * The cut after `rows` rows of the list's items, through the middle of the next row. Null when
 * the list has at most one row more than that: hiding half a row would save less than the button
 * takes.
 */
function rowCut(list: Element, rows: number): RowCut | null {
  const top = list.getBoundingClientRect().top;
  const boxes = [...list.children].map((item) => item.getBoundingClientRect());
  const tops = [...new Set(boxes.map((box) => box.top))].sort((a, b) => a - b);
  if (tops.length <= rows + 1) return null;
  const next = boxes.find((box) => box.top === tops[rows])!;
  const lastFull = Math.max(...boxes.filter((box) => box.top === tops[rows - 1]).map((box) => box.bottom));
  return { height: next.top + next.height / 2 - top, fadeFrom: lastFull - top };
}

/**
 * Content cut with a fade and a "Show more" button. With `rows`, the content's first element is a
 * list cut after that many rows of its items, with half of the next row fading out; a list of up
 * to one row more is shown whole. Otherwise the cut is `maxHeight`, and content up to a few lines
 * taller is shown whole, so a short body is never folded.
 */
export function FoldedBox({
  children,
  className,
  maxHeight = '12rem',
  rows
}: {
  children: ReactNode;
  className?: string;
  /** Any CSS length. */
  maxHeight?: string;
  /** Rows of the list to show whole; replaces `maxHeight`. */
  rows?: number;
}) {
  const cutRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [listCut, setListCut] = useState<RowCut | null>(null);

  // The content is observed, not the cut: the cut keeps its height whatever
  // the content does, so only the content notices an image or a tag list
  // growing after the first paint. An expanded box has no cut to compare
  // with, so it keeps the last answer and the button stays under the reader.
  useLayoutEffect(() => {
    const cut = cutRef.current;
    const content = contentRef.current;
    if (!cut || !content || expanded) return;
    // Unfolded, the cut is already SLACK_REM taller; folded, it is not.
    const slack = SLACK_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const measure = () => {
      if (rows === undefined) {
        setOverflows((folded) => content.offsetHeight > cut.clientHeight + (folded ? slack : 0) + 1);
        return;
      }
      const list = content.firstElementChild;
      const next = list ? rowCut(list, rows) : null;
      setListCut(next);
      setOverflows(next !== null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, rows]);

  let style: CSSProperties | undefined;
  if (!expanded && rows !== undefined) {
    style = listCut
      ? {
          maxHeight: listCut.height,
          overflow: 'hidden',
          maskImage: `linear-gradient(#000 ${listCut.fadeFrom}px, transparent ${listCut.height}px)`
        }
      : undefined;
  } else if (!expanded) {
    style = { maxHeight: overflows ? maxHeight : `calc(${maxHeight} + ${SLACK_REM}rem)`, overflow: 'hidden' };
  }

  return (
    <div className={className}>
      <div
        ref={cutRef}
        className={overflows && !expanded && rows === undefined ? 'folded-box is-cut' : undefined}
        style={style}
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
          className="btn btn-link btn-sm mt-1 folded-box-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
