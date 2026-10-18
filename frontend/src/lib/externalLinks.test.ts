// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest';

import { installExternalLinks } from './externalLinks';

const click = (html: string) => {
  document.body.innerHTML = html;
  const navigate = vi.fn();
  installExternalLinks(document, navigate);
  document.querySelector<HTMLElement>('[data-hit]')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true })
  );
  return navigate;
};

it('opens a new-window link by navigating in place', () => {
  const navigate = click('<a target="_blank" href="https://e621.net/posts/1"><span data-hit>post</span></a>');
  expect(navigate).toHaveBeenCalledWith('https://e621.net/posts/1');
});

it('leaves links without a new-window target alone', () => {
  expect(click('<a href="https://e621.net/posts/1" data-hit>post</a>')).not.toHaveBeenCalled();
});
