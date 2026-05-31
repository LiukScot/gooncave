import { z } from 'zod';

import { ensureHttps } from '../../urlUtils';

import type { BooruEngineType } from '@/api';

const capabilitiesSchema = z.object({
  capFavorites: z.boolean(),
  capTags: z.boolean(),
  capSourceMatch: z.boolean()
});

const normalizedUrlSchema = z
  .string()
  .trim()
  .min(1, 'Base URL is required')
  .transform((value) => ensureHttps(value))
  .pipe(z.string().url('Base URL must be a valid URL'));

const trimStringSchema = z.string().transform((value) => value.trim());

export const booruSiteAddSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be at most 100 characters'),
  baseUrl: normalizedUrlSchema,
  username: trimStringSchema,
  apiKey: trimStringSchema,
  capabilities: capabilitiesSchema
});

export type BooruSiteAddFormValues = z.infer<typeof booruSiteAddSchema>;

export const createBooruCredentialSchema = (credentialSchema: string) =>
  z.object({
    username:
      credentialSchema === 'username+apikey' ||
      credentialSchema === 'userid+apikey'
        ? trimStringSchema
        : z.string().default(''),
    apiKey: trimStringSchema
  });

export type BooruCredentialFormValues = z.infer<
  ReturnType<typeof createBooruCredentialSchema>
>;

const toNullableTrimmed = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const toBooruSiteCreatePayload = (
  values: BooruSiteAddFormValues,
  engine: BooruEngineType
) => ({
  name: values.name.trim(),
  engine,
  baseUrl: ensureHttps(values.baseUrl),
  username: toNullableTrimmed(values.username),
  apiKey: toNullableTrimmed(values.apiKey),
  capFavorites: values.capabilities.capFavorites,
  capTags: values.capabilities.capTags,
  capSourceMatch: values.capabilities.capSourceMatch,
  enabled: true
});

export const toBooruCredentialUpdatePayload = (
  values: BooruCredentialFormValues
) => ({
  username: toNullableTrimmed(values.username),
  apiKey: toNullableTrimmed(values.apiKey)
});
