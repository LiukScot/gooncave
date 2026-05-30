import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import type {
  BooruCredentialSchema,
  BooruDetectionResult,
  BooruEngineType,
  BooruSite,
} from '@/api';
import { ensureHttps } from '@/urlUtils';

import {
  type BooruCredentialFormValues,
  type BooruSiteAddFormValues,
  booruSiteAddSchema,
  createBooruCredentialSchema,
  toBooruCredentialUpdatePayload,
  toBooruSiteCreatePayload,
} from './formSchemas';
import {
  CAPABILITY_LABELS,
  ENGINE_LABELS,
  credentialFieldsForSchema,
} from './shared';

type AddBooruSiteFormProps = {
  devOptions: boolean;
  onCreate: (payload: ReturnType<typeof toBooruSiteCreatePayload>) => Promise<void>;
  onDetect: (baseUrl: string) => Promise<BooruDetectionResult>;
};

export function AddBooruSiteForm({ devOptions, onCreate, onDetect }: AddBooruSiteFormProps) {
  const [detection, setDetection] = useState<BooruDetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addingBusy, setAddingBusy] = useState(false);
  const form = useForm<BooruSiteAddFormValues>({
    resolver: zodResolver(booruSiteAddSchema),
    defaultValues: {
      name: '',
      baseUrl: '',
      username: '',
      apiKey: '',
      capabilities: {
        capFavorites: false,
        capTags: true,
        capSourceMatch: true,
      },
    },
  });
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = form;
  const baseUrl = watch('baseUrl');
  const detectedEngine = useMemo(() => {
    if (detection && 'engine' in detection) {
      return detection.engine;
    }
    return null;
  }, [detection]);
  const detectedSchema: BooruCredentialSchema = useMemo(() => {
    if (detection && 'engine' in detection) {
      return detection.credentialSchema;
    }
    return 'none';
  }, [detection]);
  const detectedFields = useMemo(
    () => credentialFieldsForSchema(detectedSchema),
    [detectedSchema],
  );
  const addUsernameId = 'booru-detected-username';
  const addApiKeyId = 'booru-detected-api-key';

  useEffect(() => {
    const normalized = ensureHttps(baseUrl);
    if (!normalized) {
      setDetection(null);
      setDetecting(false);
      setDetectError(null);
      return;
    }
    const timeoutId = window.setTimeout(async () => {
      setDetecting(true);
      setDetectError(null);
      try {
        const nextDetection = await onDetect(normalized);
        setDetection(nextDetection);
        if ('engine' in nextDetection && nextDetection.defaultCapabilities) {
          setValue('capabilities.capFavorites', nextDetection.defaultCapabilities.favorites);
          setValue('capabilities.capTags', nextDetection.defaultCapabilities.tags);
          setValue('capabilities.capSourceMatch', nextDetection.defaultCapabilities.sourceMatch);
        }
      } catch (error) {
        setDetection(null);
        setDetectError((error as Error).message);
      } finally {
        setDetecting(false);
      }
    }, 600);

    return () => window.clearTimeout(timeoutId);
  }, [baseUrl, onDetect, setValue]);

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        if (!detectedEngine) {
          setSubmitError('No engine selected. Wait for detection or choose manually.');
          return;
        }
        setAddingBusy(true);
        setSubmitError(null);
        try {
          await onCreate(toBooruSiteCreatePayload(values, detectedEngine as BooruEngineType));
          reset();
          setDetection(null);
          setDetectError(null);
        } catch (error) {
          setSubmitError((error as Error).message);
        } finally {
          setAddingBusy(false);
        }
      })}
      className="row g-2"
    >
      <div className="col-md-6">
        <label htmlFor="booru-name" className="form-label text-sm mb-1 text-muted-foreground">
          Name
        </label>
        <input
          id="booru-name"
          type="text"
          className="form-control form-control-sm bg-background text-foreground border-secondary"
          placeholder="My booru"
          {...register('name')}
        />
        {errors.name ? (
          <div className="text-destructive text-sm mt-1">{errors.name.message}</div>
        ) : null}
      </div>
      <div className="col-md-6">
        <label htmlFor="booru-url" className="form-label text-sm mb-1 text-muted-foreground">
          Base URL
        </label>
        <input
          id="booru-url"
          type="text"
          className="form-control form-control-sm bg-background text-foreground border-secondary"
          placeholder="example.com"
          {...register('baseUrl')}
          onBlur={(event) => {
            const normalized = ensureHttps(event.target.value);
            setValue('baseUrl', normalized, { shouldValidate: true });
          }}
        />
        {errors.baseUrl ? (
          <div className="text-destructive text-sm mt-1">{errors.baseUrl.message}</div>
        ) : null}
      </div>

      {detecting ? <div className="col-12 text-muted-foreground text-sm">Detecting engine…</div> : null}

      {detection && 'engine' in detection ? (
        <div className="col-12">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge text-bg-success">
              Detected: {ENGINE_LABELS[detection.engine]}
            </span>
            {devOptions ? (
              <span className="text-muted-foreground text-sm">
                via {detection.confidence === 'hostname' ? 'known hostname' : 'API probe'}
              </span>
            ) : null}
          </div>
          {detection.sample?.thumbUrl ? (
            <div className="mt-2 flex items-start gap-2">
              <a
                href={detection.sample.postUrl}
                target="_blank"
                rel="noreferrer"
                title={`Sample post #${detection.sample.postId}`}
              >
                <img
                  src={detection.sample.thumbUrl}
                  alt={`Sample post #${detection.sample.postId}`}
                  style={{ maxWidth: 96, maxHeight: 96 }}
                  className="border border-secondary rounded"
                  loading="lazy"
                />
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {detection && 'error' in detection ? (
        <div className="col-12">
          <div className="alert alert-warning py-2 text-sm mb-2">
            {detection.error === 'unreachable'
              ? `Site unreachable. ${detection.message}`
              : 'Could not identify the engine for this site. It may run an unsupported booru engine, require login, or sit behind a CAPTCHA/anti-bot wall. Only recognized engines can be added.'}
          </div>
          {devOptions && detection.attempts?.length ? (
            <details className="mb-2" open>
              <summary className="text-muted-foreground text-sm">
                Probe attempts ({detection.attempts.length})
              </summary>
              <table className="table table-sm table-dark table-borderless mt-2 mb-0 text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col">Engine</th>
                    <th scope="col">Status</th>
                    <th scope="col">HTTP</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {detection.attempts.map((attempt) => (
                    <tr key={attempt.engine}>
                      <td>{ENGINE_LABELS[attempt.engine]}</td>
                      <td>
                        <span
                          className={
                            attempt.status === 'matched'
                              ? 'text-success'
                              : attempt.status === 'no-match'
                                ? 'text-muted-foreground'
                                : 'text-warning'
                          }
                        >
                          {attempt.status}
                        </span>
                      </td>
                      <td>{attempt.httpStatus ?? '—'}</td>
                      <td className="text-muted-foreground">{attempt.error ?? ''}</td>
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
          {detectedFields.username ? (
            <div className="col-md-6">
              <label className="form-label text-sm mb-1" htmlFor={addUsernameId}>
                {detectedFields.usernameLabel}
              </label>
              <input
                id={addUsernameId}
                type="text"
                className="form-control form-control-sm bg-background text-foreground border-secondary"
                {...register('username')}
              />
            </div>
          ) : null}
          {detectedFields.apiKey ? (
            <div className="col-md-6">
              <label className="form-label text-sm mb-1" htmlFor={addApiKeyId}>
                {detectedFields.apiKeyLabel}
              </label>
              <input
                id={addApiKeyId}
                type="password"
                className="form-control form-control-sm bg-background text-foreground border-secondary"
                {...register('apiKey')}
              />
            </div>
          ) : null}
          <div className="col-12 mt-2">
            <span className="text-muted-foreground text-sm block mb-1">Capabilities</span>
            <div className="row g-2">
              {Object.entries(CAPABILITY_LABELS).map(([key, label]) => (
                <div key={key} className="col-6 col-md-3">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id={`new-${key}`}
                      {...register(`capabilities.${key as keyof BooruSiteAddFormValues['capabilities']}`)}
                    />
                    <label className="form-check-label text-muted-foreground text-sm" htmlFor={`new-${key}`}>
                      {label}
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {detectError ? <div className="col-12 text-destructive text-sm">{detectError}</div> : null}
      {submitError ? <div className="col-12 text-destructive text-sm">{submitError}</div> : null}

      <div className="col-12 flex gap-2 mt-2">
        <button type="submit" className="btn btn-sm btn-outline-light" disabled={addingBusy || !detectedEngine}>
          {addingBusy ? 'Adding…' : 'Add site'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-light"
          onClick={() => {
            reset();
            setDetection(null);
            setDetectError(null);
            setSubmitError(null);
          }}
        >
          Reset
        </button>
      </div>
    </form>
  );
}

type BooruSiteCredentialFormProps = {
  site: BooruSite;
  schema: BooruCredentialSchema;
  loading: boolean;
  testing: boolean;
  onSave: (
    payload: ReturnType<typeof toBooruCredentialUpdatePayload>,
  ) => Promise<BooruSite>;
  onTest: () => Promise<void>;
};

export function BooruSiteCredentialForm({
  site,
  schema,
  loading,
  testing,
  onSave,
  onTest,
}: BooruSiteCredentialFormProps) {
  const fields = useMemo(() => credentialFieldsForSchema(schema), [schema]);
  const formSchema = useMemo(() => createBooruCredentialSchema(schema), [schema]);
  const usernameId = `site-${site.id}-username`;
  const apiKeyId = `site-${site.id}-api-key`;
  const {
    register,
    reset,
    handleSubmit,
  } = useForm<BooruCredentialFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: site.username ?? '',
      apiKey: '',
    },
  });

  useEffect(() => {
    reset({
      username: site.username ?? '',
      apiKey: '',
    });
  }, [reset, site.id, site.username]);

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        const updated = await onSave(toBooruCredentialUpdatePayload(values));
        reset({
          username: updated.username ?? '',
          apiKey: '',
        });
      })}
      className="row g-2 mt-2"
    >
      {fields.username ? (
        <div className="col-md-4">
          <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={usernameId}>
            {fields.usernameLabel}
          </label>
          <input
            id={usernameId}
            type="text"
            className="form-control form-control-sm bg-background text-foreground border-secondary"
            {...register('username')}
          />
        </div>
      ) : null}
      {fields.apiKey ? (
        <div className="col-md-4">
          <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={apiKeyId}>
            {fields.apiKeyLabel}
            {site.hasApiKey ? <span className="text-muted-foreground"> · saved</span> : null}
          </label>
          <input
            id={apiKeyId}
            type="password"
            className="form-control form-control-sm bg-background text-foreground border-secondary"
            placeholder={site.hasApiKey ? '••••••••' : ''}
            {...register('apiKey')}
          />
        </div>
      ) : null}
      <div className="col-md-4 flex items-end gap-2">
        <button type="submit" className="btn btn-sm btn-outline-light" disabled={loading}>
          Save credentials
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-light"
          onClick={() => void onTest()}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
      </div>
    </form>
  );
}
