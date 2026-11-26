import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** How fast the text travels while it scrolls. */
const PIXELS_PER_SECOND = 40;
/** Share of each pass spent still at either end, so both ends can be read. */
const PAUSE_SHARE = 0.3;

/**
 * One line of text. When it is longer than its box it scrolls to its end and back, again and
 * again; with reduced motion it ends in an ellipsis instead, and the whole text is its tooltip.
 */
export function MarqueeText({ children }: { children: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text) return;
    const measure = () => setOverflow(Math.max(0, Math.ceil(text.scrollWidth - box.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children]);

  const style = overflow
    ? ({
        '--marquee-distance': `${overflow}px`,
        '--marquee-duration': `${overflow / PIXELS_PER_SECOND / (1 - PAUSE_SHARE)}s`
      } as CSSProperties)
    : undefined;
  return (
    <span
      ref={boxRef}
      className={`marquee${overflow ? ' is-overflowing' : ''}`}
      title={overflow ? children : undefined}
      style={style}
    >
      <span ref={textRef} className="marquee-text">{children}</span>
    </span>
  );
}
