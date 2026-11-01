import { Check, Search, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { HelpPopover } from '@/components/HelpPopover';
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { useFingerOpening } from '@/lib/fingerOpening';

/** A choice away from the view's defaults, and how to undo it. */
export type ActiveFilter = {
  key: string;
  label: string;
  clear: () => void;
};

/** A chip under the title. The order always shows one; its default has nothing to undo. */
export type FilterChip = Omit<ActiveFilter, 'clear'> & { clear?: () => void };

/** How far the on-screen keyboard reaches into the window. */
function useKeyboardInset(watching: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!watching || !viewport) return;
    const measure = () =>
      setInset(
        Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      );
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, [watching]);
  return inset;
}

/** Only the panel's own lists count: the page behind it stays scrolled. */
const startsInScrolledPanel = (target: Element): boolean => {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
    if (node.classList.contains('search-panel')) return false;
  }
  return false;
};

/**
 * The search and filters of a view: the chips of what applies, the lens in
 * the corner, and the panel the lens opens. Every change applies at once, so
 * the panel has no Apply button.
 */
export function SearchPanel({
  title,
  filters,
  actions,
  search,
  children
}: {
  /** Names the panel for screen readers. */
  title: string;
  filters: FilterChip[];
  /** Things to do here rather than choices that narrow the view. */
  actions?: ReactNode;
  /** The search field, at the bottom of the panel by the thumb. */
  search?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLButtonElement>(null);
  const { mounted, attach } = useFingerOpening({
    open,
    setOpen,
    axis: 'y',
    opensToward: -1,
    dominance: 1,
    canDrag: (target, isOpen) => {
      if (!isOpen) return Boolean(lensRef.current?.contains(target));
      // A list scrolled down takes the drag first; a touch outside the panel has none.
      return !target.closest('.search-panel') || !startsInScrolledPanel(target);
    },
    layers: (size) => [
      {
        element: contentRef.current,
        at: (progress) => ({ transform: `translateY(${(1 - progress) * size}px)` })
      },
      {
        element: document.querySelector('.search-panel-scrim'),
        at: (progress) => ({ opacity: progress })
      }
    ]
  });
  const keyboardInset = useKeyboardInset(mounted);
  const attachPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      contentRef.current = panel;
      attach(panel);
    },
    [attach]
  );
  // The lens has to stay outside the page the menu pushes aside (see app.css),
  // and the slot keeps it ahead of the tiles for the keyboard.
  const [lensSlot, setLensSlot] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setLensSlot(document.querySelector('.search-lens-slot') ?? document.body);
  }, []);
  const active = filters.filter((filter) => filter.clear);
  const clearAll = () => active.forEach((filter) => filter.clear?.());

  return (
    <>
      {filters.length > 0 ? (
        <div className="active-filters mb-4">
          {filters.map((filter) => (
            <span className="active-filter" key={filter.key}>
              <button
                type="button"
                className="active-filter-open"
                onClick={() => setOpen(true)}
              >
                {filter.label}
              </button>
              {filter.clear ? (
                <button
                  type="button"
                  className="active-filter-clear"
                  aria-label={`Remove ${filter.label}`}
                  onClick={filter.clear}
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ))}
          {active.length > 1 ? (
            <button type="button" className="btn btn-link btn-sm" onClick={clearAll}>
              Clear all
            </button>
          ) : null}
        </div>
      ) : null}

      {lensSlot ? createPortal(
        <button
          ref={lensRef}
          type="button"
          className={`search-lens${open ? ' is-covered' : ''}`}
          aria-label={
            active.length > 0
              ? `${title}, ${active.length} active`
              : title
          }
          onClick={() => setOpen(true)}
        >
          <Search aria-hidden="true" />
          {active.length > 0 ? (
            <span className="search-lens-badge">{active.length}</span>
          ) : null}
        </button>,
        lensSlot
      ) : null}

      <DialogPrimitive.Root open={mounted} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogOverlay className="search-panel-scrim" />
          <DialogPrimitive.Content
            ref={attachPanel}
            className="search-panel"
            aria-describedby={undefined}
            style={{ '--keyboard-inset': `${keyboardInset}px` } as React.CSSProperties}
            // Radix hands focus back only to its own Trigger, and a chip opens this too.
            onCloseAutoFocus={() => lensRef.current?.focus()}
            onOpenAutoFocus={(event) => {
              // Focusing the field on a touch screen would raise the keyboard
              // over the choices the reader may have come for.
              event.preventDefault();
              const field = window.matchMedia('(pointer: fine)').matches
                ? contentRef.current?.querySelector('input')
                : null;
              (field ?? contentRef.current)?.focus();
            }}
          >
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="search-panel-grabber"
              aria-label="Close panel"
            />
            {actions || active.length > 0 ? (
              <div className="panel-section-head search-panel-head">
                {actions ? <h2>Actions</h2> : null}
                {active.length > 0 ? (
                  <button type="button" className="btn btn-link btn-sm" onClick={clearAll}>
                    Reset all ({active.length})
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="search-panel-body">
              {actions}
              {children}
            </div>
            {search ? (
              <div className="search-panel-foot">
                <PanelSection label="Search">{search}</PanelSection>
              </div>
            ) : null}
          </DialogPrimitive.Content>
        </DialogPortal>
      </DialogPrimitive.Root>
    </>
  );
}

/** A labelled group of controls in the panel. */
export function PanelSection({
  label,
  aside,
  children
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel-section" aria-label={label}>
      <div className="panel-section-head">
        <h2>{label}</h2>
        {aside ? <span className="text-muted-foreground text-sm">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** One of several options: the app's connected buttons at the panel's size. */
export function PanelChoice<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { value: T; label: string; help?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="btn-group panel-choice" role="group" aria-label={label}>
      {options.map((option) => {
        const button = (
          <button
            key={option.value}
            type="button"
            className={`btn btn-${value === option.value ? 'primary' : 'outline-light'}`}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
        return option.help ? (
          <div className="explore-hot-control" key={option.value}>
            {button}
            <HelpPopover text={option.help} />
          </div>
        ) : (
          button
        );
      })}
    </div>
  );
}

/** Something that is on or off: sites, Unread only. */
export function PanelToggle({
  pressed,
  onToggle,
  children
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn panel-pill btn-${pressed ? 'primary' : 'outline-light'}`}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {pressed ? <Check aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
