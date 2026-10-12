import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, ssoStartUrl, type LoginResponse } from '../api.js';
import { AuthShell, Button, ErrorText, Field } from './ui.js';

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/login' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    search.sso_error
      ? t(`login.sso.${search.sso_error}`, { defaultValue: t('login.sso.generic') })
      : null,
  );
  const [ssoUrl, setSsoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSsoUrl(null);
    try {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      queryClient.removeQueries();
      if (res.mfaState === 'pending') await navigate({ to: '/login/2fa' });
      else if (res.mfaState === 'enroll') await navigate({ to: '/login/2fa/setup' });
      else await navigate({ to: '/' });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setError(
        code && i18n.exists(`login.errors.${code}`)
          ? t(`login.errors.${code}`)
          : t('login.errors.generic'),
      );
      if (err instanceof ApiError && typeof err.body.ssoStartUrl === 'string')
        setSsoUrl(ssoStartUrl(email));
    } finally {
      setBusy(false);
    }
  };

  const microsoft = () => {
    if (!email.includes('@')) {
      setError(t('login.microsoftNeedsEmail'));
      return;
    }
    window.location.assign(ssoStartUrl(email));
  };

  return (
    <AuthShell title={t('login.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <ErrorText>{error}</ErrorText>
        <Field
          id="email"
          label={t('login.email')}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          id="password"
          label={t('login.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" disabled={busy}>
          {t('login.submit')}
        </Button>
      </form>
      <div className="my-4 flex items-center gap-3 text-sm text-slate-500">
        <span className="h-px flex-1 bg-slate-200" />
        {t('login.or')}
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      {ssoUrl ? (
        <a
          href={ssoUrl}
          className="block rounded-md border border-slate-300 px-4 py-2 text-center font-medium hover:bg-slate-50"
        >
          {t('login.microsoft')}
        </a>
      ) : (
        <Button type="button" variant="secondary" className="w-full" onClick={microsoft}>
          {t('login.microsoft')}
        </Button>
      )}
    </AuthShell>
  );
}
