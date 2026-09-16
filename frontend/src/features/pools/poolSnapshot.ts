import type { PoolPage } from '@/api';

export type PoolSnapshot = {
  siteId: string;
  poolId: string;
  pages: PoolPage[];
  scrollY: number;
};

let snapshot: PoolSnapshot | null = null;

export const readPoolSnapshot = (
  siteId: string,
  poolId: string
): PoolSnapshot | null =>
  snapshot?.siteId === siteId && snapshot.poolId === poolId ? snapshot : null;

export const writePoolSnapshot = (next: PoolSnapshot): void => {
  snapshot = next;
};
