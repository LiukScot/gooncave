import { Search, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { api } from '@/api';
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

/** Where the on-screen keyboard leaves the panel: null with no keyboard. */
function useKeyboardRoom(watching: boolean): { inset: number; visible: number } | null {
  const [room, setRoom] = useState<{ inset: number; visible: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!watching || !viewport) return;
    const measure = () => {
      // iOS shrinks innerHeight with the keyboard; the layout height, which fixed panels sit on, stays.
      const inset = document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
      setRoom(inset > 0 ? { inset, visible: viewport.height } : null);
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, [watching]);
  return room;
}

let keyboardReported = false;

/**
 * Writes once per app run where the panel ends over the keyboard and what shows just below it,
 * since the page showing between the panel and the iPhone keyboard cannot be seen in an emulator.
 */
const reportKeyboardRoom = (panel: HTMLElement) => {
  if (keyboardReported) return;
  keyboardReported = true;
  const viewport = window.visualViewport;
  const bottom = Math.round(panel.getBoundingClientRect().bottom);
  const below = document.elementFromPoint(16, bottom + 4);
  const name = below ? `${below.tagName.toLowerCase()}.${[...below.classList].join('.')}` : 'nothing';
  api
    .reportWindowError(
      `[developer] Search panel over the keyboard: page ${document.documentElement.clientHeight}px, window ${window.innerHeight}px, visible ${Math.round(viewport?.height ?? 0)}px from ${Math.round(viewport?.offsetTop ?? 0)}px, page scrolled ${Math.round(window.scrollY)}px, panel ends at ${bottom}px, below it ${name}.`
    )
    .catch((error: unknown) => console.warn('Cannot add the keyboard measure to the app log', error));
};

/** Only the panel's own lists count: the page behind it stays scrolled. */
const startsInScrolledPanel = (target: Element): boolean => {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
    if (node.classList.contains('search-panel')) return false;
  }
  return false;
};

/**
 * The panel that rises from the bottom and follows the finger, opened by a corner
 * button: `triggerRef` also drags it open, and gets the focus back when it closes.
 */
export function BottomPanel({
  open,
  setOpen,
  title,
  triggerRef,
  head,
  foot,
  children
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Names the panel for screen readers. */
  title: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The row above the body that stays put while the body scrolls. */
  head?: ReactNode;
  /** Stays at the bottom, by the thumb. */
  foot?: ReactNode;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { mounted, attach } = useFingerOpening({
    open,
    setOpen,
    axis: 'y',
    opensToward: -1,
    dominance: 1,
    canDrag: (target, isOpen) => {
      if (!isOpen) return Boolean(triggerRef.current?.contains(target));
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
  const keyboard = useKeyboardRoom(mounted);
  useEffect(() => {
    if (!keyboard || !contentRef.current) return;
    const panel = contentRef.current;
    // Measured after the new inset is laid out.
    const frame = requestAnimationFrame(() => reportKeyboardRoom(panel));
    return () => cancelAnimationFrame(frame);
  }, [keyboard]);
  const attachPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      contentRef.current = panel;
      attach(panel);
    },
    [attach]
  );

  return (
    <DialogPrimitive.Root open={mounted} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="search-panel-scrim" />
        <DialogPrimitive.Content
          ref={attachPanel}
          className="search-panel"
          aria-describedby={undefined}
          style={
            keyboard
              ? ({
                  '--keyboard-inset': `${keyboard.inset}px`,
                  '--panel-room': `${keyboard.visible}px`,
                  '--panel-safe-bottom': '0px'
                } as React.CSSProperties)
              : undefined
          }
          // Radix hands focus back only to its own Trigger, and a chip opens this too.
          onCloseAutoFocus={() => triggerRef.current?.focus()}
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
          {head ? <div className="panel-section-head search-panel-head">{head}</div> : null}
          <div className="search-panel-body">{children}</div>
          {foot ? <div className="search-panel-foot">{foot}</div> : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

/**
 * The search and filters of a view: the chips of what applies, the lens in
 * the corner, and the panel the lens opens. Every change applies at once, so
 * the panel has no Apply button.
 */
export function SearchPanel({
  title,
  filters,
  actions,
  floatingActions,
  search,
  children
}: {
  /** Names the panel for screen readers. */
  title: string;
  filters: FilterChip[];
  /** Things to do here rather than choices that narrow the view. */
  actions?: ReactNode | ((close: () => void) => ReactNode);
  /** Small buttons for the view's most frequent actions, beside the lens. */
  floatingActions?: ReactNode;
  /** The search field, at the bottom of the panel by the thumb. */
  search?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const lensRef = useRef<HTMLButtonElement>(null);
  // The lens has to stay outside the page the menu pushes aside (see app.css),
  // and the slot keeps it ahead of the tiles for the keyboard.
  const [lensSlot, setLensSlot] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setLensSlot(document.querySelector('.search-lens-slot') ?? document.body);
  }, []);
  const active = filters.filter((filter) => filter.clear);
  const clearAll = () => active.forEach((filter) => filter.clear?.());
  const resetAll = active.length > 0 ? (
    <button type="button" className="btn btn-link btn-sm search-panel-reset" onClick={clearAll}>
      Reset all ({active.length})
    </button>
  ) : null;

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
        <>
        {floatingActions ? <div className={`search-lens-actions${open ? ' is-covered' : ''}`}>{floatingActions}</div> : null}
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
        </button>
        </>,
        lensSlot
      ) : null}

      <BottomPanel
        open={open}
        setOpen={setOpen}
        title={title}
        triggerRef={lensRef}
        head={
          actions ? (
            <>
              <h2>Actions</h2>
              {resetAll}
            </>
          ) : null
        }
        foot={search ? <PanelSection label="Search">{search}</PanelSection> : null}
      >
        {typeof actions === 'function' ? actions(() => setOpen(false)) : (actions ?? resetAll)}
        {children}
      </BottomPanel>
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

/** Several options that can be on together: the app's connected buttons at the panel's size. */
export function PanelMultiChoice({
  label,
  options
}: {
  label: string;
  options: { label: string; pressed: boolean; disabled?: boolean; onToggle: () => void }[];
}) {
  return (
    <div className="btn-group panel-choice" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className={`btn btn-${option.pressed ? 'primary' : 'outline-light'}`}
          aria-pressed={option.pressed}
          disabled={option.disabled}
          onClick={option.onToggle}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Something that is on or off: sites, Unread only. */
export function PanelToggle({
  pressed,
  onToggle,
  disabled,
  icon,
  children
}: {
  pressed: boolean;
  onToggle: () => void;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn panel-pill btn-${pressed ? 'primary' : 'outline-light'}`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
    >
      {icon}
      {children}
    </button>
  );
}
