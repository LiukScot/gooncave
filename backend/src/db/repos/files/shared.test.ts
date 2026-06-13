import assert from 'node:assert/strict';

import { Database } from 'bun:sqlite';
import { test } from 'bun:test';

import { buildFileOrder } from './shared';

const SAMPLE_IDS = [
  '1aa7b2db-74b6-4f53-8a36-34c7dc3ca247',
  '2f8a4ed3-1f5f-493f-a680-6b884919d2e9',
  '37a26c0d-26be-4517-89f5-3521f39ef85e',
  '43e37b89-e97f-4f3a-b493-4fca607b9d4d',
  '56f5935a-6ca4-456b-9d5f-8c7f1f27cb09',
  '60ec4cd2-9fd0-4617-b8ef-72d15dbdb4d0',
  '74a5ef3c-a01f-4cf2-9de9-734bd5fb2dce',
  '8e2f94cd-a8e9-4903-95fe-02c1ac3ce0bb',
  '9a4e76df-3e9c-4fda-b9bf-9cd2d9d60dbf',
  'b7fa2cde-43d5-4fce-b28d-2d24ff37d6ac'
];

const orderedIdsForSeed = (seed: string) => {
  const db = new Database(':memory:');
  const values = SAMPLE_IDS.map(() => '(?)').join(', ');
  const order = buildFileOrder('random', seed);
  const rows = db
    .query(
      `WITH input(id) AS (VALUES ${values}) SELECT f.id FROM input f ORDER BY ${order.clause}`
    )
    .all(...SAMPLE_IDS, ...order.params) as { id: string }[];
  db.close();
  return rows.map((row) => row.id);
};

test('buildFileOrder(random) is deterministic for the same seed', () => {
  const first = orderedIdsForSeed('stable-seed');
  const second = orderedIdsForSeed('stable-seed');
  assert.deepEqual(first, second);
});

test('buildFileOrder(random) changes order when seed changes for UUID text ids', () => {
  const alpha = orderedIdsForSeed('alpha-seed');
  const beta = orderedIdsForSeed('beta-seed');
  assert.notDeepEqual(alpha, beta);
});
