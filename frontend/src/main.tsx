// Self-hosted: the page titles' face.
import '@fontsource-variable/bricolage-grotesque/wdth.css';
import './index.css';
import './app.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { isTauri } from '@tauri-apps/api/core';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ConfirmProvider } from './components/confirm-dialog';
import { Toaster } from './components/ui/sonner';
import { installAppLock } from './features/app-lock/appLock';
import { AppLockScreen } from './features/app-lock/AppLockScreen';
import { applyAppearance } from './lib/appearanceTheme';
import { installExternalLinks } from './lib/externalLinks';
import { listenForHaptics } from './lib/haptics';
import { applyScreenCorner, isIos } from './lib/platform';
import { createQueryClient } from './lib/query-client';
import { installResumeLog } from './lib/resumeLog';
import { installWindowErrorLog } from './lib/windowErrorLog';
import { useAppearanceStore } from './stores/appearanceStore';

// app.css reads it: iOS draws its own video bar, so overlays sit above that.
if (isIos()) {
  document.documentElement.dataset.ios = '';
  installExternalLinks(document);
}

installWindowErrorLog(window);
installResumeLog();
// A picture or link dragged out of the app hands over its local address, not the file.
document.addEventListener('dragstart', (event) => {
  if (event.target instanceof Element && event.target.closest('img, video, a')) event.preventDefault();
});
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

// Only the iPhone shell is Tauri; desktop is Electron and the web is a browser.
if (isTauri()) listenForHaptics();
installAppLock();

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
          No closeButton either: a toast is the same capsule as the star-undo
          pill, which carries its action inside and nothing in its corner.
          They still go on a swipe, and none of them outlives its own
          timeout. */}
      <Toaster />
      <AppLockScreen />
      {import.meta.env.DEV ? (
        <ReactQueryDevtools buttonPosition="bottom-left" />
      ) : null}
    </QueryClientProvider>
  </React.StrictMode>
);
