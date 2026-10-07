import './index.css';
import './app.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ConfirmProvider } from './components/confirm-dialog';
import { Toaster } from './components/ui/sonner';
import { isIos } from './lib/platform';
import { createQueryClient } from './lib/query-client';

// app.css reads it: iOS draws its own video bar, so overlays sit above that.
if (isIos()) document.documentElement.dataset.ios = '';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container missing');
}

const queryClient = createQueryClient();

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
      {/* No richColors: it replaces the token mapping in components/ui/sonner
          with sonner's own palette, and the toasts stopped looking like the
          app. The type still reads from the per-type icon declared there.
          No closeButton either: a toast is the same capsule as the vote-undo
          pill, which carries its action inside and nothing in its corner.
          They still go on a swipe, and none of them outlives its own
          timeout. */}
      <Toaster />
      {import.meta.env.DEV ? (
        <ReactQueryDevtools buttonPosition="bottom-left" />
      ) : null}
    </QueryClientProvider>
  </React.StrictMode>
);
