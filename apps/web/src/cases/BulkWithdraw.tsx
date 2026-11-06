import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';

/**
 * Withdraws the selected cases at once, with one reason for all of them, which goes in each
 * case's history. Cases someone is working on (on a device, in a call, finished) are skipped.
 */
export function BulkWithdraw({
  projectId,
  ids,
  onDone,
}: {
  projectId: string;
  ids: string[];
  onDone(message: string): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan('cases.edit', projectId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api<{ withdrawn: number; skipped: number }>(`/projects/${projectId}/cases/withdraw`, {
        method: 'POST',
        body: { caseIds: ids, reason: reason.trim() },
      }),
    onSuccess: async (r) => {
      setOpen(false);
      setReason('');
      setError('');
      onDone(t('cases.withdraw.done', { count: r.withdrawn, skipped: r.skipped }));
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  if (!can) return null;
  return (
    <>
      <button
        type="button"
        className={`${smallBtn} h-8 whitespace-nowrap`}
        disabled={!ids.length}
        onClick={() => setOpen(true)}
      >
        {t('cases.withdraw.open')}
      </button>
      {open ? (
        <Dialog
          title={t('cases.withdraw.title', { count: ids.length })}
          onClose={() => setOpen(false)}
        >
          <form
            className="flex flex-col gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              setError('');
              send.mutate();
            }}
          >
            <p>{t('cases.withdraw.help')}</p>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('cases.withdraw.reason')}</span>
              <textarea
                className={`${controlCls} min-h-[4rem]`}
                value={reason}
                maxLength={500}
                required
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error ? <p role="alert">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                {t('cases.detail.close')}
              </Button>
              <Button type="submit" disabled={reason.trim().length < 3 || send.isPending}>
                {t('cases.withdraw.confirm')}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
