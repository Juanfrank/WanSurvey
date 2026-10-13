import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';
import { ErrorText } from '../routes/ui.js';

/**
 * A data subject's requests for one case (H3): download what is held about them, or erase
 * their personal data. Both are recorded in the audit log.
 */
export function PersonalData({
  projectId,
  caseId,
  externalId,
  anonymisedAt,
}: {
  projectId: string;
  caseId: string;
  externalId: string;
  anonymisedAt: string | null;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const pii = useCan('pii.view', projectId);
  const all = useCan('cases.read_all', projectId);
  const edit = useCan('cases.edit', projectId);
  const canSee = pii && all;
  const canErase = pii && edit;
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const download = useMutation({
    mutationFn: () => api(`/projects/${projectId}/cases/${caseId}/subject-data`),
    onSuccess: (data) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `datos-${externalId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const erase = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/cases/${caseId}/erase`, { method: 'POST', body: { note } }),
    onSuccess: async () => {
      setConfirming(false);
      setDone(t('cases.privacy.erased'));
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  if (!canSee && !canErase) return null;
  return (
    <section
      aria-labelledby="cd-privacy"
      className="flex flex-col gap-2"
      data-testid="personal-data"
    >
      <h3 id="cd-privacy" className="font-semibold">
        {t('cases.privacy.title')}
      </h3>
      {anonymisedAt ? (
        <p className="text-slate-600">
          {t('cases.privacy.anonymised', {
            date: new Date(anonymisedAt).toLocaleDateString(i18n.language),
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canSee ? (
          <button type="button" className={smallBtn} onClick={() => download.mutate()}>
            {t('cases.privacy.download')}
          </button>
        ) : null}
        {canErase && !anonymisedAt && !confirming ? (
          <button type="button" className={smallBtn} onClick={() => setConfirming(true)}>
            {t('cases.privacy.erase')}
          </button>
        ) : null}
      </div>
      {confirming ? (
        <form
          className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            erase.mutate();
          }}
        >
          <p>{t('cases.privacy.eraseHelp')}</p>
          <label className="flex flex-col gap-1">
            {t('cases.privacy.note')}
            <input
              className={controlCls}
              value={note}
              required
              minLength={3}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800"
              disabled={erase.isPending}
            >
              {t('cases.privacy.confirm')}
            </button>
            <button type="button" className={smallBtn} onClick={() => setConfirming(false)}>
              {t('cases.privacy.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      <p role="status" aria-live="polite">
        {done}
      </p>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
