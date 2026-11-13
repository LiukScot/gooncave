import { describe, expect, it } from 'vitest';

import { postLinkTarget } from './postLink';

import type { BooruSite } from '@/api';

const site = (
  id: string,
  engine: BooruSite['engine'],
  baseUrl: string
): Pick<BooruSite, 'id' | 'engine' | 'baseUrl'> => ({ id, engine, baseUrl });

const sites = [
  site('danbooru-site', 'danbooru', 'https://danbooru.donmai.us'),
  site('e621-site', 'e621', 'https://e621.net'),
  site('gelbooru-site', 'gelbooru', 'https://api.rule34.xxx'),
  site('moebooru-site', 'moebooru', 'https://yande.re'),
  site('sankaku-site', 'sankaku', 'https://chan.sankakucomplex.com'),
  site('philomena-site', 'philomena', 'https://derpibooru.org'),
  site('shimmie-site', 'shimmie', 'https://shimmie.example'),
  site('szurubooru-site', 'szurubooru', 'https://booru.example'),
  site('furaffinity-site', 'furaffinity', 'https://furaffinity.net')
];

describe('postLinkTarget', () => {
  it('reads a danbooru post path', () => {
    expect(postLinkTarget('https://danbooru.donmai.us/posts/101', sites)).toEqual({
      siteId: 'danbooru-site',
      remoteId: '101'
    });
  });

  it('reads an e621 post path', () => {
    expect(postLinkTarget('https://e621.net/posts/202', sites)).toEqual({
      siteId: 'e621-site',
      remoteId: '202'
    });
  });

  it('reads a gelbooru post from its query string', () => {
    expect(
      postLinkTarget('https://api.rule34.xxx/index.php?page=post&s=view&id=303', sites)
    ).toEqual({ siteId: 'gelbooru-site', remoteId: '303' });
  });

  it('reads a moebooru post path', () => {
    expect(postLinkTarget('https://yande.re/post/show/404', sites)).toEqual({
      siteId: 'moebooru-site',
      remoteId: '404'
    });
  });

  it('reads both sankaku post paths', () => {
    expect(postLinkTarget('https://chan.sankakucomplex.com/post/show/505', sites)).toEqual({
      siteId: 'sankaku-site',
      remoteId: '505'
    });
    expect(postLinkTarget('https://chan.sankakucomplex.com/posts/505', sites)).toEqual({
      siteId: 'sankaku-site',
      remoteId: '505'
    });
  });

  it('reads a philomena post by number and by images path', () => {
    expect(postLinkTarget('https://derpibooru.org/606', sites)).toEqual({
      siteId: 'philomena-site',
      remoteId: '606'
    });
    expect(postLinkTarget('https://derpibooru.org/images/707', sites)).toEqual({
      siteId: 'philomena-site',
      remoteId: '707'
    });
  });

  it('reads a shimmie post path', () => {
    expect(postLinkTarget('https://shimmie.example/post/view/808', sites)).toEqual({
      siteId: 'shimmie-site',
      remoteId: '808'
    });
  });

  it('reads a szurubooru post path', () => {
    expect(postLinkTarget('https://booru.example/post/909', sites)).toEqual({
      siteId: 'szurubooru-site',
      remoteId: '909'
    });
  });

  it('reads a furaffinity view path with a trailing slash', () => {
    expect(postLinkTarget('https://www.furaffinity.net/view/1010/', sites)).toEqual({
      siteId: 'furaffinity-site',
      remoteId: '1010'
    });
  });

  it('ignores a www prefix on the link', () => {
    expect(postLinkTarget('https://www.e621.net/posts/12/', sites)).toEqual({
      siteId: 'e621-site',
      remoteId: '12'
    });
  });

  it('returns null for a host that is not a configured site', () => {
    expect(postLinkTarget('https://example.org/posts/12', sites)).toBeNull();
  });

  it('returns null for a tag string', () => {
    expect(postLinkTarget('cat dog', sites)).toBeNull();
  });

  it('returns null for a search page on a configured site', () => {
    expect(postLinkTarget('https://e621.net/posts?tags=cat', sites)).toBeNull();
  });

  it('returns null for an id with characters outside the core rule', () => {
    expect(postLinkTarget('https://e621.net/posts/1%202', sites)).toBeNull();
  });
});
