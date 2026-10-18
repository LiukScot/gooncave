/**
 * iPhone's web view never opens a `target="_blank"` link: it asks for a new
 * window the shell cannot give. Navigating in place instead reaches the shell's
 * navigation handler, which opens the address in Safari and keeps the app page.
 */
export const installExternalLinks = (
  root: Document,
  navigate: (url: string) => void = (url) => window.location.assign(url)
) => {
  root.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const link = (event.target as Element | null)?.closest?.('a[target="_blank"]');
    if (!(link instanceof HTMLAnchorElement) || !/^https?:$/.test(link.protocol)) return;
    event.preventDefault();
    navigate(link.href);
  });
};
