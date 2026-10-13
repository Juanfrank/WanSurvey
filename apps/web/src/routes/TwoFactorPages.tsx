import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { AuthShell, Button, ErrorText, Field } from './ui.js';

function CodeForm({
  submitLabel,
  onSubmit,
}: {
  submitLabel: string;
  onSubmit(code: string): Promise<void>;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit(code.trim());
    } catch {
      setError(t('twofa.invalid'));
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <ErrorText>{error}</ErrorText>
      <Field
        id="code"
        label={t('twofa.code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
      />
      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}

export function TwoFactorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <AuthShell title={t('twofa.title')}>
      <p className="mb-4 text-sm text-slate-600">{t('twofa.prompt')}</p>
      <CodeForm
        submitLabel={t('twofa.verify')}
        onSubmit={async (code) => {
          await api('/auth/2fa/verify', { method: 'POST', body: { code } });
          await navigate({ to: '/' });
        }}
      />
    </AuthShell>
  );
}

export function TwoFactorSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setup = useQuery({
    queryKey: ['2fa-setup'],
    queryFn: () =>
      api<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', { method: 'POST' }),
    staleTime: Infinity,
  });
  const enable = useMutation({
    mutationFn: (code: string) => api('/auth/2fa/enable', { method: 'POST', body: { code } }),
  });
  return (
    <AuthShell title={t('twofa.setupTitle')}>
      <p className="mb-4 text-sm text-slate-600">{t('twofa.setupIntro')}</p>
      {setup.data ? (
        <div className="mb-4 flex flex-col gap-2">
          <p className="text-sm font-medium">{t('twofa.secret')}</p>
          <code
            className="break-all rounded bg-slate-100 px-2 py-1 font-mono text-sm"
            data-testid="totp-secret"
          >
            {setup.data.secret}
          </code>
          <a className="text-sm text-indigo-ink-700 underline" href={setup.data.otpauthUrl}>
            {t('twofa.openApp')}
          </a>
        </div>
      ) : null}
      <CodeForm
        submitLabel={t('twofa.enable')}
        onSubmit={async (code) => {
          await enable.mutateAsync(code);
          await navigate({ to: '/' });
        }}
      />
    </AuthShell>
  );
}
