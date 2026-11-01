import { Check, Search, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { HelpPopover } from '@/components/HelpPopover';
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog';

/** A choice away from the view's defaults, and how to undo it. */
export type ActiveFilter = {
  key: string;
  label: string;
  clear: () => void;
};

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

/**
 * The search and filters of a view: the chips of what is active, the lens in
 * the corner, and the panel the lens opens. Every change applies at once, so
 * the panel has no Apply button.
 */
export function SearchPanel({
  title,
  filters,
  search,
  children
}: {
  /** Names the panel for screen readers. */
  title: string;
  filters: ActiveFilter[];
  /** The search field, at the bottom of the panel by the thumb. */
  search?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const keyboardInset = useKeyboardInset(open);
  const contentRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLButtonElement>(null);
  const clearAll = () => filters.forEach((filter) => filter.clear());

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
              <button
                type="button"
                className="active-filter-clear"
                aria-label={`Remove ${filter.label}`}
                onClick={filter.clear}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
          {filters.length > 1 ? (
            <button type="button" className="btn btn-link btn-sm" onClick={clearAll}>
              Clear all
            </button>
          ) : null}
        </div>
      ) : null}

      <button
        ref={lensRef}
        type="button"
        className={`search-lens${open ? ' is-covered' : ''}`}
        aria-label={
          filters.length > 0
            ? `${title}, ${filters.length} active`
            : title
        }
        onClick={() => setOpen(true)}
      >
        <Search aria-hidden="true" />
        {filters.length > 0 ? (
          <span className="search-lens-badge">{filters.length}</span>
        ) : null}
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogOverlay className="search-panel-scrim" />
          <DialogPrimitive.Content
            ref={contentRef}
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
            {filters.length > 0 ? (
              <div className="search-panel-head">
                <button type="button" className="btn btn-link btn-sm" onClick={clearAll}>
                  Reset all ({filters.length})
                </button>
              </div>
            ) : null}
            <div className="search-panel-body">{children}</div>
            {search ? <div className="search-panel-foot">{search}</div> : null}
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
