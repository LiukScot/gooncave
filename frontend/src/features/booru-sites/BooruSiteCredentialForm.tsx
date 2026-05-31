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
