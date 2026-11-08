import { describe, expect, it } from 'vitest';

import { fittedRect } from './freezePictures';

describe('fittedRect', () => {
  const box = { width: 100, height: 100 };
  const wide = { width: 400, height: 200 };

  it('crops a wide picture on both sides to cover a square box', () => {
    expect(fittedRect(box, wide, 'cover', '50% 50%')).toEqual({ x: -50, y: 0, width: 200, height: 100 });
  });

  it('keeps the top of a strip when the position says so', () => {
    const drawn = fittedRect(box, { width: 100, height: 400 }, 'cover', '50% 0%');
    expect(drawn.y).toBeCloseTo(0);
    expect(drawn.height).toBe(400);
  });

  it('fits a wide picture inside a square box with bands above and below', () => {
    expect(fittedRect(box, wide, 'contain', '50% 50%')).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it('stretches to the box when nothing says how to fit', () => {
    expect(fittedRect(box, wide, 'fill', '50% 50%')).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});
