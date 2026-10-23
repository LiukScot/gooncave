// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ExploreCard } from './ExploreView';

import type { ExplorePost } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let observers: {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
}[] = [];
// The card watches the viewport twice: closely to pause media, widely to release it.
const closeObserver = () =>
  observers.findLast((observer) => observer.options?.rootMargin === '220px 0px');
const wideObserver = () =>
  observers.findLast(
    (observer) => observer.options?.rootMargin === `${window.innerHeight}px 0px`
  );

class IntersectionObserverMock implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0];

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    observers.push({ callback, options });
  }

  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

Object.assign(globalThis, { IntersectionObserver: IntersectionObserverMock });

const post: ExplorePost = {
  remoteId: '123',
  previewUrl: 'https://static.example/123.jpg',
  sampleUrl: null,
  fileUrl: 'https://static.example/123.jpg',
  width: 100,
  height: 100,
  score: 42,
  rating: null,
  md5: null,
  createdAt: null,
  tags: [],
  favCount: null,
  uploader: null,
  fileExt: 'jpg',
  fileSize: null,
  favorited: false,
  voted: null,
  siteId: 'e621',
  siteName: 'e621',
  engine: 'e621',
  sourceUrl: 'https://e621.net/posts/123',
  parentId: null,
  hasChildren: false,
  poolIds: []
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  observers = [];
});

it('combines the Explore upvote and score without exposing a downvote', async () => {
  const onVote = vi.fn();
  const onOpen = vi.fn();
  const container = document.createElement('div');
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[post]}
        hasRelations={() => true}
        supportsVote={() => true}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => null}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => ['red_fox']}
        onOpen={onOpen}
        onVote={onVote}
        onFavorite={() => undefined}
      />
    );
  });

  const upvote = container.querySelector<HTMLButtonElement>(
    '[data-test-id="explore-upvote"]'
  );
  expect(upvote?.getAttribute('aria-label')).toBe('Upvote; score 42');
  expect(upvote?.textContent).toContain('42');
  expect(container.querySelector('[data-test-id="explore-subscription-reasons"]'))
    .not.toBeNull();
  expect(container.querySelector('button[aria-label="Vote down"]')).toBeNull();
  const relations = container.querySelector(
    '[data-test-id="explore-relations"]'
  );
  expect(relations?.closest('.explore-card-bottom-left')).not.toBeNull();
  expect(upvote?.closest('.explore-card-actions')).not.toBeNull();
  expect(upvote?.nextElementSibling?.getAttribute('aria-label'))
    .toBe('Favorite and save');

  await act(async () => upvote?.click());
  expect(onVote).toHaveBeenCalledWith(post, 1);
  expect(onOpen).not.toHaveBeenCalled();
});

it('marks a completed upvote with the voted visual state', async () => {
  const container = document.createElement('div');
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[post]}
        hasRelations={() => false}
        supportsVote={() => true}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => 1}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => null}
        onOpen={() => undefined}
        onVote={() => undefined}
        onFavorite={() => undefined}
      />
    );
  });

  const upvote = container.querySelector<HTMLButtonElement>(
    '[data-test-id="explore-upvote"]'
  );
  expect(upvote?.classList.contains('is-voted')).toBe(true);
  expect(upvote?.getAttribute('aria-pressed')).toBe('true');
  expect(upvote?.getAttribute('aria-label')).toBe('Undo upvote; score 42');
});

it('shows neither a vote button nor a score when the site cannot vote', async () => {
  const container = document.createElement('div');
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[post]}
        hasRelations={() => false}
        supportsVote={() => false}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => null}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => null}
        onOpen={() => undefined}
        onVote={() => undefined}
        onFavorite={() => undefined}
      />
    );
  });

  expect(container.querySelector('[data-test-id="explore-upvote"]')).toBeNull();
  expect(container.querySelector('.explore-card-actions')?.textContent).toBe('');
});

it('plays a video inline without opening the post', async () => {
  const onOpen = vi.fn();
  const container = document.createElement('div');
  root = createRoot(container);
  const videoPost = {
    ...post,
    fileUrl: 'https://static.example/123.webm',
    fileExt: 'webm'
  };

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[videoPost]}
        hasRelations={() => false}
        supportsVote={() => false}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => null}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => null}
        onOpen={onOpen}
        onVote={() => undefined}
        onFavorite={() => undefined}
      />
    );
  });

  const play = container.querySelector<HTMLButtonElement>(
    '[data-test-id="explore-video-play"]'
  );
  expect(play?.getAttribute('aria-label')).toBe('Play video 123 from e621');

  await act(async () => play?.click());

  const video = container.querySelector<HTMLVideoElement>(
    '[data-test-id="explore-inline-video"]'
  );
  expect(video?.src).toBe('https://static.example/123.webm');
  expect(video?.autoplay).toBe(true);
  expect(video?.muted).toBe(true);
  // Only the app's own play/pause and time track, not the browser's bar.
  expect(video?.controls).toBe(false);
  expect(container.querySelector('[aria-label="Pause"]')).not.toBeNull();
  expect(container.querySelector('input[aria-label="Seek"]')).not.toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
  // The picture itself is the way to the post's page.
  await act(async () => video?.click());
  expect(onOpen).toHaveBeenCalledWith(videoPost);
});

it('pauses an inline video when it leaves the viewport', async () => {
  const container = document.createElement('div');
  root = createRoot(container);
  const videoPost = {
    ...post,
    fileUrl: 'https://static.example/123.webm',
    fileExt: 'webm'
  };

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[videoPost]}
        hasRelations={() => false}
        supportsVote={() => false}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => null}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => null}
        onOpen={() => undefined}
        onVote={() => undefined}
        onFavorite={() => undefined}
      />
    );
  });

  await act(async () => {
    container.querySelector<HTMLButtonElement>(
      '[data-test-id="explore-video-play"]'
    )?.click();
  });

  const video = container.querySelector<HTMLVideoElement>(
    '[data-test-id="explore-inline-video"]'
  );
  const pause = vi.spyOn(video!, 'pause').mockImplementation(() => undefined);
  expect(closeObserver()).toBeDefined();

  await act(async () => {
    closeObserver()?.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });

  expect(pause).toHaveBeenCalledOnce();
});

it('swaps an offscreen gif for its static sample', async () => {
  const container = document.createElement('div');
  root = createRoot(container);
  const gifPost = {
    ...post,
    sampleUrl: 'https://static.example/123-sample.jpg',
    fileUrl: 'https://static.example/123.gif',
    fileExt: 'gif'
  };

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[gifPost]}
        hasRelations={() => false}
        supportsVote={() => false}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => null}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => null}
        onOpen={() => undefined}
        onVote={() => undefined}
        onFavorite={() => undefined}
      />
    );
  });

  expect(container.querySelector<HTMLImageElement>('img')?.src).toBe(
    'https://static.example/123.gif'
  );

  await act(async () => {
    closeObserver()?.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });

  expect(container.querySelector<HTMLImageElement>('img')?.src).toBe(
    'https://static.example/123-sample.jpg'
  );
});

it('releases the image of a card far from the viewport and keeps its height', async () => {
  const container = document.createElement('div');
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <ExploreCard
        posts={[post]}
        hasRelations={() => false}
        supportsVote={() => false}
        canFavorite={() => true}
        favorited={() => false}
        voted={() => null}
        voteBusy={() => false}
        favoriteBusy={() => false}
        sourceIcon={() => ({ key: 'e621', label: 'e621', iconUrl: null })}
        subscriptionReasons={() => null}
        onOpen={() => undefined}
        onVote={() => undefined}
        onFavorite={() => undefined}
      />
    );
  });
  expect(container.querySelector('img')).not.toBeNull();

  const away = (isIntersecting: boolean) =>
    act(async () => {
      wideObserver()?.callback(
        [
          {
            isIntersecting,
            boundingClientRect: { height: 312 }
          } as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
  await away(false);
  expect(container.querySelector('img')).toBeNull();
  expect(
    container.querySelector<HTMLElement>('[data-test-id="explore-card-placeholder"]')
      ?.style.height
  ).toBe('312px');

  await away(true);
  expect(container.querySelector('img')).not.toBeNull();
});
