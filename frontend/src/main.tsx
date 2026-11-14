// Self-hosted: the page titles' face.
import '@fontsource-variable/bricolage-grotesque/wdth.css';
import './index.css';
import './app.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api';
import App from './App';
import { ConfirmProvider } from './components/confirm-dialog';
import { Toaster } from './components/ui/sonner';
import { applyAppearance } from './lib/appearanceTheme';
import { installExternalLinks } from './lib/externalLinks';
import { listenForHaptics } from './lib/haptics';
import { applyScreenCorner, isIos } from './lib/platform';
import { createQueryClient } from './lib/query-client';
import { queryKeys } from './lib/query-keys';
import { installWindowErrorLog } from './lib/windowErrorLog';
import { useAppearanceStore } from './stores/appearanceStore';

// app.css reads it: iOS draws its own video bar, so overlays sit above that.
if (isIos()) {
  document.documentElement.dataset.ios = '';
  installExternalLinks(document);
}

installWindowErrorLog(window);
applyScreenCorner();

// Electron's window without a system title bar; `navigator.windowControlsOverlay` is not in
// TypeScript's DOM types yet. Fullscreen hides the window buttons, and the class goes with them.
const windowControls = (
  navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean } }
).windowControlsOverlay;
const markWindowControls = () =>
  document.documentElement.classList.toggle('has-window-controls', windowControls?.visible === true);
markWindowControls();
windowControls?.addEventListener('geometrychange', markWindowControls);

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container missing');
}

// Before the first paint, so the page never shows the stylesheet's
// fallback colours.
applyAppearance();
useAppearanceStore.subscribe(applyAppearance);

const queryClient = createQueryClient();

// The same query useDeviceProfile reads, so the profile is fetched once.
queryClient
  .fetchQuery({ queryKey: queryKeys.device, queryFn: api.getDeviceProfile, staleTime: Infinity })
  .then((profile) => {
    if (profile.capabilities?.haptics === true) listenForHaptics();
  })
  .catch((error: unknown) => console.error('[developer] Could not read the device profile for haptics', error));

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
