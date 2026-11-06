import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';

/**
 * "The person reached is not the one of the record": the case is closed as not eligible and the
 * interviews made with the wrong person are rejected, so no report counts them. Asks for what
 * happened first; it stays in the case's history.
 */
export function Misidentified({ projectId, caseId }: { projectId: string; caseId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/cases/${caseId}/misidentified`, {
        method: 'POST',
        body: { note: note.trim() },
      }),
    onSuccess: async () => {
      setOpen(false);
      setNote('');
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  if (!open)
    return (
      <button type="button" className={smallBtn} onClick={() => setOpen(true)}>
        {t('cases.misidentified.open')}
      </button>
    );
  return (
    <form
      className="flex w-full flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3"
      data-testid="misidentified"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        send.mutate();
      }}
    >
      <p>{t('cases.misidentified.explain')}</p>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('cases.misidentified.note')}</span>
        <textarea
          className={`${controlCls} min-h-[4rem]`}
          value={note}
          maxLength={1000}
          required
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className={smallBtn}
          disabled={note.trim().length < 3 || send.isPending}
        >
          {t('cases.misidentified.confirm')}
        </button>
        <button type="button" className={smallBtn} onClick={() => setOpen(false)}>
          {t('cases.misidentified.cancel')}
        </button>
      </div>
    </form>
  );
}
