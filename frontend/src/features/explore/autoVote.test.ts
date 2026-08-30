import { describe, expect, it } from 'vitest';

import { shouldAutoVote } from './autoVote';

describe('shouldAutoVote', () => {
  it('votes on a fresh favorite when the booru allows it', () => {
    expect(shouldAutoVote(true, true, null)).toBe(true);
  });

  it('flips a downvote up rather than leaving it', () => {
    expect(shouldAutoVote(true, true, -1)).toBe(true);
  });

  it('leaves a post that is already voted up alone', () => {
    expect(shouldAutoVote(true, true, 1)).toBe(false);
  });

  it('stays out of the way when the setting is off', () => {
    expect(shouldAutoVote(false, true, null)).toBe(false);
  });

  it('stays out of the way when the booru has no voting', () => {
    expect(shouldAutoVote(true, false, null)).toBe(false);
  });
});
