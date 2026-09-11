// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exploreDetailTags: vi.fn()
}));

vi.mock('@/api', () => ({
  api: { exploreDetailTags: mocks.exploreDetailTags }
}));

import {
  loadExplorePostDetails,
  preloadAdjacentFurAffinityImages,
  preloadFurAffinityImage
} from './explorePostDetails';

import type { ExplorePost } from '@/api';

const post = (remoteId: string): ExplorePost => ({
  remoteId,
  previewUrl: `https://t.furaffinity.net/${remoteId}.jpg`,
  sampleUrl: null,
  fileUrl: null,
  width: null,
  height: null,
  score: null,
  rating: null,
  md5: null,
  createdAt: null,
  tags: [],
  favCount: null,
  uploader: null,
  fileExt: null,
  fileSize: null,
  favorited: false,
  voted: null,
  siteId: 'fa',
  siteName: 'FurAffinity',
  engine: 'furaffinity',
  sourceUrl: `https://www.furaffinity.net/view/${remoteId}/`,
  parentId: null,
  hasChildren: false,
  poolIds: []
});

const imageSources: string[] = [];

class FakeImage {
  decoding = '';
  referrerPolicy = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(value: string) {
    imageSources.push(value);
  }
}

afterEach(() => {
  vi.clearAllMocks();
  imageSources.length = 0;
});

describe('FurAffinity detail preloading', () => {
  it('preloads a neighbour and reuses its resolved details when opened', async () => {
    mocks.exploreDetailTags.mockResolvedValue({
      tags: [{ tag: 'artist', category: 'artist' }],
      fileUrl: 'https://d.furaffinity.net/art/artist/full.png'
    });
    vi.stubGlobal('Image', FakeImage);
    const neighbour = post('101');

    await preloadFurAffinityImage(neighbour);
    const details = await loadExplorePostDetails(neighbour);

    expect(mocks.exploreDetailTags).toHaveBeenCalledTimes(1);
    expect(mocks.exploreDetailTags).toHaveBeenCalledWith('fa', '101');
    expect(imageSources).toEqual([
      'https://d.furaffinity.net/art/artist/full.png'
    ]);
    expect(details.tags).toEqual([{ tag: 'artist', category: 'artist' }]);
  });

  it('evicts a failed detail request so a later navigation can retry', async () => {
    mocks.exploreDetailTags
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ tags: [], fileUrl: null });
    const neighbour = post('102');

    await expect(loadExplorePostDetails(neighbour)).rejects.toThrow(
      'temporary failure'
    );
    await expect(loadExplorePostDetails(neighbour)).resolves.toEqual({
      tags: [],
      fileUrl: null
    });

    expect(mocks.exploreDetailTags).toHaveBeenCalledTimes(2);
  });

  it('does not resolve posts that already expose media or use another engine', async () => {
    await preloadFurAffinityImage({
      ...post('103'),
      engine: 'danbooru'
    });
    await preloadFurAffinityImage({
      ...post('104'),
      fileUrl: 'https://d.furaffinity.net/already-known.png'
    });

    expect(mocks.exploreDetailTags).not.toHaveBeenCalled();
  });

  it('resolves the visible post before preloading both adjacent posts', async () => {
    mocks.exploreDetailTags
      .mockResolvedValueOnce({ tags: [], fileUrl: null })
      .mockRejectedValueOnce(new Error('next unavailable'))
      .mockResolvedValueOnce({
        tags: [],
        fileUrl: 'https://d.furaffinity.net/art/artist/previous.png'
      });
    vi.stubGlobal('Image', FakeImage);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await preloadAdjacentFurAffinityImages(
      post('105'),
      post('106'),
      post('107')
    );

    expect(mocks.exploreDetailTags).toHaveBeenCalledTimes(3);
    expect(mocks.exploreDetailTags).toHaveBeenNthCalledWith(1, 'fa', '105');
    expect(mocks.exploreDetailTags).toHaveBeenNthCalledWith(2, 'fa', '106');
    expect(mocks.exploreDetailTags).toHaveBeenNthCalledWith(3, 'fa', '107');
    expect(imageSources).toEqual([
      'https://d.furaffinity.net/art/artist/previous.png'
    ]);
    expect(warning).toHaveBeenCalledWith(
      '[explore] FurAffinity neighbour preload failed for 106: next unavailable'
    );
  });
});
