import { expect, it } from 'vitest';

import { useExploreUiStore } from './exploreUiStore';

it('resetExploreUiState forgets the open post and pool of the signed-out user', () => {
  const store = useExploreUiStore.getState();
  store.setPoolOrigin('/app/explore');
  store.setPoolContext({ siteId: 's', poolId: 'p', postIds: ['1'], posts: [] });

  useExploreUiStore.getState().resetExploreUiState();

  const after = useExploreUiStore.getState();
  expect(after.poolOrigin).toBeNull();
  expect(after.poolContext).toBeNull();
  expect(after.pendingPost).toBeNull();
  expect(after.detailNav).toBeNull();
});
