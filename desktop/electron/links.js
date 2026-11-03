/**
 * Whether a navigation stays inside the app: its own pages, and the blob: URLs the page
 * makes for downloads, which carry the same origin.
 */
const isAppUri = (uri, origin) => {
  const rest = uri.startsWith('blob:') ? uri.slice(5) : uri;
  if (!rest.startsWith(origin)) return false;
  const after = rest.slice(origin.length);
  return after === '' || after.startsWith('/');
};

/**
 * Where a link from the page leads. A page cannot open file:// links, so it asks for a folder
 * with an `{origin}/open-folder?path=…` link: that one has the app's origin, and is checked
 * first so it does not load inside the window.
 */
const linkTarget = (uri, origin) => {
  const prefix = `${origin}/open-folder?path=`;
  if (uri.startsWith(prefix)) {
    try {
      return { kind: 'folder', path: decodeURIComponent(uri.slice(prefix.length)) };
    } catch (error) {
      console.error(`Cannot read the folder in ${uri}: ${error}`);
      return { kind: 'none' };
    }
  }
  return { kind: isAppUri(uri, origin) ? 'app' : 'outside' };
};

module.exports = { isAppUri, linkTarget };
