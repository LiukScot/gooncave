/**
 * useAuthController
 *
 * Owns auth state and mutation side effects for the auth screen.
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

import type { AuthUser } from '@/api';
import type { AuthMode } from '@/features/auth/AuthForm';
import { toAuthSubmitPayload } from '@/features/auth/authSchemas';
import { useCurrentUser, useLogin, useLogout, useRegister } from '@/hooks/auth';

export type AuthControllerResult = {
  authUser: AuthUser | null;
  /** True while currentUserQuery is loading (used for the initial loading gate in App). */
  authLoading: boolean;
  formProps: {
    mode: AuthMode;
    loading: boolean;
    error: string | null;
    onModeChange: (next: AuthMode) => void;
    onSubmit: (values: {
      username: string;
      password: string;
      confirmPassword: string;
    }) => Promise<void>;
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
  const error = authMutationError;

  const onModeChange = (next: AuthMode) => {
    setAuthMode(next);
  };

  const onSubmit = async (values: {
    username: string;
    password: string;
    confirmPassword: string;
  }) => {
    const payload = toAuthSubmitPayload(values);
    if (authMode === 'register') {
      await registerMutation.mutateAsync(payload);
    } else {
      await loginMutation.mutateAsync(payload);
    }
    options?.onLoginSuccess?.();
  };

  const logout = async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (err) {
      // Server session may already be gone. Caller tears down local state
      // regardless; surface the warning so a real failure isn't silent.

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
      loading: authPending,
      error,
      onModeChange,
      onSubmit
    },
    logout
  };
}
