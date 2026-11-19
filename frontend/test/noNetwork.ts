// Unit tests run without a core. A request no test answered would otherwise go to
// localhost and fail later with a connection error that names no test; this fails
// the same way at once and says which request needs a mock.
globalThis.fetch = (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  return Promise.reject(new TypeError(`No network in unit tests: mock ${url}`));
};
