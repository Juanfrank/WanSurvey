import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, upload } from '../api.js';
import { smallBtn } from '../designer/fields.js';
import { dateTime } from '../format.js';
import { localiseError } from '../i18n-messages.js';
import { deviceId, keepOnDevice, type InterviewPayload } from '../interview/useInterview.js';
import { Button, FileInput } from '../routes/ui.js';

interface ScanForm {
  id: string;
  externalId: string;
  interviewId: string | null;
  status: 'review' | 'done' | 'duplicate';
  pagesExpected: number;
  pagesFound: number[];
  issues: { name: string; kind: string }[];
}
interface Batch {
  id: string;
  fileName: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  pages: number;
  error: string | null;
  createdAt: string;
  uploadedBy: string | null;
  forms: ScanForm[];
  unreadPages: { pageNo: number; problem: string }[];
}

const STATUS_CLS: Record<ScanForm['status'], string> = {
  review: 'bg-amber-100 text-amber-ink-900',
  done: 'bg-emerald-100 text-emerald-ink-900',
  duplicate: 'bg-slate-200 text-slate-800',
};

/**
 * Scanned paper forms: upload PDFs (each may hold many forms), see what was read, and finish
 * each form's second round in the keying screen.
 */
export function ScanForms({
  projectId,
  canComplete,
}: {
  projectId: string;
  /** Clerks finish forms in the keying screen; others only follow them. */
  canComplete: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const list = useQuery({
    queryKey: ['papi-scans', projectId],
    queryFn: () => api<Batch[]>(`/projects/${projectId}/papi/scans`),
    // Look again while something is still being read.
    refetchInterval: (q) =>
      q.state.data?.some((b) => b.status === 'queued' || b.status === 'running') ? 2000 : false,
  });
  const send = useMutation({
    mutationFn: () => {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      return upload<{ batches: string[] }>(`/projects/${projectId}/papi/scans`, form);
    },
    onSuccess: async (r) => {
      setMessage(t('papi.scans.uploaded', { count: r.batches.length }));
      setFiles([]);
      setInputKey((k) => k + 1);
      await qc.invalidateQueries({ queryKey: ['papi-scans', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  // The second round: this device takes the form's interview, which opens like any keyed form.
  const complete = async (f: ScanForm) => {
    try {
      const { interviewId } = await api<{ interviewId: string }>(
        `/projects/${projectId}/papi/scans/forms/${f.id}/claim`,
        { method: 'POST' },
      );
      const p = await api<InterviewPayload>(`/interviews/${interviewId}/takeover`, {
        method: 'POST',
        body: { deviceId: await deviceId() },
      });
      await keepOnDevice(p);
      await navigate({
        to: '/projects/$projectId/interviews/$interviewId',
        params: { projectId, interviewId },
      });
    } catch (e) {
      setMessage(localiseError(t, e));
    }
  };

  return (
    <section aria-labelledby="papi-scans" className="flex flex-col gap-3" data-testid="scans">
      <h2 id="papi-scans" className="text-base font-semibold">
        {t('papi.scans.title')}
      </h2>
      <p className="max-w-4xl text-slate-600">{t('papi.scans.help')}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (files.length) send.mutate();
        }}
      >
        <FileInput
          key={inputKey}
          label={t('papi.scans.choose')}
          accept="application/pdf,.pdf"
          multiple
          onChange={(e) => setFiles([...(e.target.files ?? [])])}
        />
        <Button type="submit" disabled={!files.length || send.isPending}>
          {t('papi.scans.upload')}
        </Button>
      </form>
      <p role="status" aria-live="polite" className="empty:hidden">
        {message}
      </p>
      {list.data && !list.data.length ? (
        <p className="text-slate-600">{t('papi.scans.none')}</p>
      ) : null}
      {(list.data ?? []).map((b) => (
        <article
          key={b.id}
          className="rounded-lg border border-slate-200 bg-white p-3"
          data-batch={b.fileName}
        >
          <header className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">
              {t('papi.scans.batch', {
                file: b.fileName,
                pages: b.pages,
                when: dateTime(b.createdAt),
              })}
            </h3>
            <span
              className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium"
              data-testid="batch-status"
            >
              {t(`papi.scans.status.${b.status}`)}
            </span>
            {b.error ? <span className="text-xs text-red-ink-800">{b.error}</span> : null}
          </header>
          {b.forms.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left">
                <thead className="text-xs text-slate-600">
                  <tr>
                    <th className="py-1 pr-3">{t('papi.scans.form')}</th>
                    <th className="py-1 pr-3">{t('papi.scans.pages')}</th>
                    <th className="py-1 pr-3">{t('papi.scans.state')}</th>
                    <th className="py-1 pr-3">{t('papi.scans.toCheck')}</th>
                    <th className="py-1">
                      <span className="sr-only">{t('papi.scans.complete')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {b.forms.map((f) => {
                    const counts = new Map<string, number>();
                    for (const i of f.issues) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
                    const short = f.pagesFound.length < f.pagesExpected;
                    return (
                      <tr key={f.id} data-form={f.externalId}>
                        <td className="py-1.5 pr-3 font-mono">{f.externalId}</td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {f.pagesFound.length}/{f.pagesExpected}
                          {short ? (
                            <span className="ml-1 text-xs text-red-ink-800">
                              {t('papi.scans.missingPages')}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_CLS[f.status]}`}>
                            {t(`papi.scans.formStatus.${f.status}`)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 text-xs text-slate-700">
                          {f.status === 'review'
                            ? [...counts]
                                .map(([k, n]) => `${n} ${t(`papi.scans.kinds.${k}`)}`)
                                .join(' · ')
                            : '—'}
                        </td>
                        <td className="py-1.5 text-right">
                          {canComplete && f.status === 'review' && f.interviewId ? (
                            <button
                              type="button"
                              className={smallBtn}
                              aria-label={t('papi.scans.completeCase', { id: f.externalId })}
                              onClick={() => void complete(f)}
                            >
                              {t('papi.scans.complete')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {b.unreadPages.length ? (
            <div className="mt-2 text-xs">
              <h4 className="font-semibold">{t('papi.scans.unread')}</h4>
              <ul className="list-disc pl-5 text-slate-700">
                {b.unreadPages.map((p) => (
                  <li key={p.pageNo}>
                    {t('papi.scans.page', { n: p.pageNo })}: {t(`papi.scans.problems.${p.problem}`)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}
