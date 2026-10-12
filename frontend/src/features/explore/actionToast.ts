import { toast } from 'sonner';

const STATUS_HELP: Array<[test: (status: number) => boolean, text: string]> = [
  [(s) => s === 404, 'The site no longer has this item. It may have been deleted there.'],
  [(s) => s === 401 || s === 403, 'The site refused the request. Check your login for it in Settings.'],
  [(s) => s === 429, 'The site is limiting requests. Wait a minute and try again.'],
  [(s) => s >= 500, 'The site is having problems. Try again later.']
];

/**
 * Turns an API error into a sentence for the reader. Backend errors read
 * `Vote removal failed (404): {"message":"…","backtrace":[…]}`; the status
 * picks the explanation and the raw body is never shown.
 */
export const readableActionError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const status = /\((\d{3})\)/.exec(text)?.[1];
  if (status) {
    const help = STATUS_HELP.find(([test]) => test(Number(status)))?.[1];
    return help ?? 'The site did not accept the request. Try again.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return 'GoonCave cannot reach the server. Check your connection and try again.';
  }
  return text;
};

/** `title` says what could not be done, e.g. "Could not save your vote on Danbooru". */
export const notifyActionError = (title: string, error: unknown): void => {
  toast.error(title, { description: readableActionError(error) });
};
