// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exploreDetailTags: vi.fn()
}));

vi.mock('@/api', () => ({
  api: { exploreDetailTags: mocks.exploreDetailTags },
  API_BASE: '/api'
}));

import {
  loadFurAffinityGridPreview,
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
const images: FakeImage[] = [];

class FakeImage {
  decoding = '';
  referrerPolicy = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    images.push(this);
  }

  set src(value: string) {
    imageSources.push(value);
  }
}

afterEach(() => {
  vi.clearAllMocks();
  imageSources.length = 0;
  images.length = 0;
});

describe('FurAffinity detail preloading', () => {
  it('loads full grid previews only two at a time and shares repeated requests', async () => {
    mocks.exploreDetailTags.mockImplementation(async (_siteId: string, remoteId: string) => ({
      tags: [],
      fileUrl: `https://d.furaffinity.net/${remoteId}.png`
    }));
    vi.stubGlobal('Image', FakeImage);

    const first = loadFurAffinityGridPreview(post('grid-1'));
    const repeated = loadFurAffinityGridPreview(post('grid-1'));
    const second = loadFurAffinityGridPreview(post('grid-2'));
    const third = loadFurAffinityGridPreview(post('grid-3'));
    expect(repeated).toBe(first);
    await vi.waitFor(() => expect(imageSources).toHaveLength(2));
    expect(mocks.exploreDetailTags).toHaveBeenCalledTimes(2);

    images[0].onload?.();
    await vi.waitFor(() => expect(imageSources).toHaveLength(3));
    images[1].onload?.();
    images[2].onload?.();
    expect(await Promise.all([first, second, third])).toEqual([
      'https://d.furaffinity.net/grid-1.png',
      'https://d.furaffinity.net/grid-2.png',
      'https://d.furaffinity.net/grid-3.png'
    ]);
  });

  it('skips a queued preview when its card disappears', async () => {
    mocks.exploreDetailTags.mockImplementation(async (_siteId: string, remoteId: string) => ({
      tags: [],
      fileUrl: `https://d.furaffinity.net/${remoteId}.png`
    }));
    vi.stubGlobal('Image', FakeImage);
    const first = loadFurAffinityGridPreview(post('cancel-1'));
    const second = loadFurAffinityGridPreview(post('cancel-2'));
    const controller = new AbortController();
    const queued = loadFurAffinityGridPreview(post('cancel-3'), controller.signal);
    await vi.waitFor(() => expect(imageSources).toHaveLength(2));
    controller.abort();
    expect(await queued).toBeNull();
    images[0].onload?.();
    images[1].onload?.();
    await Promise.all([first, second]);
    expect(mocks.exploreDetailTags).toHaveBeenCalledTimes(2);
  });

  it('releases an active preview slot when its card disappears', async () => {
    mocks.exploreDetailTags.mockImplementation(async (_siteId: string, remoteId: string) => ({
      tags: [],
      fileUrl: `https://d.furaffinity.net/${remoteId}.png`
    }));
    vi.stubGlobal('Image', FakeImage);
    const controller = new AbortController();
    const first = loadFurAffinityGridPreview(post('active-1'), controller.signal);
    const second = loadFurAffinityGridPreview(post('active-2'));
    const third = loadFurAffinityGridPreview(post('active-3'));
    await vi.waitFor(() => expect(imageSources).toHaveLength(2));
    controller.abort();
    expect(await first).toBeNull();
    await vi.waitFor(() => expect(images).toHaveLength(3));
    images[1].onload?.();
    images[2].onload?.();
    expect(await Promise.all([second, third])).toEqual([
      'https://d.furaffinity.net/active-2.png',
      'https://d.furaffinity.net/active-3.png'
    ]);
  });

  it('keeps a shared preview loading while another card still needs it', async () => {
    mocks.exploreDetailTags.mockResolvedValue({
      tags: [], fileUrl: 'https://d.furaffinity.net/shared.png'
    });
    vi.stubGlobal('Image', FakeImage);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = loadFurAffinityGridPreview(post('shared'), firstController.signal);
    const second = loadFurAffinityGridPreview(post('shared'), secondController.signal);
    await vi.waitFor(() => expect(images).toHaveLength(1));
    firstController.abort();
    expect(await first).toBeNull();
    images[0].onload?.();
    expect(await second).toBe('https://d.furaffinity.net/shared.png');
    expect(mocks.exploreDetailTags).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh preview when a card remounts after cancelling', async () => {
    let resolveDetails!: (value: { tags: []; fileUrl: string }) => void;
    mocks.exploreDetailTags.mockReturnValue(new Promise((resolve) => {
      resolveDetails = resolve;
    }));
    vi.stubGlobal('Image', FakeImage);
    const controller = new AbortController();
    const cancelled = loadFurAffinityGridPreview(post('remount'), controller.signal);
    await vi.waitFor(() => expect(mocks.exploreDetailTags).toHaveBeenCalledOnce());
    controller.abort();
    expect(await cancelled).toBeNull();

    const remounted = loadFurAffinityGridPreview(post('remount'));
    resolveDetails({ tags: [], fileUrl: 'https://d.furaffinity.net/remount.png' });
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onload?.();
    expect(await remounted).toBe('https://d.furaffinity.net/remount.png');
  });

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

  it('preloads a proxied original from the API origin', async () => {
    mocks.exploreDetailTags.mockResolvedValue({
      tags: [],
      fileUrl: '/explore/media?u=original&s=signature'
    });
    vi.stubGlobal('Image', FakeImage);

    await preloadFurAffinityImage(post('proxied'));

    expect(imageSources).toEqual([
      '/api/explore/media?u=original&s=signature'
    ]);
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
