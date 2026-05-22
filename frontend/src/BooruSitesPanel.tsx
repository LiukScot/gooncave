import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';

import {
  api,
  type BooruCredentialSchema,
  type BooruDetectionResult,
  type BooruEngineCatalog,
  type BooruEngineType,
  type BooruSite
} from './api';

const ENGINE_LABELS: Record<BooruEngineType, string> = {
  danbooru: 'Danbooru',
  e621: 'e621',
  moebooru: 'Moebooru (yande.re / konachan)',
  gelbooru: 'Gelbooru',
  sankaku: 'Sankaku',
  philomena: 'Philomena (Derpibooru)',
  shimmie: 'Shimmie2',
  szurubooru: 'Szurubooru'
};

type CapabilityKey = 'capFavorites' | 'capTags' | 'capSourceMatch';

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  capFavorites: 'Sync favorites',
  capTags: 'Tag fetch',
  capSourceMatch: 'Source URL match'
};

type CredentialsState = {
  username: string;
  apiKey: string;
};

type AddFormState = {
  name: string;
  baseUrl: string;
  detection: BooruDetectionResult | null;
  detecting: boolean;
  detectError: string | null;
  username: string;
  apiKey: string;
  capabilities: Record<CapabilityKey, boolean>;
};

const defaultCaps: Record<CapabilityKey, boolean> = {
  capFavorites: false,
  capTags: true,
  capSourceMatch: true
};

const initialAddForm = (): AddFormState => ({
  name: '',
  baseUrl: '',
  detection: null,
  detecting: false,
  detectError: null,
  username: '',
  apiKey: '',
  capabilities: { ...defaultCaps }
});

const credentialFieldsForSchema = (schema: BooruCredentialSchema) => {
  switch (schema) {
    case 'username+apikey':
      return { username: true, usernameLabel: 'Username', apiKey: true, apiKeyLabel: 'API key' };
    case 'userid+apikey':
      return { username: true, usernameLabel: 'User ID', apiKey: true, apiKeyLabel: 'API key' };
    case 'apikey-only':
      return { username: false, usernameLabel: '', apiKey: true, apiKeyLabel: 'API key' };
    case 'token':
      return { username: false, usernameLabel: '', apiKey: true, apiKeyLabel: 'Token' };
    case 'none':
    default:
      return { username: false, usernameLabel: '', apiKey: false, apiKeyLabel: '' };
  }
};

const debounce = <T extends (...args: never[]) => void>(fn: T, delay: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

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
  const [sites, setSites] = useState<BooruSite[]>([]);
  const [catalog, setCatalog] = useState<BooruEngineCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addForm, setAddForm] = useState<AddFormState>(initialAddForm());
  const [addingBusy, setAddingBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [editCredentials, setEditCredentials] = useState<Record<string, CredentialsState>>({});

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, engineCatalog] = await Promise.all([
        api.getBooruSites(),
        api.getBooruEngineCatalog()
      ]);
      setSites(list);
      setCatalog(engineCatalog);
      const inputs: Record<string, CredentialsState> = {};
      list.forEach((site) => {
        inputs[site.id] = {
          username: site.username ?? '',
          apiKey: ''
        };
      });
      setEditCredentials(inputs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const detectedEngine: BooruEngineType | null = useMemo(() => {
    if (addForm.detection && 'engine' in addForm.detection) return addForm.detection.engine;
    return null;
  }, [addForm.detection]);

  const detectedSchema: BooruCredentialSchema = useMemo(() => {
    if (addForm.detection && 'engine' in addForm.detection) {
      return addForm.detection.credentialSchema;
    }
    return 'none';
  }, [addForm.detection]);

  const runDetect = useMemo(
    () =>
      debounce(async (url: string) => {
        if (!url) {
          setAddForm((prev) => ({ ...prev, detection: null, detecting: false, detectError: null }));
          return;
        }
        setAddForm((prev) => ({ ...prev, detecting: true, detectError: null }));
        try {
          const result = await api.detectBooruEngine(url);
          setAddForm((prev) => ({
            ...prev,
            detection: result,
            detecting: false,
            detectError: 'error' in result ? null : null,
            capabilities:
              'engine' in result && result.defaultCapabilities
                ? {
                    capFavorites: result.defaultCapabilities.favorites,
                    capTags: result.defaultCapabilities.tags,
                    capSourceMatch: result.defaultCapabilities.sourceMatch
                  }
                : prev.capabilities
          }));
        } catch (err) {
          setAddForm((prev) => ({ ...prev, detecting: false, detectError: (err as Error).message }));
        }
      }, 600),
    []
  );

  const onUrlChange = (value: string) => {
    setAddForm((prev) => ({ ...prev, baseUrl: value, detection: null }));
    runDetect(value);
  };

  const submitNewSite = async (event: FormEvent) => {
    event.preventDefault();
    if (!detectedEngine) {
      setAddForm((prev) => ({ ...prev, detectError: 'No engine selected. Wait for detection or choose manually.' }));
      return;
    }
    setAddingBusy(true);
    try {
      await api.createBooruSite({
        name: addForm.name.trim(),
        engine: detectedEngine,
        baseUrl: addForm.baseUrl.trim(),
        username: addForm.username.trim() || null,
        apiKey: addForm.apiKey.trim() || null,
        capFavorites: addForm.capabilities.capFavorites,
        capTags: addForm.capabilities.capTags,
        capSourceMatch: addForm.capabilities.capSourceMatch,
        enabled: true
      });
      setAddForm(initialAddForm());
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAddingBusy(false);
    }
  };

  const toggleCapability = async (site: BooruSite, capability: CapabilityKey) => {
    try {
      const updated = await api.updateBooruSite(site.id, { [capability]: !site[capability] });
      setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleEnabled = async (site: BooruSite) => {
    try {
      const updated = await api.updateBooruSite(site.id, { enabled: !site.enabled });
      setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveCredentials = async (site: BooruSite) => {
    const input = editCredentials[site.id];
    if (!input) return;
    try {
      const updated = await api.updateBooruSite(site.id, {
        username: input.username.trim() || null,
        apiKey: input.apiKey.trim() || null
      });
      setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditCredentials((prev) => ({ ...prev, [site.id]: { username: updated.username ?? '', apiKey: '' } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteSite = async (site: BooruSite) => {
    if (!confirm(`Delete ${site.name}?`)) return;
    try {
      await api.deleteBooruSite(site.id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const testSite = async (site: BooruSite) => {
    setTestingId(site.id);
    try {
      const res = await api.testBooruSite(site.id);
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
      const updated = await api.reorderBooruSites(reordered.map((s) => s.id));
      setSites(updated);
    } catch (err) {
      setError((err as Error).message);
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
          <button type="button" className="btn btn-sm btn-link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      <h5 className="mt-3 text-light">Configured booru sources</h5>
      {sites.length === 0 ? (
        <p className="text-secondary small">No sites configured. Add one below to enable favorites sync and tag fetch.</p>
      ) : (
        <div className="mb-4 d-flex flex-column gap-2">
          {[...sites]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((site) => {
              const schema = credentialSchemaFor(site);
              const fields = credentialFieldsForSchema(schema);
              const test = testResults[site.id];
              const edit = editCredentials[site.id] ?? { username: '', apiKey: '' };
              return (
                <div key={site.id} className="border border-secondary rounded p-2 text-light">
                  <div className="d-flex align-items-center gap-2">
                    <div className="flex-grow-1">
                      <strong>{site.name}</strong>{' '}
                      <small className="text-secondary">
                        {ENGINE_LABELS[site.engine]} · {site.baseUrl}
                        {site.isPreset ? ' · preset' : ''}
                      </small>
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
                      <label className="form-check-label text-secondary small" htmlFor={`enabled-${site.id}`}>
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
                          <label className="form-check-label text-secondary small" htmlFor={`${site.id}-${cap}`}>
                            {CAPABILITY_LABELS[cap]}
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>

                  {(fields.username || fields.apiKey) ? (
                    <div className="row g-2 mt-2">
                      {fields.username ? (
                        <div className="col-md-4">
                          <label className="form-label small mb-1 text-secondary">{fields.usernameLabel}</label>
                          <input
                            type="text"
                            className="form-control form-control-sm bg-dark text-light border-secondary"
                            value={edit.username}
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                              setEditCredentials((prev) => ({
                                ...prev,
                                [site.id]: { ...edit, username: e.target.value }
                              }))
                            }
                          />
                        </div>
                      ) : null}
                      {fields.apiKey ? (
                        <div className="col-md-4">
                          <label className="form-label small mb-1 text-secondary">
                            {fields.apiKeyLabel}
                            {site.hasApiKey ? <span className="text-secondary"> · saved</span> : null}
                          </label>
                          <input
                            type="password"
                            className="form-control form-control-sm bg-dark text-light border-secondary"
                            placeholder={site.hasApiKey ? '••••••••' : ''}
                            value={edit.apiKey}
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                              setEditCredentials((prev) => ({
                                ...prev,
                                [site.id]: { ...edit, apiKey: e.target.value }
                              }))
                            }
                          />
                        </div>
                      ) : null}
                      <div className="col-md-4 d-flex align-items-end gap-2">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-light"
                          onClick={() => saveCredentials(site)}
                        >
                          Save credentials
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-light"
                          onClick={() => testSite(site)}
                          disabled={testingId === site.id}
                        >
                          {testingId === site.id ? 'Testing…' : 'Test'}
                        </button>
                      </div>
                    </div>
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
                    <div className={`small mt-2 ${test.ok ? 'text-success' : 'text-danger'}`}>
                      {test.ok ? '✓ ' : '✗ '} {test.message}
                    </div>
                  ) : null}

                  {!site.isPreset ? (
                    <div className="mt-2">
                      <button type="button" className="btn btn-sm btn-link text-danger" onClick={() => deleteSite(site)}>
                        Delete site
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
        </div>
      )}

      <h5 className="mt-4 text-light">Add custom booru site</h5>
      <form onSubmit={submitNewSite} className="row g-2">
        <div className="col-md-6">
          <label htmlFor="booru-name" className="form-label small mb-1 text-secondary">
            Name
          </label>
          <input
            id="booru-name"
            type="text"
            className="form-control form-control-sm bg-dark text-light border-secondary"
            value={addForm.name}
            onChange={(e) => setAddForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="My booru"
            required
          />
        </div>
        <div className="col-md-6">
          <label htmlFor="booru-url" className="form-label small mb-1 text-secondary">
            Base URL
          </label>
          <input
            id="booru-url"
            type="url"
            className="form-control form-control-sm bg-dark text-light border-secondary"
            value={addForm.baseUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://example.com"
            required
          />
        </div>

        {addForm.detecting ? (
          <div className="col-12 text-secondary small">Detecting engine…</div>
        ) : null}

        {addForm.detection && 'engine' in addForm.detection ? (
          <div className="col-12">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <span className="badge text-bg-success">
                Detected: {ENGINE_LABELS[addForm.detection.engine]}
              </span>
              {devOptions ? (
                <small className="text-secondary">
                  via {addForm.detection.confidence === 'hostname' ? 'known hostname' : 'API probe'}
                </small>
              ) : null}
            </div>
            {addForm.detection.sample?.thumbUrl ? (
              <div className="mt-2 d-flex align-items-start gap-2">
                <a
                  href={addForm.detection.sample.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`Sample post #${addForm.detection.sample.postId}`}
                >
                  <img
                    src={addForm.detection.sample.thumbUrl}
                    alt={`Sample post #${addForm.detection.sample.postId}`}
                    style={{ maxWidth: 96, maxHeight: 96 }}
                    className="border border-secondary rounded"
                    loading="lazy"
                  />
                </a>
              </div>
            ) : null}
          </div>
        ) : null}

        {addForm.detection && 'error' in addForm.detection ? (
          <div className="col-12">
            <div className="alert alert-warning py-2 small mb-2">
              {addForm.detection.error === 'unreachable'
                ? `Site unreachable. ${addForm.detection.message}`
                : 'Could not identify the engine for this site. It may run an unsupported booru engine, require login, or sit behind a CAPTCHA/anti-bot wall. Only recognized engines can be added.'}
            </div>
            {devOptions && addForm.detection.attempts?.length ? (
              <details className="mb-2" open>
                <summary className="text-secondary small">
                  Probe attempts ({addForm.detection.attempts.length})
                </summary>
                <table className="table table-sm table-dark table-borderless mt-2 mb-0 small">
                  <thead>
                    <tr className="text-secondary">
                      <th scope="col">Engine</th>
                      <th scope="col">Status</th>
                      <th scope="col">HTTP</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {addForm.detection.attempts.map((attempt) => (
                      <tr key={attempt.engine}>
                        <td>{ENGINE_LABELS[attempt.engine]}</td>
                        <td>
                          <span
                            className={
                              attempt.status === 'matched'
                                ? 'text-success'
                                : attempt.status === 'no-match'
                                  ? 'text-secondary'
                                  : 'text-warning'
                            }
                          >
                            {attempt.status}
                          </span>
                        </td>
                        <td>{attempt.httpStatus ?? '—'}</td>
                        <td className="text-secondary">{attempt.error ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </div>
        ) : null}

        {detectedEngine ? (
          <>
            {credentialFieldsForSchema(detectedSchema).username ? (
              <div className="col-md-6">
                <label className="form-label small mb-1">
                  {credentialFieldsForSchema(detectedSchema).usernameLabel}
                </label>
                <input
                  type="text"
                  className="form-control form-control-sm bg-dark text-light border-secondary"
                  value={addForm.username}
                  onChange={(e) => setAddForm((prev) => ({ ...prev, username: e.target.value }))}
                />
              </div>
            ) : null}
            {credentialFieldsForSchema(detectedSchema).apiKey ? (
              <div className="col-md-6">
                <label className="form-label small mb-1">
                  {credentialFieldsForSchema(detectedSchema).apiKeyLabel}
                </label>
                <input
                  type="password"
                  className="form-control form-control-sm bg-dark text-light border-secondary"
                  value={addForm.apiKey}
                  onChange={(e) => setAddForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                />
              </div>
            ) : null}

            <div className="col-12 mt-2">
              <small className="text-muted d-block mb-1">Capabilities</small>
              <div className="row g-2">
                {(Object.keys(CAPABILITY_LABELS) as CapabilityKey[]).map((cap) => (
                  <div key={cap} className="col-6 col-md-3">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id={`new-${cap}`}
                        checked={addForm.capabilities[cap]}
                        onChange={() =>
                          setAddForm((prev) => ({
                            ...prev,
                            capabilities: { ...prev.capabilities, [cap]: !prev.capabilities[cap] }
                          }))
                        }
                      />
                      <label className="form-check-label text-secondary small" htmlFor={`new-${cap}`}>
                        {CAPABILITY_LABELS[cap]}
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {addForm.detectError ? <div className="col-12 text-danger small">{addForm.detectError}</div> : null}

        <div className="col-12 d-flex gap-2 mt-2">
          <button type="submit" className="btn btn-sm btn-outline-light" disabled={addingBusy || !detectedEngine}>
            {addingBusy ? 'Adding…' : 'Add site'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-light"
            onClick={() => setAddForm(initialAddForm())}
          >
            Reset
          </button>
        </div>
      </form>
    </div>
  );
};
