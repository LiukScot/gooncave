// Calendar maths for the popular date picker. No network, no DB.
import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { dateMetatag, shiftAnchor, todayIso, windowRange } from './windowRange';

test('windowRange day is the anchor itself', () => {
  assert.deepEqual(windowRange('day', '2026-08-28'), {
    start: '2026-08-28',
    end: '2026-08-28'
  });
});

test('windowRange week runs Monday to Sunday around the anchor', () => {
  // 2026-08-28 is a Friday.
  assert.deepEqual(windowRange('week', '2026-08-28'), {
    start: '2026-08-24',
    end: '2026-08-30'
  });
  // A Sunday belongs to the week that started the previous Monday.
  assert.deepEqual(windowRange('week', '2026-08-30'), {
    start: '2026-08-24',
    end: '2026-08-30'
  });
});

test('windowRange month covers the whole calendar month', () => {
  assert.deepEqual(windowRange('month', '2026-08-28'), {
    start: '2026-08-01',
    end: '2026-08-31'
  });
  // February, and a leap one at that.
  assert.deepEqual(windowRange('month', '2028-02-10'), {
    start: '2028-02-01',
    end: '2028-02-29'
  });
});

test('shiftAnchor steps by calendar unit', () => {
  assert.equal(shiftAnchor('day', '2026-08-01', -1), '2026-07-31');
  assert.equal(shiftAnchor('week', '2026-08-28', 1), '2026-09-04');
  assert.equal(shiftAnchor('month', '2026-08-28', -1), '2026-07-28');
});

test('shiftAnchor clamps a month step onto a shorter month', () => {
  // Stepping back from the 31st must not skip February entirely.
  assert.equal(shiftAnchor('month', '2026-03-31', -1), '2026-02-28');
  assert.equal(shiftAnchor('month', '2026-01-31', 1), '2026-02-28');
});

test('todayIso reads the date in UTC', () => {
  assert.equal(todayIso(new Date('2026-08-28T23:30:00.000Z')), '2026-08-28');
});

test('dateMetatag writes a single day as one date, not an empty range', () => {
  // e621 returns nothing for `date:X..X`, so the one-day case must collapse.
  assert.equal(
    dateMetatag({ start: '2026-08-20', end: '2026-08-20' }),
    'date:2026-08-20'
  );
  assert.equal(
    dateMetatag({ start: '2026-08-24', end: '2026-08-30' }),
    'date:2026-08-24..2026-08-30'
  );
});
