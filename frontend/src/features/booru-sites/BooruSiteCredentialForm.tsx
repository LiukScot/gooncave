import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

import {
  type BooruCredentialFormValues,
  createBooruCredentialSchema,
  toBooruCredentialUpdatePayload
} from './formSchemas';
import { credentialFieldsForSchema } from './shared';

import type { BooruCredentialSchema, BooruSite } from '@/api';

const SESSION_COOKIE_HELP = `Lets remote unfavorite work on Gelbooru-style sites (like rule34.xxx) where the API key alone redirects without actually deleting.

How to get it:
1. Log in to the site in your browser.
2. Open DevTools (F12) → Network tab, reload the page, then click any request to the site.
3. Under Request Headers, copy the whole "Cookie" value and paste it here as-is.

It expires over time; re-paste it if remote delete starts failing.`;

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
  const sessionCookieId = `site-${site.id}-session-cookie`;
  const { register, reset, handleSubmit } = useForm<BooruCredentialFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: site.username ?? '',
      apiKey: '',
      sessionCookie: ''
    }
  });

  useEffect(() => {
    reset({
      username: site.username ?? '',
      apiKey: '',
      sessionCookie: ''
    });
  }, [reset, site.id, site.username]);

  // Blank fields mean "keep" on save, so removing a stored secret needs an
  // explicit null. This is the only path that clears one.
  const clearSecret = (field: 'apiKey' | 'sessionCookie') =>
    void onSave({ [field]: null });

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        const updated = await onSave(toBooruCredentialUpdatePayload(values));
        reset({
          username: updated.username ?? '',
          apiKey: '',
          sessionCookie: ''
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
              <>
                <span className="text-muted-foreground"> · saved</span>
                <button
                  type="button"
                  className="btn btn-link btn-sm p-0 ms-2 align-baseline text-destructive"
                  onClick={() => clearSecret('apiKey')}
                  disabled={loading}
                >
                  clear
                </button>
              </>
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
      {site.engineSupportsSessionCookie ? (
        <div className="col-md-8">
          <label
            className="form-label text-sm mb-1 text-muted-foreground"
            htmlFor={sessionCookieId}
          >
            Session cookie
            {site.hasSessionCookie ? (
              <>
                <span className="text-muted-foreground"> · saved</span>
                <button
                  type="button"
                  className="btn btn-link btn-sm p-0 ms-2 align-baseline text-destructive"
                  onClick={() => clearSecret('sessionCookie')}
                  disabled={loading}
                >
                  clear
                </button>
              </>
            ) : null}
            <span
              className="favorites-help-dot"
              title={SESSION_COOKIE_HELP}
              aria-label={SESSION_COOKIE_HELP}
            >
              ?
            </span>
          </label>
          <input
            id={sessionCookieId}
            type="password"
            autoComplete="off"
            className="form-control form-control-sm bg-background text-foreground border-secondary"
            placeholder={site.hasSessionCookie ? '••••••••' : ''}
            {...register('sessionCookie')}
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
