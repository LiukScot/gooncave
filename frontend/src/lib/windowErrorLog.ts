import { api } from '@/api';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_MESSAGES = 50;

/** Adds errors of the web page to the app log, so a report also explains a broken screen. */
export const installWindowErrorLog = (target: Pick<Window, 'addEventListener'>) => {
  const seen = new Set<string>();
  const send = (message: string) => {
    // A failing render or observer can repeat many times a second, even with two messages in turn.
    if (!message || seen.has(message) || seen.size >= MAX_MESSAGES) return;
    seen.add(message);
    api.reportWindowError(message.slice(0, MAX_MESSAGE_LENGTH)).catch((error: unknown) => {
      console.warn('Cannot add a window error to the app log', error);
    });
  };
  target.addEventListener('error', (event) => send(event.message));
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    send(reason instanceof Error ? reason.message : String(reason));
  });
};
