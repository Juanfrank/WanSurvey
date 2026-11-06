import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';
import { controlCls } from './fields.js';
import { useCan } from './hooks.js';

interface Request {
  id: string;
  draftRevision: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'consumed';
  note: string | null;
  requestedByName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}
export interface ApprovalState {
  required: boolean;
  draftRevision: number;
  current: Request | null;
  requests: Request[];
}

/** Whether the draft, as it stands, may be published (no approval asked, or approved). */
export const approvedToPublish = (a: ApprovalState | undefined) =>
  !a ||
  !a.required ||
  (a.current?.status === 'approved' && a.current.draftRevision === a.draftRevision);

/**
 * Approval before publishing, for projects that ask for it: the author asks for the draft as it
 * stands; someone else with the permission approves it or says what to change. Any later change
 * to the draft asks for a new request.
 */
export function ApprovalSection({
  projectId,
  qid,
  revision,
  state,
}: {
  projectId: string;
  qid: string;
  revision: number;
  state: ApprovalState | undefined;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canApprove = useCan('questionnaires.approve', projectId);
  const url = `/projects/${projectId}/questionnaires/${qid}`;
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['approval', qid] });
  const ask = useMutation({
    mutationFn: () =>
      api(`${url}/approval/request`, {
        method: 'POST',
        body: { baseRevision: revision, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: async () => {
      setNote('');
      setError('');
      await refresh();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) =>
      api(`${url}/approval/${v.id}/decide`, {
        method: 'POST',
        body: { approve: v.approve, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: async () => {
      setNote('');
      setError('');
      await refresh();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  if (!state?.required) return null;
  const cur = state.current;
  const forThisDraft = !!cur && cur.draftRevision === state.draftRevision;
  const last = state.requests[0];
  return (
    <section aria-labelledby="approval-h" className="flex flex-col gap-2" data-testid="approval">
      <h3 id="approval-h" className="font-semibold">
        {t('designer.approval.title')}
      </h3>
      <p className="text-slate-600">{t('designer.approval.help')}</p>
      {cur && forThisDraft ? (
        <p role="status">
          {cur.status === 'approved'
            ? t('designer.approval.approved', { name: cur.decidedByName ?? '—' })
            : t('designer.approval.pending', { name: cur.requestedByName ?? '—' })}
          {cur.note ? <span className="block italic">“{cur.note}”</span> : null}
        </p>
      ) : (
        <p role="status">
          {last?.status === 'rejected'
            ? t('designer.approval.rejected', {
                name: last.decidedByName ?? '—',
                note: last.decisionNote ?? '',
              })
            : cur
              ? t('designer.approval.stale')
              : t('designer.approval.none')}
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {!(cur && forThisDraft && cur.status === 'approved') ? (
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('designer.approval.note')}</span>
          <input
            className={controlCls}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!(cur && forThisDraft) ? (
          <Button type="button" disabled={ask.isPending} onClick={() => ask.mutate()}>
            {t('designer.approval.ask')}
          </Button>
        ) : null}
        {canApprove && cur && forThisDraft && cur.status === 'pending' ? (
          <>
            <Button
              type="button"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: cur.id, approve: true })}
            >
              {t('designer.approval.approve')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={decide.isPending || !note.trim()}
              onClick={() => decide.mutate({ id: cur.id, approve: false })}
            >
              {t('designer.approval.reject')}
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** The approval state of a questionnaire (kept fresh while the dialog is open). */
export function useApproval(projectId: string, qid: string, enabled: boolean) {
  return useQuery({
    queryKey: ['approval', qid],
    queryFn: () => api<ApprovalState>(`/projects/${projectId}/questionnaires/${qid}/approval`),
    enabled,
    refetchInterval: 15_000,
  });
}
