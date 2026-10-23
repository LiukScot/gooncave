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

/** The folder an `{origin}/open-folder?path=…` link asks to show in the file manager. */
const openFolderPath = (uri, origin) => {
  const prefix = `${origin}/open-folder?path=`;
  if (!uri.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(uri.slice(prefix.length));
  } catch (error) {
    console.error(`Cannot read the folder in ${uri}: ${error}`);
    return null;
  }
};

module.exports = { isAppUri, openFolderPath };
