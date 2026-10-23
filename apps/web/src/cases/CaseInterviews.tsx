import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Mode } from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
import { CallList, type CallRow } from '../cati/CallsTab.js';
import { startInterview } from '../interview/useInterview.js';
import { Button } from '../routes/ui.js';
import { timeOnly } from '../format.js';

interface QuestionnaireRow {
  id: string;
  name: string;
  publishedVersions: number;
  modes?: Mode[];
}

const MODES: Mode[] = ['CAPI', 'CATI'];

/**
 * Start (or resume) an interview on a case. With one questionnaire in use it starts straight
 * away; with several, the person picks one first.
 */
export function StartInterview({
  projectId,
  caseId,
  externalId,
  resume,
}: {
  projectId: string;
  caseId: string;
  externalId: string;
  resume: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [qid, setQid] = useState('');
  const [picked, setMode] = useState<Mode>('CAPI');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () => api<QuestionnaireRow[]>(`/projects/${projectId}/questionnaires`),
  });
  // Interviewers start face-to-face or phone interviews, in the questionnaire's modes (Q1).
  const modesOf = (q?: QuestionnaireRow) =>
    MODES.filter((m) => !q?.modes?.length || q.modes.includes(m));
  const usable = (list.data ?? []).filter((q) => q.publishedVersions > 0 && modesOf(q).length > 0);
  const chosen = qid || usable[0]?.id || '';
  const offered = modesOf(usable.find((q) => q.id === chosen));
  const mode = offered.includes(picked) ? picked : (offered[0] ?? 'CAPI');

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const p = await startInterview(projectId, { caseId, questionnaireId: chosen, mode });
      await navigate({
        to: '/projects/$projectId/interviews/$interviewId',
        params: { projectId, interviewId: p.interview.id },
      });
    } catch (e) {
      setError(localiseError(t, e));
      setBusy(false);
    }
  };

  if (list.isSuccess && !usable.length)
    return <p className="text-slate-600">{t('interview.noQuestionnaire')}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="start-interview">
      {!open ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!list.isSuccess} onClick={() => setOpen(true)}>
            {resume ? t('interview.resumeCase') : t('interview.start')}
          </Button>
          {/* A phone case goes through the call screen: number, outcome, then the interview. */}
          {!resume && usable.some((q) => modesOf(q).includes('CATI')) ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void navigate({
                  to: '/projects/$projectId',
                  params: { projectId },
                  search: { tab: 'calls', call: caseId },
                })
              }
            >
              {t('interview.callCase')}
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3 rounded-md border border-indigo-200 bg-indigo-50 p-3"
          aria-label={t('interview.startTitle', { id: externalId })}
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          {usable.length > 1 ? (
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('interview.questionnaire')}</span>
              <select
                className={`${controlCls} w-auto`}
                value={chosen}
                onChange={(e) => setQid(e.target.value)}
              >
                {usable.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!resume ? (
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('interview.mode')}</span>
              <select
                className={`${controlCls} w-auto`}
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                {offered.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button type="submit" disabled={busy || !chosen}>
            {resume ? t('interview.resumeCase') : t('interview.start')}
          </Button>
          <button type="button" className={smallBtn} onClick={() => setOpen(false)}>
            {t('interview.close')}
          </button>
        </form>
      )}
      <p role="status" aria-live="polite" className="text-red-ink-800">
        {error}
      </p>
    </div>
  );
}

interface HistoryRow {
  id: string;
  status: string;
  mode: string;
  disposition: string | null;
  version: number;
  interviewer: string | null;
  startedAt: string;
  endedAt: string | null;
  events: {
    variable: string;
    oldValue: unknown;
    newValue: unknown;
    at: string;
    source: string;
    reason: string | null;
    by: string | null;
  }[];
}

const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** The case's interviews with every answer change: old and new value, who, when and why. */
export function InterviewHistory({ projectId, caseId }: { projectId: string; caseId: string }) {
  const { t } = useTranslation();
  const rows = useQuery({
    queryKey: ['case-interviews', caseId],
    queryFn: () => api<HistoryRow[]>(`/projects/${projectId}/cases/${caseId}/interviews`),
  });
  return (
    <section aria-labelledby="cd-interviews" data-testid="interviews">
      <h3 id="cd-interviews" className="mb-1 font-semibold">
        {t('interview.history')}
      </h3>
      {!rows.data?.length ? (
        <p className="text-slate-600">{t('interview.noHistory')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.data.map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 p-2" data-interview={r.id}>
              <p>
                <span className="font-medium">
                  {t(`interview.status.${r.status}`, { defaultValue: r.status })}
                </span>
                {r.disposition ? ` · ${dispositionLabel(t, r.disposition)}` : ''} ·{' '}
                {t('interview.historyRow', {
                  mode: r.mode,
                  version: r.version,
                  interviewer: r.interviewer ?? '—',
                })}
              </p>
              {r.events.length ? (
                <details>
                  <summary className="cursor-pointer text-sm">
                    {t('interview.change')} ({r.events.length})
                  </summary>
                  <div className="overflow-x-auto">
                    <table className="mt-1 w-full text-xs" data-testid="answer-history">
                      <thead className="text-left text-slate-600">
                        <tr>
                          <th scope="col">{t('interview.variable')}</th>
                          <th scope="col">{t('interview.from')}</th>
                          <th scope="col">{t('interview.to')}</th>
                          <th scope="col">{t('interview.when')}</th>
                          <th scope="col">{t('interview.who')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {r.events.map((e, i) => (
                          <tr key={i} data-reason={e.reason ?? undefined}>
                            <td className="font-mono">{e.variable}</td>
                            <td>{show(e.oldValue)}</td>
                            <td>
                              {show(e.newValue)}
                              {e.reason ? (
                                <span className="ml-1 text-slate-600">
                                  ({t(`interview.reason.${e.reason}`, { defaultValue: e.reason })})
                                </span>
                              ) : null}
                            </td>
                            <td>{timeOnly(e.at)}</td>
                            <td>{e.by ?? e.source}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The case's phone calls, newest first. */
export function CallHistory({ projectId, caseId }: { projectId: string; caseId: string }) {
  const { t } = useTranslation();
  const rows = useQuery({
    queryKey: ['case-calls', caseId],
    queryFn: () => api<CallRow[]>(`/projects/${projectId}/cases/${caseId}/calls`),
  });
  if (!rows.data?.length) return null;
  return (
    <section aria-labelledby="cd-calls" data-testid="case-calls">
      <h3 id="cd-calls" className="mb-1 font-semibold">
        {t('cati.drawer.title')}
      </h3>
      <CallList rows={rows.data} />
    </section>
  );
}
