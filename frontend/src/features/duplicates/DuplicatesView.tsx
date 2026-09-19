import {
  AlertTriangle,
  CheckCircle2,
  CopyCheck,
  FileCheck2,
  Filter,
  HeartPlus,
  LoaderCircle,
  Trash2
} from 'lucide-react';

import type { DuplicatePolicyRun, DuplicateSettings } from '@/api';

type ProviderOption = { key: string; label: string; iconUrl: string | null };

export interface DuplicatesViewProps {
  settings: DuplicateSettings;
  settingsLoading: boolean;
  settingsError: string | null;
  providers: ProviderOption[];
  editing: boolean;
  draftStyle: DuplicateSettings['style'];
  draftProviders: string[];
  preview: DuplicatePolicyRun | null;
  previewPending: boolean;
  previewError: string | null;
  confirmPending: boolean;
  confirmError: string | null;
  latestRun: DuplicatePolicyRun | null;
  selectStyle: (style: NonNullable<DuplicateSettings['style']>) => void;
  toggleProvider: (provider: string) => void;
  createPreview: () => void;
  confirmPreview: () => void;
  cancelPreview: () => void;
  beginChange: () => void;
  cancelChange: () => void;
  turnOff: () => void;
  retry: () => void;
  retryPending: boolean;
}

const styleLabel = (style: DuplicateSettings['style']) =>
  style === 'favorite_all'
    ? 'Keep every favorite'
    : style === 'preferred_only'
      ? 'Keep favorites on selected sites'
      : 'Nothing selected';

function StrategyCard({
  style,
  selected,
  currentlyActive,
  pending,
  onSelect
}: {
  style: Exclude<DuplicateSettings['style'], null>;
  selected: boolean;
  currentlyActive: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  const all = style === 'favorite_all';
  const Icon = all ? HeartPlus : Filter;
  return (
    <label className={`duplicate-strategy-card${selected ? ' is-selected' : ''}`}>
      <input
        type="radio"
        name="duplicate-strategy"
        value={style}
        checked={selected}
        onChange={onSelect}
      />
      <span className="duplicate-strategy-body">
        <span className="duplicate-strategy-heading">
          <span className="duplicate-strategy-title">
            <Icon aria-hidden="true" />
            <strong>{all ? 'Keep every favorite' : 'Keep favorites on selected sites'}</strong>
          </span>
          <span className="duplicate-strategy-markers">
            {currentlyActive ? <span className="duplicate-status-chip">Currently active</span> : null}
            {pending ? <span className="duplicate-status-chip is-pending">Pending change</span> : null}
          </span>
        </span>
        <span className="duplicate-strategy-description">
          {all
            ? 'Keep the image favorited on every site where GoonCave finds it.'
            : 'Choose the sites where you want to keep the image favorited.'}
        </span>
        <span className="duplicate-consequence">
          <strong>On your sites</strong>
          <span>{all
            ? 'Your current favorites stay, and missing ones are added.'
            : 'Favorites on other sites are removed only after a selected copy is found.'}</span>
        </span>
        <span className="duplicate-consequence">
          <strong>On this device</strong>
          <span>GoonCave keeps one file for the matching favorites.</span>
        </span>
        <span className="duplicate-example">
          <strong>Example</strong>
          <span>{all
            ? 'If the image exists on e621 and Danbooru, both posts stay favorited.'
            : 'Keep e621 and Danbooru; remove the matching Rule34 favorite.'}</span>
        </span>
      </span>
    </label>
  );
}

function RunSummary({ run, preview = false, onRetry, retryPending = false }: { run: DuplicatePolicyRun; preview?: boolean; onRetry?: () => void; retryPending?: boolean }) {
  const progress = run.totalGroups > 0
    ? Math.round((run.processedGroups / run.totalGroups) * 100)
    : 0;
  return (
    <section className="duplicate-preview" aria-live="polite">
      <div className="duplicate-section-heading">
        <div>
          <h3>{preview ? 'Preview' : 'Last check'}</h3>
          <p>{run.totalGroups} matching image {run.totalGroups === 1 ? 'set' : 'sets'} found</p>
        </div>
        {run.status === 'running' ? (
          <span className="duplicate-status-chip is-running"><LoaderCircle aria-hidden="true" /> Running</span>
        ) : null}
      </div>
      {run.status === 'running' ? (
        <div className="mb-4">
          <div className="flex justify-between text-sm mb-1">
            <span>Checking matching images</span><span>{progress}%</span>
          </div>
          <div className="progress" role="progressbar" aria-label="Automation progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : null}
      <dl className="duplicate-preview-counts">
        <div><HeartPlus aria-hidden="true" /><dt>Favorites {preview ? 'to add' : 'added'}</dt><dd>{run.counts.added}</dd></div>
        <div><Trash2 aria-hidden="true" /><dt>Favorites {preview ? 'to remove' : 'removed'}</dt><dd>{run.counts.removed}</dd></div>
        <div><FileCheck2 aria-hidden="true" /><dt>Files {preview ? 'to combine' : 'combined'}</dt><dd>{run.counts.reused}</dd></div>
        <div><CopyCheck aria-hidden="true" /><dt>Extra files {preview ? 'to delete' : 'deleted'}</dt><dd>{run.counts.deleted}</dd></div>
        <div><AlertTriangle aria-hidden="true" /><dt>Images to check</dt><dd>{run.counts.needsAttention}</dd></div>
      </dl>
      {run.error ? (
        <div className="duplicate-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span><strong>Some actions could not be completed.</strong> {run.error}</span>
        </div>
      ) : null}
      {!preview && run.error && onRetry ? (
        <button type="button" className="btn btn-outline-light btn-sm mb-3" onClick={onRetry} disabled={retryPending}>
          {retryPending ? 'Trying again…' : 'Try again'}
        </button>
      ) : null}
      {preview ? <p className="duplicate-no-changes">No changes have been made.</p> : null}
    </section>
  );
}

export function DuplicatesView(props: DuplicatesViewProps) {
  const allowlistInvalid =
    props.draftStyle === 'preferred_only' && props.draftProviders.length === 0;
  const pendingChange =
    props.settings.enabled &&
    (props.draftStyle !== props.settings.style ||
      props.draftProviders.join('\u0000') !== props.settings.preferredProviders.join('\u0000'));
  if (props.settingsLoading) return <div className="p-4">Loading duplicate settings…</div>;

  return (
    <div className="duplicate-handling-page">
      <header className="duplicate-page-intro">
        <div>
          <p>Choose what GoonCave should do when it finds the same image more than once.</p>
          <span className={`duplicate-status-chip${props.settings.enabled ? ' is-active' : ''}`}>
            {props.settings.enabled ? 'Automation is on' : 'Automation is off'}
          </span>
          {props.settings.enabled ? <strong>{styleLabel(props.settings.style)}</strong> : null}
        </div>
        {props.settings.enabled && !props.editing ? (
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn btn-outline-light btn-sm" onClick={props.beginChange}>Change option</button>
            <button type="button" className="btn btn-outline-danger btn-sm" onClick={props.turnOff}>Turn off</button>
          </div>
        ) : null}
      </header>

      {props.latestRun && props.settings.enabled ? <RunSummary run={props.latestRun} onRetry={props.retry} retryPending={props.retryPending} /> : null}

      {props.editing ? (
        <>
          <fieldset className="duplicate-strategy-fieldset">
            <legend>Choose one option</legend>
            <p>Only one option can be active at a time.</p>
            <div className="duplicate-strategy-grid">
              <StrategyCard
                style="favorite_all"
                selected={props.draftStyle === 'favorite_all'}
                currentlyActive={props.settings.enabled && props.settings.style === 'favorite_all'}
                pending={pendingChange && props.draftStyle === 'favorite_all'}
                onSelect={() => props.selectStyle('favorite_all')}
              />
              <span className="duplicate-strategy-or" aria-hidden="true">OR</span>
              <StrategyCard
                style="preferred_only"
                selected={props.draftStyle === 'preferred_only'}
                currentlyActive={props.settings.enabled && props.settings.style === 'preferred_only'}
                pending={pendingChange && props.draftStyle === 'preferred_only'}
                onSelect={() => props.selectStyle('preferred_only')}
              />
            </div>
          </fieldset>

          {props.draftStyle === 'preferred_only' ? (
            <section className="duplicate-allowlist">
              <h3>Sites to keep</h3>
              <p>Select every site where matching favorites should stay.</p>
              <div className="duplicate-provider-list">
                {props.providers.map((provider) => (
                  <label key={provider.key} className="duplicate-provider-option">
                    <input type="checkbox" checked={props.draftProviders.includes(provider.key)} onChange={() => props.toggleProvider(provider.key)} />
                    {provider.iconUrl ? <img src={provider.iconUrl} alt="" /> : null}
                    <span>{provider.label}</span>
                  </label>
                ))}
              </div>
              <p className="duplicate-removal-warning">Favorites on sites you do not select may be removed.</p>
              {allowlistInvalid ? <p className="text-destructive" role="alert">Select at least one site.</p> : null}
            </section>
          ) : null}

          <section className="duplicate-outcome">
            <h3>What will happen</h3>
            {!props.draftStyle ? <p>Select a strategy to continue.</p> : (
              <ul>
                <li><CheckCircle2 aria-hidden="true" />{props.draftStyle === 'favorite_all' ? 'Add missing favorites on every site where the image is found.' : 'Add missing favorites on the sites you select.'}</li>
                {props.draftStyle === 'preferred_only' ? <li><CheckCircle2 aria-hidden="true" />Remove favorites from other sites only after a selected copy is found.</li> : null}
                <li><CheckCircle2 aria-hidden="true" />Keep one local file for matching favorites.</li>
              </ul>
            )}
          </section>

          {!props.preview ? (
            <div className="duplicate-preview-trigger">
              {props.settings.enabled ? <button type="button" className="btn btn-ghost" onClick={props.cancelChange}>Cancel</button> : null}
              <button type="button" className="btn btn-primary" onClick={props.createPreview} disabled={!props.draftStyle || allowlistInvalid || props.previewPending}>
                {props.previewPending ? 'Preparing preview…' : 'Preview changes'}
              </button>
            </div>
          ) : (
            <>
              <RunSummary run={props.preview} preview />
              <div className="duplicate-preview-actions">
                <button type="button" className="btn btn-ghost" onClick={props.cancelPreview}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={props.confirmPreview} disabled={props.confirmPending || props.preview.status !== 'ready'}>
                  {props.confirmPending ? 'Turning on…' : 'Turn on automation'}
                </button>
              </div>
            </>
          )}
        </>
      ) : null}

      {props.settingsError || props.previewError || props.confirmError ? (
        <div className="duplicate-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{props.settingsError ?? props.previewError ?? props.confirmError}</span>
        </div>
      ) : null}
    </div>
  );
}
