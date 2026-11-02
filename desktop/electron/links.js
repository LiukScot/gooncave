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

module.exports = { isAppUri };
