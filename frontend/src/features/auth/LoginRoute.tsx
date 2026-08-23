import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AuthForm } from '@/features/auth/AuthForm';
import { useAuthController } from '@/features/auth/useAuthController';

type LoginRouteSearch = {
  redirect?: string;
};

export function LoginRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as LoginRouteSearch;
  const auth = useAuthController({
    onLoginSuccess: () => {
      const target =
        typeof search.redirect === 'string' &&
        search.redirect.startsWith('/app/')
          ? search.redirect
          : '/app/gallery';
      void navigate({ to: target, replace: true });
    }
  });

  useEffect(() => {
    if (!auth.authLoading && auth.authUser) {
      void navigate({
        to: '/app/gallery',
        replace: true,
        search: { fileId: undefined, fs: undefined }
      });
    }
  }, [auth.authLoading, auth.authUser, navigate]);

  if (auth.authLoading && !auth.authUser) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Checking session…</div>
      </div>
    );
  }

  return <AuthForm {...auth.formProps} />;
}
