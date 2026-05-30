import { useState } from 'react';

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

import {
  type BooruCredentialSchema,
  type BooruEngineCatalog,
  type BooruSite
} from './api';
import { AddBooruSiteForm, BooruSiteCredentialForm } from '@/features/booru-sites/BooruSiteForms';
import {
  CAPABILITY_LABELS,
  type CapabilityKey,
  ENGINE_LABELS,
  credentialFieldsForSchema,
} from '@/features/booru-sites/shared';

type Props = {
  className?: string;
  /**
   * Hoisted from the parent so the toggle UI can live at the bottom of the
   * favorites settings card rather than inside this panel. Off by default
   * — the happy-path detection badge is enough for normal users.
   */
  devOptions: boolean;
};

export const BooruSitesPanel = ({ className, devOptions }: Props) => {
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
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const reload = async () => {
    setLocalError(null);
    await Promise.all([sitesQuery.refetch(), catalogQuery.refetch()]);
  };

  const toggleCapability = async (site: BooruSite, capability: CapabilityKey) => {
    try {
      await updateSiteMutation.mutateAsync({
        id: site.id,
        payload: { [capability]: !site[capability] }
      });
    } catch (err) {
      setLocalError((err as Error).message);
    }
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

  const saveCredentials = async (
    site: BooruSite,
    payload: { username: string | null; apiKey: string | null },
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
      setTestResults((prev) => ({
        ...prev,
        [site.id]: {
          ok: res.ok,
          message: res.ok ? `OK (HTTP ${res.status ?? '200'})` : res.error ?? `HTTP ${res.status ?? '?'}`
        }
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [site.id]: { ok: false, message: (err as Error).message }
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
    [reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]];
    try {
      await reorderSitesMutation.mutateAsync(reordered.map((s) => s.id));
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const credentialSchemaFor = (site: BooruSite) =>
    catalog?.engines.find((entry) => entry.type === site.engine)?.credentialSchema ?? 'none';

  if (loading) return <div className={className}>Loading booru sites…</div>;

  return (
    <div className={className}>
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
          <button type="button" className="btn btn-sm btn-link" onClick={() => setLocalError(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      <h5 className="mt-4 text-foreground">Configured booru sources</h5>
      {sites.length === 0 ? (
        <p className="text-muted-foreground text-sm">No sites configured. Add one below to enable favorites sync and tag fetch.</p>
      ) : (
        <div className="mb-6 flex flex-col gap-2">
          {[...sites]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((site) => {
              const schema = credentialSchemaFor(site);
              const fields = credentialFieldsForSchema(schema);
              const test = testResults[site.id];
              return (
                <div key={site.id} className="border border-secondary rounded p-2 text-foreground">
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
                    <div className="form-check form-switch m-0">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id={`enabled-${site.id}`}
                        checked={site.enabled}
                        onChange={() => toggleEnabled(site)}
                      />
                      <label className="form-check-label text-muted-foreground text-sm" htmlFor={`enabled-${site.id}`}>
                        enabled
                      </label>
                    </div>
                  </div>

                  <div className="row g-2 mt-2">
                    {(Object.keys(CAPABILITY_LABELS) as CapabilityKey[]).map((cap) => (
                      <div key={cap} className="col-6 col-md-3">
                        <div className="form-check">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`${site.id}-${cap}`}
                            checked={site[cap]}
                            onChange={() => toggleCapability(site, cap)}
                          />
                          <label className="form-check-label text-muted-foreground text-sm" htmlFor={`${site.id}-${cap}`}>
                            {CAPABILITY_LABELS[cap]}
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>

                  {(fields.username || fields.apiKey) ? (
                    <BooruSiteCredentialForm
                      site={site}
                      schema={schema}
                      loading={updateSiteMutation.isPending}
                      testing={testingId === site.id}
                      onSave={(payload) => saveCredentials(site, payload)}
                      onTest={() => testSite(site)}
                    />
                  ) : (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-light"
                        onClick={() => testSite(site)}
                        disabled={testingId === site.id}
                      >
                        {testingId === site.id ? 'Testing…' : 'Test connection'}
                      </button>
                    </div>
                  )}

                  {test ? (
                    <div className={`text-sm mt-2 ${test.ok ? 'text-success' : 'text-destructive'}`}>
                      {test.ok ? '✓ ' : '✗ '} {test.message}
                    </div>
                  ) : null}

                  {!site.isPreset ? (
                    <div className="mt-2">
                      <button type="button" className="btn btn-sm btn-link text-destructive" onClick={() => deleteSite(site)}>
                        Delete site
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
        </div>
      )}

      <h5 className="mt-6 text-foreground">Add custom booru site</h5>
      <AddBooruSiteForm
        devOptions={devOptions}
        onDetect={(baseUrl) => detectEngineMutation.mutateAsync(baseUrl)}
        onCreate={async (payload) => {
          await createSiteMutation.mutateAsync(payload);
          await reload();
        }}
      />
    </div>
  );
};
