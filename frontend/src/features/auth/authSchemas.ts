import { z } from 'zod';

import type { AuthMode, AuthFormValues } from './AuthForm';

const authUsernameRegex = /^[a-zA-Z0-9_-]+$/;

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(authUsernameRegex, 'Username can only contain letters, numbers, _ and -');

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const buildAuthFormSchema = (mode: AuthMode) =>
  z
    .object({
      username: usernameSchema,
      password: passwordSchema,
      confirmPassword: z.string(),
    })
    .superRefine((value, ctx) => {
      if (mode === 'register' && value.password !== value.confirmPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Passwords do not match',
          path: ['confirmPassword'],
        });
      }
    });

export const toAuthSubmitPayload = (values: AuthFormValues) => ({
  username: values.username.trim(),
  password: values.password,
});
