import { describe, expect, it } from 'vitest';

import { detailBack } from './detailBack';

describe('detailBack', () => {
  it('returns to the pool before anything else', () => {
    expect(detailBack({ inPool: true, excursion: { returnsByBack: true }, entryPushed: true }))
      .toEqual({ to: 'pool' });
  });

  it('returns from an excursion to where it started, by history only when that is the entry before', () => {
    expect(detailBack({ inPool: false, excursion: { returnsByBack: true }, entryPushed: true }))
      .toEqual({ to: 'excursion', byHistory: true });
    expect(detailBack({ inPool: false, excursion: {}, entryPushed: true }))
      .toEqual({ to: 'excursion', byHistory: false });
  });

  it('goes back one entry to the results only when opening the post pushed one', () => {
    expect(detailBack({ inPool: false, excursion: null, entryPushed: true })).toEqual({ to: 'pushed' });
    expect(detailBack({ inPool: false, excursion: null, entryPushed: false })).toEqual({ to: 'grid' });
  });
});
