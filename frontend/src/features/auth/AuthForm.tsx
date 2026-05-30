import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { buildAuthFormSchema } from './authSchemas';

export type AuthMode = 'login' | 'register';

export type AuthFormValues = {
  username: string;
  password: string;
  confirmPassword: string;
};

type Props = {
  mode: AuthMode;
  loading: boolean;
  error: string | null;
  onModeChange: (mode: AuthMode) => void;
  onSubmit: (values: AuthFormValues) => Promise<void>;
};

export function AuthForm({ mode, loading, error, onModeChange, onSubmit }: Props) {
  const schema = useMemo(() => buildAuthFormSchema(mode), [mode]);
  const form = useForm<AuthFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      username: '',
      password: '',
      confirmPassword: '',
    },
  });
  const {
    register,
    reset,
    formState: { errors },
    handleSubmit,
  } = form;

  useEffect(() => {
    reset({
      username: '',
      password: '',
      confirmPassword: '',
    });
  }, [mode, reset]);

  return (
    <div className="bg-background text-foreground min-h-screen flex items-center justify-center px-4">
      <div className="card bg-black text-foreground border-secondary" style={{ width: '100%', maxWidth: 420 }}>
        <div className="card-body p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="h3 mb-1">GoonCave</h1>
              <div className="text-muted-foreground text-sm">Local-network sign-in</div>
            </div>
            <div className="btn-group btn-group-sm" role="group" aria-label="auth mode">
              <button
                type="button"
                className={`btn btn-${mode === 'login' ? 'primary' : 'outline-light'}`}
                onClick={() => onModeChange('login')}
              >
                Login
              </button>
              <button
                type="button"
                className={`btn btn-${mode === 'register' ? 'primary' : 'outline-light'}`}
                onClick={() => onModeChange('register')}
              >
                Register
              </button>
            </div>
          </div>
          <form
            onSubmit={handleSubmit(async (values) => {
              await onSubmit(values);
              reset({
                username: '',
                password: '',
                confirmPassword: '',
              });
            })}
          >
            <div className="mb-4">
              <label className="form-label" htmlFor="auth-username">Username</label>
              <input
                id="auth-username"
                name="username"
                type="text"
                className="form-control bg-background text-foreground border-secondary"
                {...register('username')}
                autoComplete="username"
              />
              {errors.username ? (
                <div className="text-destructive text-sm mt-1">{errors.username.message}</div>
              ) : null}
            </div>
            <div className="mb-4">
              <label className="form-label" htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                name="password"
                className="form-control bg-background text-foreground border-secondary"
                type="password"
                {...register('password')}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              {errors.password ? (
                <div className="text-destructive text-sm mt-1">{errors.password.message}</div>
              ) : null}
            </div>
            {mode === 'register' ? (
              <div className="mb-4">
                <label className="form-label" htmlFor="auth-confirm-password">Confirm password</label>
                <input
                  id="auth-confirm-password"
                  name="confirm-password"
                  className="form-control bg-background text-foreground border-secondary"
                  type="password"
                  {...register('confirmPassword')}
                  autoComplete="new-password"
                />
                {errors.confirmPassword ? (
                  <div className="text-destructive text-sm mt-1">
                    {errors.confirmPassword.message}
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? <div className="alert alert-danger py-2">{error}</div> : null}
            <button className="btn btn-primary w-full" type="submit" disabled={loading}>
              {loading ? 'Working…' : mode === 'login' ? 'Login' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
