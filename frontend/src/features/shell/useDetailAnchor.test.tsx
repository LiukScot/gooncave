// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { useDetailAnchor } from './useDetailAnchor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mount = () => {
  const out = {} as ReturnType<typeof useDetailAnchor>;
  function Harness({ id }: { id: string | null }) {
    const anchor = useDetailAnchor();
    anchor.track(id);
    Object.assign(out, anchor);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (id: string | null) =>
    act(() => root.render(<Harness id={id} />));
  return { out, render };
};

describe('useDetailAnchor', () => {
  it('keeps the original file as the anchor while a page is shown aside', () => {
    const { out, render } = mount();
    render('a');
    expect(out.anchorRef.current).toBe('a');

    out.markAside('pool-page');
    render('a'); // a render before the file actually changes
    render('pool-page');
    expect(out.anchorRef.current).toBe('a');

    out.markAside('pool-page-2');
    render('pool-page-2');
    expect(out.anchorRef.current).toBe('a');
  });

  it('moves the anchor when the reader opens another file', () => {
    const { out, render } = mount();
    render('a');
    out.markAside('pool-page');
    render('pool-page');
    render('b');
    expect(out.anchorRef.current).toBe('b');
  });

  it('clears the anchor when the detail view closes', () => {
    const { out, render } = mount();
    render('a');
    render(null);
    expect(out.anchorRef.current).toBeNull();
  });
});
