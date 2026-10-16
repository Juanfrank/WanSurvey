import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { AuthShell, Button, ErrorText, Field } from './ui.js';

/** As the server requires (`MIN_PASSWORD_LENGTH`). */
const MIN = 10;

const tokenFromAddress = () => new URLSearchParams(window.location.search).get('token') ?? '';

/**
 * A new password from an e-mailed link: accepting an invitation (`/accept-invitation`), or
 * after a forgotten password (`/reset-password`). The link's token is the credential.
 */
function TokenPasswordPage({ kind }: { kind: 'accept' | 'reset' }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Someone who already has an account confirms with it: one field, no rules shown.
  const [existing, setExisting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN) return setError(t('password.tooShort', { min: MIN }));
    if (!existing && password !== repeat) return setError(t('password.mismatch'));
    setBusy(true);
    try {
      await api(kind === 'accept' ? '/auth/invitations/accept' : '/auth/password/reset', {
        method: 'POST',
        body: { token: tokenFromAddress(), password },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        setExisting(true);
        setError(t('password.wrongPassword'));
      } else
        setError(
          err instanceof ApiError && err.status === 400
            ? t('password.badLink')
            : t('password.generic'),
        );
    } finally {
      setBusy(false);
    }
  };

  const title = kind === 'accept' ? t('password.acceptTitle') : t('password.resetTitle');
  if (done)
    return (
      <AuthShell title={title}>
        <p role="status" className="mb-4">
          {kind === 'accept' ? t('password.acceptDone') : t('password.resetDone')}
        </p>
        <Link to="/login" className="font-semibold text-indigo-ink-700 underline">
          {t('password.toLogin')}
        </Link>
      </AuthShell>
    );
  return (
    <AuthShell title={title}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {kind === 'accept' ? (
          <p className="text-sm text-slate-600">{t('password.acceptHelp')}</p>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div>
          <Field
            id="new-password"
            label={t('password.password')}
            type="password"
            autoComplete={existing ? 'current-password' : 'new-password'}
            required
            value={password}
            aria-describedby="password-rules"
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="password-rules" className="mt-1 text-xs text-slate-600">
            {t('password.rules', { min: MIN })}
          </p>
        </div>
        {!existing ? (
          <Field
            id="repeat-password"
            label={t('password.repeat')}
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        ) : null}
        <Button type="submit" disabled={busy}>
          {kind === 'accept' ? t('password.acceptSave') : t('password.resetSave')}
        </Button>
      </form>
    </AuthShell>
  );
}

export const AcceptInvitationPage = () => <TokenPasswordPage kind="accept" />;
export const ResetPasswordPage = () => <TokenPasswordPage kind="reset" />;

/** Asks for a reset link; the answer is the same whether or not the e-mail has an account. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email: email.trim() } });
      setSent(true);
    } catch {
      setError(t('password.generic'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title={t('password.forgotTitle')}>
      {sent ? (
        <p role="status" className="mb-4">
          {t('password.forgotSent')}
        </p>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <p className="text-sm text-slate-600">{t('password.forgotHelp')}</p>
          <ErrorText>{error}</ErrorText>
          <Field
            id="forgot-email"
            label={t('login.email')}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" disabled={busy || !email.includes('@')}>
            {t('password.forgotSend')}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-4 inline-block text-sm text-indigo-ink-700 underline">
        {t('password.toLogin')}
      </Link>
    </AuthShell>
  );
}
