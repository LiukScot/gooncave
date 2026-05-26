/**
 * useAuthController
 *
 * Owns auth state, mutations, form values, and the form-submission logic.
 * Returns formProps shaped to match AuthForm's Props interface.
 *
 * NOT owned here (stays in App.tsx):
 * - `authRequiredEvent` handler — must clear every domain's TanStack query
 *   cache, which it can do via `queryClient.removeQueries` without reaching
 *   into another feature's state.
 *
 * Cross-feature teardown on login/logout success is wired via the optional
 * `onLoginSuccess` / `onLogoutSuccess` callbacks: the shell uses them to
 * reset gallery state and close any open file-detail panel.
 */

import { useState } from 'react';

import { useCurrentUser, useLogin, useLogout, useRegister } from '@/hooks/auth';
import type { AuthUser } from '@/api';
import type { AuthMode, AuthFormValues } from '@/features/auth/AuthForm';

const authUsernameRegex = /^[a-zA-Z0-9_-]+$/;

export type AuthControllerResult = {
  authUser: AuthUser | null;
  /** True while currentUserQuery is loading (used for the initial loading gate in App). */
  authLoading: boolean;
  formProps: {
    mode: AuthMode;
    values: AuthFormValues;
    loading: boolean;
    error: string | null;
    onModeChange: (next: AuthMode) => void;
    onChange: (next: AuthFormValues) => void;
    onSubmit: () => void;
  };
  logout: () => Promise<void>;
};

export function useAuthController(options?: {
  onLoginSuccess?: () => void;
  onLogoutSuccess?: () => void;
}): AuthControllerResult {
  const currentUserQuery = useCurrentUser();
  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const logoutMutation = useLogout();

  const authUser = currentUserQuery.data ?? null;

  const authMutationError =
    (loginMutation.error as Error | null)?.message ??
    (registerMutation.error as Error | null)?.message ??
    null;

  const authPending =
    currentUserQuery.isLoading ||
    loginMutation.isPending ||
    registerMutation.isPending ||
    logoutMutation.isPending;

  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authForm, setAuthForm] = useState<AuthFormValues>({
    username: '',
    password: '',
    confirmPassword: ''
  });
  const [authLocalError, setAuthLocalError] = useState<string | null>(null);

  const error = authLocalError ?? authMutationError;

  const onModeChange = (next: AuthMode) => {
    setAuthMode(next);
    setAuthLocalError(null);
  };

  const onSubmit = () => {
    const username = authForm.username.trim();
    const password = authForm.password;

    if (!username || !password) {
      setAuthLocalError('Username and password are required');
      return;
    }
    if (username.length < 3) {
      setAuthLocalError('Username must be at least 3 characters');
      return;
    }
    if (username.length > 32) {
      setAuthLocalError('Username must be at most 32 characters');
      return;
    }
    if (!authUsernameRegex.test(username)) {
      setAuthLocalError('Username can only contain letters, numbers, _ and -');
      return;
    }
    if (password.length < 8) {
      setAuthLocalError('Password must be at least 8 characters');
      return;
    }
    if (authMode === 'register' && password !== authForm.confirmPassword) {
      setAuthLocalError('Passwords do not match');
      return;
    }

    setAuthLocalError(null);

    const run = async () => {
      try {
        if (authMode === 'register') {
          await registerMutation.mutateAsync({ username, password });
        } else {
          await loginMutation.mutateAsync({ username, password });
        }
        options?.onLoginSuccess?.();
        setAuthForm({ username: '', password: '', confirmPassword: '' });
      } catch {
        // Mutation error surfaces via authMutationError derived above.
      }
    };

    void run();
  };

  const logout = async () => {
    setAuthLocalError(null);
    try {
      await logoutMutation.mutateAsync();
    } catch (err) {
      // Server session may already be gone. Caller tears down local state
      // regardless; surface the warning so a real failure isn't silent.
      // eslint-disable-next-line no-console
      console.warn('logout request failed; clearing local state anyway', err);
    } finally {
      options?.onLogoutSuccess?.();
    }
  };

  return {
    authUser,
    authLoading: currentUserQuery.isLoading,
    formProps: {
      mode: authMode,
      values: authForm,
      loading: authPending,
      error,
      onModeChange,
      onChange: setAuthForm,
      onSubmit
    },
    logout
  };
}
