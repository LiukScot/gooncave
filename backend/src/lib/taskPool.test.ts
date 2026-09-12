import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { createTaskPool, mapWithConcurrency } from './taskPool';

test('mapWithConcurrency preserves order while bounding active work', async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

test('createTaskPool propagates task failures after draining active work', async () => {
  const pool = createTaskPool(2);
  await pool.run(async () => Bun.sleep(5));
  await pool.run(async () => {
    throw new Error('broken task');
  });
  await assert.rejects(pool.drain(), /broken task/);
});
