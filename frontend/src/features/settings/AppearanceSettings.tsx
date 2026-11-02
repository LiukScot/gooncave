import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronUp,
  CloudDownload,
  EyeOff,
  Heart,
  ImagePlus,
  Monitor,
  Moon,
  RefreshCw,
  Rss,
  Share2,
  Sun,
  Trash2
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import { api } from '@/api';
import { useExtraSettings } from '@/hooks/settings';
import {
  ACCENT_IDS,
  accentLabel,
  accentSwatch
} from '@/lib/accents';
import { queryKeys } from '@/lib/query-keys';
import { scrollSidewaysOnWheel } from '@/lib/scrollSidewaysOnWheel';
import {
  type AppearanceMode,
  QUICK_ACTIONS,
  type QuickAction,
  type QuickPage,
  useAppearanceStore
} from '@/stores/appearanceStore';

const MODES: { value: AppearanceMode; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
];

const QUICK_PAGES: { page: QuickPage; label: string }[] = [
  { page: 'gallery', label: 'Gallery' },
  { page: 'explore', label: 'Explore' },
  { page: 'file', label: 'Open post in Gallery' },
  { page: 'post', label: 'Open post in Explore' }
];

const QUICK_LABELS: Record<QuickAction, string> = {
  add: 'Add files',
  sync: 'Sync',
  unread: 'Unread only',
  subscribe: 'Subscribe',
  vote: 'Vote',
  delete: 'Delete',
  keep: 'Keep',
  share: 'Share',
  favorite: 'Favorite',
  none: 'None'
};

const QUICK_ICONS: Record<Exclude<QuickAction, 'vote' | 'none'>, LucideIcon> = {
  add: ImagePlus,
  sync: RefreshCw,
  unread: EyeOff,
  subscribe: Rss,
  delete: Trash2,
  keep: CloudDownload,
  share: Share2,
  favorite: Heart
};

function QuickActionIcon({ action }: { action: QuickAction }) {
  if (action === 'none') return <span className="quick-action-icon quick-action-none" />;
  if (action === 'vote') {
    return (
      <span className="quick-action-icon quick-action-pair">
        <ChevronUp aria-hidden="true" />
        <ChevronDown aria-hidden="true" />
      </span>
    );
  }
  const Icon = QUICK_ICONS[action];
  return (
    <span className="quick-action-icon">
      <Icon aria-hidden="true" />
    </span>
  );
}

function QuickActionPicker({ page, label }: (typeof QUICK_PAGES)[number]) {
  const chosen = useAppearanceStore((state) => state.quickActions[page]);
  const setQuickAction = useAppearanceStore((state) => state.setQuickAction);
  const titleId = `quick-action-${page}`;
  const originals = useQuery({
    queryKey: queryKeys.originals,
    queryFn: api.getOriginals,
    enabled: chosen === 'keep'
  });
  const { readTrackingEnabled, voteSystemEnabled, loaded } = useExtraSettings();
  return (
    <div className="quick-action-page">
      <h3 id={titleId} className="quick-action-title">
        {label}
      </h3>
      <div className="quick-action-choices" role="radiogroup" aria-labelledby={titleId}>
        {QUICK_ACTIONS[page].map((action) => (
          <label key={action} className="quick-action-choice">
            <input
              type="radio"
              name={titleId}
              value={action}
              checked={chosen === action}
              onChange={() => setQuickAction(page, action)}
              className="visually-hidden"
            />
            <QuickActionIcon action={action} />
            {QUICK_LABELS[action]}
          </label>
        ))}
      </div>
      {chosen === 'keep' && originals.data?.keepAll ? (
        <p className="appearance-group-description mb-0">
          This device keeps every file, so there is nothing to keep and no button shows here.{' '}
          <Link to="/app/settings/sync">Open Sync to turn off Keep every file</Link>.
        </p>
      ) : null}
      {chosen === 'unread' && loaded && !readTrackingEnabled ? (
        <p className="appearance-group-description mb-0">
          Unread only needs History to know what you have seen, so no button shows here.{' '}
          <Link to="/app/settings/extra">Open Extra to turn on History</Link>.
        </p>
      ) : null}
      {page === 'file' && chosen === 'vote' && loaded && !voteSystemEnabled ? (
        <p className="appearance-group-description mb-0">
          The Gallery vote system is off, so no button shows here.{' '}
          <Link to="/app/settings/extra">Open Extra to turn it on</Link>.
        </p>
      ) : null}
      {chosen === 'subscribe' ? (
        <p className="appearance-group-description mb-0">
          The button shows while you search for something.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Keeps the row of colours going round both ways: it holds three copies of the
 * colours, and on leaving the middle one it jumps a whole copy back, to the same
 * picture. Only the middle copy is there for the keyboard and screen readers.
 */
const attachAccentLoop = (row: HTMLElement | null) => {
  if (!row) return;
  const stopWheel = scrollSidewaysOnWheel(row);
  const [first, second] = row.children as unknown as HTMLElement[];
  const copyWidth = second.offsetLeft - first.offsetLeft;
  const chosen = second.querySelector('input:checked')?.parentElement;
  row.scrollLeft =
    copyWidth + (chosen ? chosen.getBoundingClientRect().left - second.getBoundingClientRect().left : 0);
  const onScroll = () => {
    if (row.scrollLeft < copyWidth / 2) row.scrollLeft += copyWidth;
    else if (row.scrollLeft >= copyWidth * 1.5) row.scrollLeft -= copyWidth;
  };
  row.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    row.removeEventListener('scroll', onScroll);
    stopWheel?.();
  };
};

function Section({
  id,
  title,
  description,
  children
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="appearance-group" aria-labelledby={id}>
      <h2 id={id} className="appearance-group-title">
        {title}
      </h2>
      {description ? <p className="appearance-group-description">{description}</p> : null}
      {children}
    </section>
  );
}

export function AppearanceSettings() {
  const mode = useAppearanceStore((state) => state.mode);
  const accent = useAppearanceStore((state) => state.accent);
  const setMode = useAppearanceStore((state) => state.setMode);
  const setAccent = useAppearanceStore((state) => state.setAccent);

  return (
    <div className="appearance-settings">
      <Section
        id="appearance-mode"
        title="Mode"
      >
        <div className="btn-group appearance-mode" role="group" aria-labelledby="appearance-mode">
          {MODES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`btn ${mode === value ? 'btn-primary' : 'btn-outline-light'}`}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        id="appearance-accent"
        title="Accent colour"
      >
        <div
          className="appearance-accents"
          role="radiogroup"
          aria-labelledby="appearance-accent"
          ref={attachAccentLoop}
        >
          {[-1, 0, 1].map((copy) => (
            <div key={copy} className="appearance-accent-copy" aria-hidden={copy !== 0 || undefined}>
              {ACCENT_IDS.map((key) => (
                <label key={key} className="appearance-accent" title={accentLabel(key)}>
                  <input
                    type="radio"
                    name={`appearance-accent${copy}`}
                    value={key}
                    checked={accent === key}
                    onChange={() => setAccent(key)}
                    tabIndex={copy === 0 ? undefined : -1}
                    className="visually-hidden"
                  />
                  <span
                    className="appearance-accent-swatch"
                    style={{ '--swatch': accentSwatch(key) } as CSSProperties}
                  />
                  <span className="visually-hidden">{accentLabel(key)}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="appearance-quick-action"
        title="Quick button"
        description="One action of your choice, beside the main button in the corner. The others stay inside the main button."
      >
        {QUICK_PAGES.map((page) => (
          <QuickActionPicker key={page.page} {...page} />
        ))}
      </Section>
    </div>
  );
}
