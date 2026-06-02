import { useCallback, useState } from 'react';

import {
  type BooruCredentialSchema,
  type BooruEngineType,
  type BooruSite
} from './api';

import { BooruSiteCredentialForm } from '@/features/booru-sites/BooruSiteCredentialForm';
import { AddBooruSiteForm } from '@/features/booru-sites/BooruSiteForms';
import {
  SITE_SETTING_HELP_TEXT,
  SITE_SETTING_LABELS,
  SUGGESTION_PRESETS,
  type SiteSettingKey
} from '@/features/booru-sites/BooruSitesPanelText';
import {
  ENGINE_LABELS,
  credentialFieldsForSchema
} from '@/features/booru-sites/shared';
import {
  useBooruEngineCatalog,
  useBooruSites,
  useCreateBooruSite,
  useDeleteBooruSite,
  useDetectBooruEngine,
  useReorderBooruSites,
  useTestBooruSite,
  useUpdateBooruSite
} from '@/hooks/booru-sites';

type Props = {
  className?: string;
  /**
   * Hoisted from the parent so the toggle UI can live at the bottom of the
   * favorites settings card rather than inside this panel. Off by default
   * — the happy-path detection badge is enough for normal users.
   */
  devOptions: boolean;
  showSuggestions?: boolean;
};

export const BooruSitesPanel = ({
  className,
  devOptions,
  showSuggestions = false
}: Props) => {
  const sitesQuery = useBooruSites();
  const catalogQuery = useBooruEngineCatalog();
  const sites = sitesQuery.data ?? [];
  const catalog = catalogQuery.data ?? null;
  const loading = sitesQuery.isLoading || catalogQuery.isLoading;
  const createSiteMutation = useCreateBooruSite();
  const updateSiteMutation = useUpdateBooruSite();
  const deleteSiteMutation = useDeleteBooruSite();
  const testSiteMutation = useTestBooruSite();
  const reorderSitesMutation = useReorderBooruSites();
  const detectEngineMutation = useDetectBooruEngine();
  const [localError, setLocalError] = useState<string | null>(null);
  const error =
    localError ??
    (sitesQuery.error as Error | null)?.message ??
    (catalogQuery.error as Error | null)?.message ??
    null;
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; label: string }[]>
  >({});
  const [formPrefill, setFormPrefill] = useState<{
    name: string;
    baseUrl: string;
    engine: BooruEngineType;
    credentialSchema: BooruCredentialSchema;
  } | null>(null);
  const [showAddSiteForm, setShowAddSiteForm] = useState(!showSuggestions);
  const [addFormInstance, setAddFormInstance] = useState(0);

  const reload = async () => {
    setLocalError(null);
    await Promise.all([sitesQuery.refetch(), catalogQuery.refetch()]);
  };

  const toggleEnabled = async (site: BooruSite) => {
    try {
      await updateSiteMutation.mutateAsync({
        id: site.id,
        payload: { enabled: !site.enabled }
      });
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const toggleSiteSetting = async (site: BooruSite, key: SiteSettingKey) => {
    try {
      await updateSiteMutation.mutateAsync({
        id: site.id,
        payload: { [key]: !site[key] }
      });
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const saveCredentials = async (
    site: BooruSite,
    payload: {
      username: string | null;
      apiKey?: string;
      sessionCookie?: string;
    }
  ) => {
    try {
      return await updateSiteMutation.mutateAsync({ id: site.id, payload });
    } catch (err) {
      setLocalError((err as Error).message);
      throw err;
    }
  };

  const deleteSite = async (site: BooruSite) => {
    if (!confirm(`Delete ${site.name}?`)) return;
    try {
      await deleteSiteMutation.mutateAsync(site.id);
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const testSite = async (site: BooruSite) => {
    setTestingId(site.id);
    try {
      const res = await testSiteMutation.mutateAsync(site.id);
      const lines = [
        {
          ok: res.ok,
          label: res.ok
            ? `Credentials: OK (HTTP ${res.status ?? '200'})`
            : `Credentials: ${res.error ?? `HTTP ${res.status ?? '?'}`}`
        }
      ];
      // The cookie line only appears when the backend actually tested it
      // (cookie saved + engine supports it) — otherwise it stays hidden.
      if (res.cookie) {
        lines.push({
          ok: res.cookie.ok,
          label: res.cookie.ok
            ? 'Session cookie: OK'
            : `Session cookie: ${res.cookie.error ?? 'failed'}`
        });
      }
      setTestResults((prev) => ({ ...prev, [site.id]: lines }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [site.id]: [{ ok: false, label: (err as Error).message }]
      }));
    } finally {
      setTestingId(null);
    }
  };

  const moveSite = async (site: BooruSite, direction: -1 | 1) => {
    const sorted = [...sites].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex((s) => s.id === site.id);
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= sorted.length) return;
    const reordered = [...sorted];
    [reordered[idx], reordered[targetIdx]] = [
      reordered[targetIdx],
      reordered[idx]
    ];
    try {
      await reorderSitesMutation.mutateAsync(reordered.map((s) => s.id));
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const credentialSchemaFor = (site: BooruSite) =>
    catalog?.engines.find((entry) => entry.type === site.engine)
      ?.credentialSchema ?? 'none';
  const detectBooru = useCallback(
    (baseUrl: string) => detectEngineMutation.mutateAsync(baseUrl),
    [detectEngineMutation]
  );
  const renderToggleLabel = (id: string, text: string, helpText: string) => (
    <label
      className="form-check-label text-muted-foreground text-sm favorites-switch-label-wrap"
      htmlFor={id}
    >
      {text}
      <span
        className="favorites-help-dot"
        title={helpText}
        aria-label={helpText}
      >
        ?
      </span>
    </label>
  );

  if (loading) return <div className={className}>Loading booru sites…</div>;

  const suggestionCards = SUGGESTION_PRESETS.filter((preset) =>
    catalog?.presets.some((existingPreset) => existingPreset.key === preset.key)
  );

  return (
    <div className={className}>
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
          <button
            type="button"
            className="btn btn-sm btn-link"
            onClick={() => setLocalError(null)}
          >
            dismiss
          </button>
        </div>
      ) : null}

      {showSuggestions ? (
        <div className="mb-0">
          <h5 className="text-foreground mb-3">Suggestions</h5>
          <div className="favorites-suggestions-grid">
            {suggestionCards.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="favorites-suggestion-card"
                onClick={() => {
                  const schema =
                    catalog?.engines.find(
                      (entry) => entry.type === preset.engine
                    )?.credentialSchema ?? 'none';
                  setFormPrefill({
                    name: preset.name,
                    baseUrl: preset.baseUrl,
                    engine: preset.engine,
                    credentialSchema: schema
                  });
                  setShowAddSiteForm(true);
                }}
              >
                <span className="favorites-suggestion-icon" aria-hidden="true">
                  {preset.iconLabel}
                </span>
                <span className="favorites-suggestion-name">{preset.name}</span>
              </button>
            ))}
            <button
              type="button"
              className="favorites-suggestion-card"
              onClick={() => {
                setFormPrefill(null);
                setShowAddSiteForm(true);
                setAddFormInstance((current) => current + 1);
              }}
            >
              <span className="favorites-suggestion-icon" aria-hidden="true">
                +
              </span>
              <span className="favorites-suggestion-name">New site</span>
            </button>
          </div>
          {showAddSiteForm ? (
            <div className="mt-4">
              <h5 className="text-foreground">Add custom booru site</h5>
              <AddBooruSiteForm
                key={`add-site-form-${addFormInstance}`}
                devOptions={devOptions}
                prefill={formPrefill}
                onDetect={detectBooru}
                onCreate={async (payload) => {
                  await createSiteMutation.mutateAsync(payload);
                  setFormPrefill(null);
                  setAddFormInstance((current) => current + 1);
                  setShowAddSiteForm(false);
                  await reload();
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <hr className="favorites-configured-divider" />
        <h5 className="text-foreground m-0">Configured sites</h5>
        {sites.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No sites configured. Add one below to enable favorites sync and tag
            fetch.
          </p>
        ) : (
          <div className="mt-3 mb-6 flex flex-col gap-3">
            {[...sites]
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((site) => {
                const schema = credentialSchemaFor(site);
                const fields = credentialFieldsForSchema(schema);
                const test = testResults[site.id];
                return (
                  <div
                    key={site.id}
                    className="border border-secondary rounded p-4 text-foreground"
                  >
                    <div className="flex items-center gap-2">
                      <div className="grow">
                        <strong>{site.name}</strong>{' '}
                        <span className="text-muted-foreground text-sm">
                          {ENGINE_LABELS[site.engine]} · {site.baseUrl}
                          {site.isPreset ? ' · preset' : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-light"
                        onClick={() => moveSite(site, -1)}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-light"
                        onClick={() => moveSite(site, 1)}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <div className="form-check form-switch favorites-site-switch favorites-site-switch--tight m-0">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`enabled-${site.id}`}
                          checked={site.enabled}
                          onChange={() => toggleEnabled(site)}
                        />
                        <label
                          className="form-check-label text-muted-foreground text-sm"
                          htmlFor={`enabled-${site.id}`}
                        >
                          enabled
                        </label>
                      </div>
                    </div>

                    <div className="favorites-site-toggle-grid mt-2">
                      <div className="favorites-site-toggle-col">
                        <div className="form-check form-switch favorites-site-switch">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`${site.id}-site-auto-sync-midnight`}
                            checked={site.siteAutoSyncMidnight}
                            onChange={() =>
                              void toggleSiteSetting(
                                site,
                                'siteAutoSyncMidnight'
                              )
                            }
                          />
                          {renderToggleLabel(
                            `${site.id}-site-auto-sync-midnight`,
                            SITE_SETTING_LABELS.siteAutoSyncMidnight,
                            SITE_SETTING_HELP_TEXT.siteAutoSyncMidnight
                          )}
                        </div>
                      </div>
                      <div className="favorites-site-toggle-col">
                        <div className="form-check form-switch favorites-site-switch">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`${site.id}-site-reverse-sync-enabled`}
                            checked={site.siteReverseSyncEnabled}
                            onChange={() =>
                              void toggleSiteSetting(
                                site,
                                'siteReverseSyncEnabled'
                              )
                            }
                          />
                          {renderToggleLabel(
                            `${site.id}-site-reverse-sync-enabled`,
                            SITE_SETTING_LABELS.siteReverseSyncEnabled,
                            SITE_SETTING_HELP_TEXT.siteReverseSyncEnabled
                          )}
                        </div>
                      </div>
                      <div className="favorites-site-toggle-col">
                        <div className="form-check form-switch favorites-site-switch">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`${site.id}-site-auto-fav-enabled`}
                            checked={site.siteAutoFavEnabled}
                            onChange={() =>
                              void toggleSiteSetting(site, 'siteAutoFavEnabled')
                            }
                          />
                          {renderToggleLabel(
                            `${site.id}-site-auto-fav-enabled`,
                            SITE_SETTING_LABELS.siteAutoFavEnabled,
                            SITE_SETTING_HELP_TEXT.siteAutoFavEnabled
                          )}
                        </div>
                      </div>
                    </div>

                    {fields.username || fields.apiKey ? (
                      <BooruSiteCredentialForm
                        site={site}
                        schema={schema}
                        loading={updateSiteMutation.isPending}
                        testing={testingId === site.id}
                        onSave={(payload) => saveCredentials(site, payload)}
                        onTest={() => testSite(site)}
                        onDelete={() => void deleteSite(site)}
                      />
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-light shrink-0 whitespace-nowrap"
                          onClick={() => testSite(site)}
                          disabled={testingId === site.id}
                        >
                          {testingId === site.id
                            ? 'Testing…'
                            : 'Test connection'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger shrink-0 whitespace-nowrap"
                          onClick={() => void deleteSite(site)}
                        >
                          Delete site
                        </button>
                      </div>
                    )}

                    {test ? (
                      <div className="text-sm mt-2">
                        {test.map((line, idx) => (
                          <div
                            key={idx}
                            className={
                              line.ok ? 'text-success' : 'text-destructive'
                            }
                          >
                            {line.ok ? '✓ ' : '✗ '} {line.label}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {!showSuggestions ? (
        <>
          <h5 className="mt-6 text-foreground">Add custom booru site</h5>
          <AddBooruSiteForm
            devOptions={devOptions}
            prefill={formPrefill}
            onDetect={detectBooru}
            onCreate={async (payload) => {
              await createSiteMutation.mutateAsync(payload);
              setFormPrefill(null);
              await reload();
            }}
          />
        </>
      ) : null}
    </div>
  );
};
