import { expect, it } from 'vitest';

import { noPreviewReason } from './noPreview';

const video = (
  path: string,
  locationType: 'LOCAL' | 'REMOTE' = 'LOCAL',
  extra: { favoriteProviders?: string[]; previewProblem?: string } = {}
) => ({ path, mediaType: 'VIDEO', locationType, ...extra }) as const;

it('names the extension iPhone cannot read, and only on iPhone', () => {
  expect(noPreviewReason(video('/a/clip.WEBM'), true)).toContain('.webm');
  expect(noPreviewReason(video('/a/clip.webm'), false)).toBe('No preview yet. Open the video to watch it.');
});

it('says where a video missing here comes from, never another device', () => {
  expect(noPreviewReason(video('/a/clip.mp4', 'REMOTE', { favoriteProviders: ['e621'] }), true)).toContain('from the site');
  expect(noPreviewReason(video('/a/clip.mp4', 'REMOTE'), true)).toContain('not on this device');
});

it('repeats why the site gave no preview', () => {
  const problem = 'e621 is not answering, so the preview could not be downloaded.';
  expect(noPreviewReason(video('/a/clip.mp4', 'REMOTE', { favoriteProviders: ['e621'], previewProblem: problem }), true)).toBe(problem);
});

it('has nothing to say about a picture, unless its site gave no preview', () => {
  expect(noPreviewReason({ path: '/a/p.png', mediaType: 'IMAGE', locationType: 'LOCAL' }, true)).toBeNull();
  const problem = 'e621 no longer has this post, so there is no preview.';
  expect(
    noPreviewReason({ path: '/a/p.png', mediaType: 'IMAGE', locationType: 'REMOTE', previewProblem: problem }, true)
  ).toBe(problem);
});
