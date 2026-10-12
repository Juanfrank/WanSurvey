import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';
import { startInterview } from '../interview/useInterview.js';
import { Button } from '../routes/ui.js';

interface Mismatch {
  id: string;
  externalId: string;
  variable: string;
  firstValue: unknown;
  secondValue: unknown;
}

const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Paper forms: keying by clerks, printing, and the double-entry differences (P1–P4). */
export function PaperTab({ projectId, notice }: { projectId: string; notice?: string }) {
  const canClerk = useCan('dataentry.key', projectId);
  const canConduct = useCan('interviews.conduct', projectId);
  const canKey = canClerk || canConduct;
  const canReview = useCan('interviews.review', projectId);
  return (
    <div className="flex flex-col gap-8 text-sm">
      {canKey ? <KeyForm projectId={projectId} notice={notice} /> : null}
      {canReview ? <Mismatches projectId={projectId} /> : null}
      <PrintForms projectId={projectId} />
    </div>
  );
}

function KeyForm({ projectId, notice }: { projectId: string; notice?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [message, setMessage] = useState(notice === 'entry_done' ? t('papi.key.done') : '');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const qs = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; publishedVersions: number }[]>(
        `/projects/${projectId}/questionnaires`,
      ),
  });
  const qid = qs.data?.find((q) => q.publishedVersions > 0)?.id;

  const go = async () => {
    if (!id.trim() || !qid) return;
    setBusy(true);
    setMessage('');
    try {
      const found = await api<{ caseId: string; pass: number; resume: string | null }>(
        `/projects/${projectId}/papi/lookup?externalId=${encodeURIComponent(id.trim())}`,
      );
      const interviewId =
        found.resume ??
        (
          await startInterview(projectId, {
            caseId: found.caseId,
            questionnaireId: qid,
            mode: 'PAPI',
          })
        ).interview.id;
      await navigate({
        to: '/projects/$projectId/interviews/$interviewId',
        params: { projectId, interviewId },
      });
    } catch (e) {
      setMessage(localiseError(t, e));
      setBusy(false);
      input.current?.select();
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      aria-labelledby="papi-key"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <h2 id="papi-key" className="text-base font-semibold">
        {t('papi.key.title')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('papi.key.caseId')}</span>
          <input
            ref={input}
            className={`${controlCls} w-64 font-mono text-base`}
            value={id}
            autoFocus
            autoComplete="off"
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !id.trim() || !qid}>
          {t('papi.key.start')}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="empty:hidden" data-testid="key-message">
        {message}
      </p>
    </form>
  );
}

function PrintForms({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(20);
  return (
    <form
      className="flex flex-col gap-2"
      aria-labelledby="papi-print"
      onSubmit={(e) => {
        e.preventDefault();
        void navigate({
          to: '/projects/$projectId/papi/print',
          params: { projectId },
          search: { ...(filter.trim() ? { filter: filter.trim() } : {}), limit },
        });
      }}
    >
      <h2 id="papi-print" className="text-base font-semibold">
        {t('papi.print.title')}
      </h2>
      <p className="text-slate-600">{t('papi.print.help')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('papi.print.filter')}</span>
          <input
            className={`${controlCls} w-72 font-mono`}
            value={filter}
            placeholder="case.region == 1"
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('papi.print.limit')}</span>
          <input
            type="number"
            min={1}
            max={200}
            className={`${controlCls} w-24`}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
          />
        </label>
        <Button type="submit">{t('papi.print.open')}</Button>
      </div>
    </form>
  );
}

function Mismatches({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['papi-mismatches', projectId],
    queryFn: () => api<Mismatch[]>(`/projects/${projectId}/papi/mismatches`),
  });
  const [message, setMessage] = useState('');
  const resolve = useMutation({
    mutationFn: (v: { m: Mismatch; choice: 'first' | 'second' }) =>
      api<{ caseFinished: boolean }>(`/projects/${projectId}/papi/mismatches/${v.m.id}/resolve`, {
        method: 'POST',
        body: { choice: v.choice },
      }),
    onSuccess: async (r, v) => {
      setMessage(
        r.caseFinished
          ? `${t('papi.mismatches.resolved', { variable: v.m.variable, id: v.m.externalId })} ${t('papi.mismatches.finished', { id: v.m.externalId })}`
          : t('papi.mismatches.resolved', { variable: v.m.variable, id: v.m.externalId }),
      );
      await qc.invalidateQueries({ queryKey: ['papi-mismatches', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  return (
    <section aria-labelledby="papi-mismatches" className="flex flex-col gap-2">
      <h2 id="papi-mismatches" className="text-base font-semibold">
        {t('papi.mismatches.title')}
      </h2>
      <p role="status" aria-live="polite" className="empty:hidden" data-testid="mismatch-message">
        {message}
      </p>
      {list.data?.length ? (
        <table className="w-full max-w-3xl" data-testid="mismatches">
          <thead className="text-left text-slate-600">
            <tr>
              <th scope="col">{t('papi.mismatches.case')}</th>
              <th scope="col">{t('papi.mismatches.question')}</th>
              <th scope="col">{t('papi.mismatches.first')}</th>
              <th scope="col">{t('papi.mismatches.second')}</th>
              <th scope="col">
                <span className="sr-only">{t('cases.list.columns')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data.map((m) => (
              <tr key={m.id} data-mismatch={`${m.externalId}:${m.variable}`}>
                <td className="py-1.5 font-medium">{m.externalId}</td>
                <td className="font-mono">{m.variable}</td>
                <td className="font-mono">{show(m.firstValue)}</td>
                <td className="font-mono">{show(m.secondValue)}</td>
                <td className="flex flex-wrap gap-2 py-1">
                  <button
                    type="button"
                    className={smallBtn}
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ m, choice: 'first' })}
                  >
                    {t('papi.mismatches.keepFirst')}
                    <span className="sr-only">
                      {' '}
                      {m.externalId} {m.variable}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={smallBtn}
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ m, choice: 'second' })}
                  >
                    {t('papi.mismatches.useSecond')}
                    <span className="sr-only">
                      {' '}
                      {m.externalId} {m.variable}
                    </span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-slate-600">{t('papi.mismatches.none')}</p>
      )}
    </section>
  );
}
