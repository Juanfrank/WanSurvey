import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, FoldedHelp, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { number } from '../format.js';
import { localiseError } from '../i18n-messages.js';
import { startInterview } from '../interview/useInterview.js';
import { Button } from '../routes/ui.js';
import { ScanForms } from './ScanForms.js';

interface Mismatch {
  id: string;
  externalId: string;
  variable: string;
  firstValue: unknown;
  secondValue: unknown;
  /** Who keyed each entry. */
  firstClerk: string | null;
  secondClerk: string | null;
}
interface Agreement {
  forms: number;
  formsWithDifferences: number;
  clerks: { name: string; forms: number; errors: number }[];
  variables: { variable: string; differences: number }[];
}
type Choice = { choice: 'first' | 'second' } | { choice: 'other'; value: unknown; note?: string };

/**
 * What the supervisor typed, as the question holds it: a number when the entries are numbers
 * (with a decimal point or comma), a list of codes when they are lists. `undefined` when it
 * cannot be one (empty, or not a number where a number is expected).
 */
export function typedValue(text: string, m: Pick<Mismatch, 'firstValue' | 'secondValue'>): unknown {
  const v = text.trim();
  if (!v) return undefined;
  const numeric = (x: string) => /^-?\d+([.,]\d+)?$/.test(x);
  const both = [m.firstValue, m.secondValue];
  if (both.some(Array.isArray))
    return v
      .split(/[\s;]+|,\s*/)
      .filter(Boolean)
      .map((x) => (numeric(x) ? Number(x.replace(',', '.')) : x));
  if (both.some((x) => typeof x === 'number'))
    return numeric(v) ? Number(v.replace(',', '.')) : undefined;
  return v;
}

const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Paper forms: keying by clerks, printing, and the double-entry differences (P1–P4). */
export function PaperTab({
  projectId,
  notice,
  questionnaireId,
}: {
  projectId: string;
  notice?: string;
  /** The questionnaire whose forms are keyed and printed; without it, the first published. */
  questionnaireId?: string;
}) {
  const canClerk = useCan('dataentry.key', projectId);
  const canConduct = useCan('interviews.conduct', projectId);
  const canKey = canClerk || canConduct;
  const canReview = useCan('interviews.review', projectId);
  // Scans are uploaded by clerks and by whoever runs the fieldwork.
  const canAll = useCan('cases.read_all', projectId);
  const canScan = canKey || canAll;
  return (
    <div className="flex flex-col gap-8 text-sm">
      {canKey ? (
        <KeyForm projectId={projectId} notice={notice} questionnaireId={questionnaireId} />
      ) : null}
      {canScan ? <ScanForms projectId={projectId} canComplete={canClerk} /> : null}
      {canReview ? <Mismatches projectId={projectId} /> : null}
      <PrintForms projectId={projectId} questionnaireId={questionnaireId} />
    </div>
  );
}

function KeyForm({
  projectId,
  notice,
  questionnaireId,
}: {
  projectId: string;
  notice?: string;
  questionnaireId?: string;
}) {
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
  const qid = qs.data?.find(
    (q) => q.publishedVersions > 0 && (!questionnaireId || q.id === questionnaireId),
  )?.id;

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

function PrintForms({
  projectId,
  questionnaireId,
}: {
  projectId: string;
  questionnaireId?: string;
}) {
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
          search: {
            ...(filter.trim() ? { filter: filter.trim() } : {}),
            limit,
            ...(questionnaireId ? { q: questionnaireId } : {}),
          },
        });
      }}
    >
      <h2 id="papi-print" className="text-base font-semibold">
        {t('papi.print.title')}
      </h2>
      <FoldedHelp className="max-w-prose">{t('papi.print.help')}</FoldedHelp>
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
        <a
          className={`${smallBtn} inline-flex h-9 items-center`}
          href={`/api/v1/projects/${projectId}/papi/scan-forms.pdf?${new URLSearchParams({
            ...(filter.trim() ? { filter: filter.trim() } : {}),
            limit: String(limit),
            ...(questionnaireId ? { questionnaireId } : {}),
          }).toString()}`}
          download
          data-testid="scan-forms-pdf"
        >
          {t('papi.scans.download')}
        </a>
      </div>
      <FoldedHelp className="max-w-prose">{t('papi.scans.downloadHelp')}</FoldedHelp>
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
  const agreement = useQuery({
    queryKey: ['papi-agreement', projectId],
    queryFn: () => api<Agreement>(`/projects/${projectId}/papi/agreement`),
  });
  // What to say, not the text, so it follows the interface language.
  const [message, setMessage] = useState<
    { variable: string; id: string; finished: boolean } | { error: unknown } | null
  >(null);
  // The difference whose right value is being typed (both entries wrong).
  const [typing, setTyping] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: (v: { m: Mismatch } & Choice) => {
      const { m, ...body } = v;
      return api<{ caseFinished: boolean }>(
        `/projects/${projectId}/papi/mismatches/${m.id}/resolve`,
        { method: 'POST', body },
      );
    },
    onSuccess: async (r, v) => {
      setMessage({ variable: v.m.variable, id: v.m.externalId, finished: r.caseFinished });
      setTyping(null);
      await qc.invalidateQueries({ queryKey: ['papi-mismatches', projectId] });
      await qc.invalidateQueries({ queryKey: ['papi-agreement', projectId] });
    },
    onError: (e) => setMessage({ error: e }),
  });
  const a = agreement.data;
  return (
    <section aria-labelledby="papi-mismatches" className="flex flex-col gap-2">
      <h2 id="papi-mismatches" className="text-base font-semibold">
        {t('papi.mismatches.title')}
      </h2>
      {a && a.forms > 0 ? (
        <div className="flex flex-col gap-1 text-slate-700" data-testid="entry-agreement">
          <p>
            {t('papi.mismatches.agreement', {
              count: a.forms,
              differ: a.formsWithDifferences,
              agree: `${number((100 * (a.forms - a.formsWithDifferences)) / a.forms, 1)} %`,
            })}
          </p>
          {a.clerks.length ? (
            <p>
              {t('papi.mismatches.byClerk')}{' '}
              {a.clerks
                .map((c) =>
                  t('papi.mismatches.clerkErrors', {
                    name: c.name,
                    errors: c.errors,
                    count: c.forms,
                  }),
                )
                .join(' · ')}
            </p>
          ) : null}
          {a.variables.length ? (
            <p>
              {t('papi.mismatches.byVariable')}{' '}
              {a.variables.map((v) => `${v.variable} (${v.differences})`).join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="empty:hidden" data-testid="mismatch-message">
        {!message
          ? null
          : 'error' in message
            ? localiseError(t, message.error)
            : message.finished
              ? `${t('papi.mismatches.resolved', message)} ${t('papi.mismatches.finished', message)}`
              : t('papi.mismatches.resolved', message)}
      </p>
      {list.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="mismatches">
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
                <tr
                  key={m.id}
                  className="align-top"
                  data-mismatch={`${m.externalId}:${m.variable}`}
                >
                  <td className="py-1.5 font-medium">{m.externalId}</td>
                  <td className="py-1.5 font-mono">{m.variable}</td>
                  <td className="py-1.5">
                    <span className="font-mono">{show(m.firstValue)}</span>
                    {m.firstClerk ? (
                      <span className="block text-xs text-slate-600">
                        {t('papi.mismatches.by', { name: m.firstClerk })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5">
                    <span className="font-mono">{show(m.secondValue)}</span>
                    {m.secondClerk ? (
                      <span className="block text-xs text-slate-600">
                        {t('papi.mismatches.by', { name: m.secondClerk })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1">
                    {typing === m.id ? (
                      <OtherValue
                        m={m}
                        busy={resolve.isPending}
                        onCancel={() => setTyping(null)}
                        onSave={(value, note) =>
                          resolve.mutate({ m, choice: 'other', value, ...(note ? { note } : {}) })
                        }
                      />
                    ) : (
                      <div className="flex flex-wrap gap-2">
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
                        <button
                          type="button"
                          className={smallBtn}
                          disabled={resolve.isPending}
                          onClick={() => setTyping(m.id)}
                        >
                          {t('papi.mismatches.other')}
                          <span className="sr-only">
                            {' '}
                            {m.externalId} {m.variable}
                          </span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-slate-600">{t('papi.mismatches.none')}</p>
      )}
    </section>
  );
}

/** Both entries wrong: the value read on the paper form, and why, kept in the audit log. */
function OtherValue({
  m,
  busy,
  onSave,
  onCancel,
}: {
  m: Mismatch;
  busy: boolean;
  onSave(value: unknown, note: string): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const parsed = typedValue(value, m);
  // Shown once something is typed that the question cannot hold.
  const wrong = !!value.trim() && parsed === undefined;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={t('papi.mismatches.otherTitle', { variable: m.variable, id: m.externalId })}
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed !== undefined) onSave(parsed, note.trim());
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">{t('papi.mismatches.otherValue')}</span>
        <input
          className={`${controlCls} w-28 font-mono`}
          value={value}
          autoFocus
          aria-invalid={wrong ? true : undefined}
          aria-describedby={wrong ? `other-${m.id}-error` : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {wrong ? (
          <span id={`other-${m.id}-error`} className="text-xs text-red-ink-800">
            {t('papi.mismatches.notNumber')}
          </span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">{t('papi.mismatches.note')}</span>
        <input
          className={`${controlCls} w-56`}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <Button type="submit" size="sm" disabled={busy || parsed === undefined}>
        {t('papi.mismatches.save')}
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
        {t('papi.mismatches.cancel')}
      </Button>
    </form>
  );
}
