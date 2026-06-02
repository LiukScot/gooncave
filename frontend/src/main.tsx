import './index.css';
import './app.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { Toaster } from './components/ui/sonner';
import { createQueryClient } from './lib/query-client';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container missing');
}

const queryClient = createQueryClient();

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster richColors closeButton />
      {import.meta.env.DEV ? (
        <ReactQueryDevtools buttonPosition="bottom-left" />
      ) : null}
    </QueryClientProvider>
  </React.StrictMode>
);
