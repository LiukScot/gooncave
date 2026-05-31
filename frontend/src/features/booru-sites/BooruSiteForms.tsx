import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  type BooruCredentialFormValues,
  type BooruSiteAddFormValues,
  booruSiteAddSchema,
  createBooruCredentialSchema,
  toBooruCredentialUpdatePayload,
  toBooruSiteCreatePayload
} from './formSchemas';
import { ENGINE_LABELS, credentialFieldsForSchema } from './shared';

import type {
  BooruCredentialSchema,
  BooruDetectionResult,
  BooruEngineType,
  BooruSite
} from '@/api';
import { ensureHttps } from '@/urlUtils';

type AddBooruSiteFormProps = {
  devOptions: boolean;
  onCreate: (
    payload: ReturnType<typeof toBooruSiteCreatePayload>
  ) => Promise<void>;
  onDetect: (baseUrl: string) => Promise<BooruDetectionResult>;
  prefill?: {
    name: string;
    baseUrl: string;
    engine: BooruEngineType;
    credentialSchema: BooruCredentialSchema;
  } | null;
};

export function AddBooruSiteForm({
  devOptions,
  onCreate,
  onDetect,
  prefill
}: AddBooruSiteFormProps) {
  const [detection, setDetection] = useState<BooruDetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addingBusy, setAddingBusy] = useState(false);
  const detectRequestSeq = useRef(0);
  const lastDetectedBaseUrl = useRef<string | null>(null);
  const onDetectRef = useRef(onDetect);
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
        capSourceMatch: true
      }
    }
  });
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors }
  } = form;
  const baseUrl = watch('baseUrl');
  const normalizedBaseUrl = ensureHttps(baseUrl);
  const detectedEngine = useMemo(() => {
    if (detection && 'engine' in detection) {
      return detection.engine;
    }
    return null;
  }, [detection]);
  const prefillBaseUrl = ensureHttps(prefill?.baseUrl ?? '');
  const prefillMatchesBaseUrl =
    !!prefill && !!normalizedBaseUrl && normalizedBaseUrl === prefillBaseUrl;
  const selectedEngine =
    detectedEngine ??
    (prefillMatchesBaseUrl ? (prefill?.engine ?? null) : null);
  const selectedSchema: BooruCredentialSchema =
    detection && 'engine' in detection
      ? detection.credentialSchema
      : prefillMatchesBaseUrl
        ? (prefill?.credentialSchema ?? 'none')
        : 'none';
  const detectedFields = useMemo(
    () => credentialFieldsForSchema(selectedSchema),
    [selectedSchema]
  );
  const addUsernameId = 'booru-detected-username';
  const addApiKeyId = 'booru-detected-api-key';

  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    if (!prefill) return;
    setValue('name', prefill.name, { shouldValidate: true });
    setValue('baseUrl', prefill.baseUrl, { shouldValidate: true });
    setSubmitError(null);
    setDetectError(null);
    setDetection(null);
    lastDetectedBaseUrl.current = null;
  }, [prefill, setValue]);

  useEffect(() => {
    const normalized = normalizedBaseUrl;
    if (!normalized) {
      setDetection(null);
      setDetecting(false);
      setDetectError(null);
      lastDetectedBaseUrl.current = null;
      return;
    }
    if (normalized === lastDetectedBaseUrl.current) {
      return;
    }
    const requestSeq = ++detectRequestSeq.current;
    setDetection(null);
    const timeoutId = window.setTimeout(async () => {
      setDetecting(true);
      setDetectError(null);
      try {
        const nextDetection = await new Promise<BooruDetectionResult>(
          (resolve, reject) => {
            const failTimerId = window.setTimeout(
              () => reject(new Error('Engine detection timed out. Try again.')),
              8_000
            );
            onDetectRef
              .current(normalized)
              .then((result) => {
                window.clearTimeout(failTimerId);
                resolve(result);
              })
              .catch((error: unknown) => {
                window.clearTimeout(failTimerId);
                reject(error);
              });
          }
        );
        if (requestSeq !== detectRequestSeq.current) return;
        setDetection(nextDetection);
        lastDetectedBaseUrl.current = normalized;
        if ('engine' in nextDetection && nextDetection.defaultCapabilities) {
          setValue(
            'capabilities.capFavorites',
            nextDetection.defaultCapabilities.favorites
          );
          setValue(
            'capabilities.capTags',
            nextDetection.defaultCapabilities.tags
          );
          setValue(
            'capabilities.capSourceMatch',
            nextDetection.defaultCapabilities.sourceMatch
          );
        }
      } catch (error) {
        if (requestSeq !== detectRequestSeq.current) return;
        setDetection(null);
        setDetectError((error as Error).message);
      } finally {
        if (requestSeq === detectRequestSeq.current) {
          setDetecting(false);
        }
      }
    }, 600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedBaseUrl, setValue]);

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        if (!selectedEngine) {
          setSubmitError(
            'No engine selected. Wait for detection or choose manually.'
          );
          return;
        }
        setAddingBusy(true);
        setSubmitError(null);
        try {
          await onCreate(
            toBooruSiteCreatePayload(values, selectedEngine as BooruEngineType)
          );
          reset();
          setDetection(null);
          setDetectError(null);
          lastDetectedBaseUrl.current = null;
        } catch (error) {
          setSubmitError((error as Error).message);
        } finally {
          setAddingBusy(false);
        }
      })}
      className="row g-2"
    >
      <div className="col-md-6">
        <label
          htmlFor="booru-name"
          className="form-label text-sm mb-1 text-muted-foreground"
        >
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
          <div className="text-destructive text-sm mt-1">
            {errors.name.message}
          </div>
        ) : null}
      </div>
      <div className="col-md-6">
        <label
          htmlFor="booru-url"
          className="form-label text-sm mb-1 text-muted-foreground"
        >
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
          <div className="text-destructive text-sm mt-1">
            {errors.baseUrl.message}
          </div>
        ) : null}
      </div>

      {detecting ? (
        <div className="col-12 text-muted-foreground text-sm">
          Detecting engine…
        </div>
      ) : null}

      {detection && 'engine' in detection ? (
        <div className="col-12">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge text-bg-success">
              Detected: {ENGINE_LABELS[detection.engine]}
            </span>
            {devOptions ? (
              <span className="text-muted-foreground text-sm">
                via{' '}
                {detection.confidence === 'hostname'
                  ? 'known hostname'
                  : 'API probe'}
              </span>
            ) : null}
          </div>
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
                      <td className="text-muted-foreground">
                        {attempt.error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </div>
      ) : null}

      {selectedEngine ? (
        <>
          {detectedFields.username ? (
            <div className="col-md-6">
              <label
                className="form-label text-sm mb-1"
                htmlFor={addUsernameId}
              >
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
        </>
      ) : null}

      {detectError ? (
        <div className="col-12 text-destructive text-sm">{detectError}</div>
      ) : null}
      {submitError ? (
        <div className="col-12 text-destructive text-sm">{submitError}</div>
      ) : null}

      <div className="col-12 flex gap-2 mt-2">
        <button
          type="submit"
          className="btn btn-sm btn-outline-light"
          disabled={addingBusy || !selectedEngine}
        >
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
            lastDetectedBaseUrl.current = null;
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
    payload: ReturnType<typeof toBooruCredentialUpdatePayload>
  ) => Promise<BooruSite>;
  onTest: () => Promise<void>;
  onDelete: () => void;
};

export function BooruSiteCredentialForm({
  site,
  schema,
  loading,
  testing,
  onSave,
  onTest,
  onDelete
}: BooruSiteCredentialFormProps) {
  const fields = useMemo(() => credentialFieldsForSchema(schema), [schema]);
  const formSchema = useMemo(
    () => createBooruCredentialSchema(schema),
    [schema]
  );
  const usernameId = `site-${site.id}-username`;
  const apiKeyId = `site-${site.id}-api-key`;
  const { register, reset, handleSubmit } = useForm<BooruCredentialFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: site.username ?? '',
      apiKey: ''
    }
  });

  useEffect(() => {
    reset({
      username: site.username ?? '',
      apiKey: ''
    });
  }, [reset, site.id, site.username]);

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        const updated = await onSave(toBooruCredentialUpdatePayload(values));
        reset({
          username: updated.username ?? '',
          apiKey: ''
        });
      })}
      className="row g-2 mt-2"
    >
      {fields.username ? (
        <div className="col-md-4">
          <label
            className="form-label text-sm mb-1 text-muted-foreground"
            htmlFor={usernameId}
          >
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
          <label
            className="form-label text-sm mb-1 text-muted-foreground"
            htmlFor={apiKeyId}
          >
            {fields.apiKeyLabel}
            {site.hasApiKey ? (
              <span className="text-muted-foreground"> · saved</span>
            ) : null}
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
      <div className="col-12 flex flex-wrap items-end gap-2">
        <button
          type="submit"
          className="btn btn-sm btn-outline-light shrink-0 whitespace-nowrap"
          disabled={loading}
        >
          Save credentials
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-light shrink-0 whitespace-nowrap"
          onClick={() => void onTest()}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-danger shrink-0 whitespace-nowrap"
          onClick={() => onDelete()}
        >
          Delete site
        </button>
      </div>
    </form>
  );
}
