import { expect, it } from 'vitest';

import { noPreviewReason } from './noPreview';

const video = (path: string, locationType: 'LOCAL' | 'REMOTE' = 'LOCAL') =>
  ({ path, mediaType: 'VIDEO', locationType }) as const;

it('names the extension iPhone cannot read, and only on iPhone', () => {
  expect(noPreviewReason(video('/a/clip.WEBM'), true)).toContain('.webm');
  expect(noPreviewReason(video('/a/clip.webm'), false)).toBe('No preview yet. Open the video to watch it.');
});

it('says the device with the original makes the preview when the video is not here', () => {
  expect(noPreviewReason(video('/a/clip.mp4', 'REMOTE'), true)).toContain('The device that has the video');
});

it('has nothing to say about a picture', () => {
  expect(noPreviewReason({ path: '/a/p.png', mediaType: 'IMAGE', locationType: 'LOCAL' }, true)).toBeNull();
});
