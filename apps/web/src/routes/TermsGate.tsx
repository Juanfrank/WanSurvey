import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { termsPage } from '../about/content.js';
import { api } from '../api.js';
import { InfoShell, useFacts } from './InfoPages.js';
import { Button, ErrorText } from './ui.js';

/**
 * What a person sees until they accept the current terms of use and confidentiality undertaking:
 * the text, a box to tick and a button. The acceptance is kept with its version and date.
 */
export function TermsGate({ version, onSignOut }: { version: number; onSignOut(): void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const facts = useFacts();
  const [ticked, setTicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: () => api('/auth/terms/accept', { method: 'POST', body: { version } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError: () => setError(t('info.termsFailed')),
  });
  if (!facts.data) return <main className="p-8 text-slate-500" aria-busy="true" />;
  return (
    <InfoShell
      page={termsPage(facts.data, i18n.resolvedLanguage !== 'en')}
      extra={
        <form
          className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-4"
          data-testid="terms-gate"
          onSubmit={(e) => {
            e.preventDefault();
            if (ticked) accept.mutate();
          }}
        >
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={ticked}
              onChange={(e) => setTicked(e.target.checked)}
            />
            <span>{t('info.termsAccept')}</span>
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!ticked || accept.isPending}>
              {t('info.termsButton')}
            </Button>
            <button type="button" className="text-sm underline" onClick={onSignOut}>
              {t('info.termsSignOut')}
            </button>
          </div>
        </form>
      }
    />
  );
}
