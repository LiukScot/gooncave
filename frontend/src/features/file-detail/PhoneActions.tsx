import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The favorite and vote buttons of an open post on a phone: part of the app's own UI, fixed at
 * the bottom right of the screen instead of on the picture. Rendered on the page body because
 * the detail frame is a layout container, and a fixed box inside one is placed against the
 * frame, not the screen.
 */
export function PhoneActions({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="phone-actions" role="group" aria-label="Post actions">
      {children}
    </div>,
    document.body
  );
}
