import { z } from 'zod';

import { ensureHttps } from '../../urlUtils';

import type { BooruEngineType } from '@/api';

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
  sessionCookie: z.string().default(''),
  cookieA: z.string().default(''),
  cookieB: z.string().default('')
});

export type BooruSiteAddFormInput = z.input<typeof booruSiteAddSchema>;
export type BooruSiteAddFormValues = z.output<typeof booruSiteAddSchema>;

export const createBooruCredentialSchema = (credentialSchema: string) =>
  z
    .object({
      username:
        credentialSchema === 'username+apikey' ||
        credentialSchema === 'userid+apikey' ||
        credentialSchema === 'username+session-cookie'
          ? trimStringSchema
          : z.string().default(''),
      apiKey: trimStringSchema,
      sessionCookie: z.string().default(''),
      cookieA: z.string().default(''),
      cookieB: z.string().default('')
    })
    .superRefine((values, context) => {
      if (credentialSchema !== 'username+session-cookie') return;
      if (Boolean(values.cookieA.trim()) === Boolean(values.cookieB.trim())) {
        return;
      }
      const missingField = values.cookieA.trim() ? 'cookieB' : 'cookieA';
      context.addIssue({
        code: 'custom',
        path: [missingField],
        message: 'Cookie a and Cookie b must be entered together'
      });
    });

/**
 * `.default('')` makes the parsed output differ from what the form holds
 * before validation, so the two sides are named separately: the form is typed
 * on the input, submit handlers receive the output.
 */
export type BooruCredentialFormInput = z.input<
  ReturnType<typeof createBooruCredentialSchema>
>;

export type BooruCredentialFormValues = z.output<
  ReturnType<typeof createBooruCredentialSchema>
>;

const toNullableTrimmed = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const toBooruSiteCreatePayload = (
  values: BooruSiteAddFormValues,
  engine: BooruEngineType
) => {
  const furAffinityCookie =
    engine === 'furaffinity'
      ? `a=${values.cookieA.trim()}; b=${values.cookieB.trim()}`
      : null;
  return {
    name: values.name.trim(),
    engine,
    baseUrl: ensureHttps(values.baseUrl),
    username: toNullableTrimmed(values.username),
    apiKey: toNullableTrimmed(values.apiKey),
    sessionCookie:
      engine === 'furaffinity'
        ? furAffinityCookie
        : toNullableTrimmed(values.sessionCookie),
    enabled: true
  };
};

// `null` explicitly clears a stored value; an omitted field leaves it
// unchanged. The normal save path only ever omits (keep) — `null` is reached
// solely via the explicit "clear" affordance.
export type BooruCredentialUpdatePayload = {
  username?: string | null;
  apiKey?: string | null;
  sessionCookie?: string | null;
};

export const toBooruCredentialUpdatePayload = (
  values: BooruCredentialFormValues,
  credentialSchema?: string
): BooruCredentialUpdatePayload => {
  // apiKey and sessionCookie are write-only: the form never renders the saved
  // value, so it always loads blank. A blank field therefore means "leave
  // unchanged", NOT "clear" — otherwise saving one secret (e.g. just the
  // session cookie) would wipe the other. Only send a secret the user actually
  // typed; omitting it makes the backend keep the stored value.
  const payload: {
    username: string | null;
    apiKey?: string;
    sessionCookie?: string;
  } = {
    username: toNullableTrimmed(values.username)
  };
  const apiKey = values.apiKey.trim();
  if (apiKey) payload.apiKey = apiKey;
  const sessionCookie =
    credentialSchema === 'username+session-cookie' &&
    values.cookieA &&
    values.cookieB
      ? `a=${values.cookieA.trim()}; b=${values.cookieB.trim()}`
      : values.sessionCookie.trim();
  if (sessionCookie) payload.sessionCookie = sessionCookie;
  return payload;
};
