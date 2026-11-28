import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { dispositionLabel, localiseError, modeLabel } from '../i18n-messages.js';
import { Button, FilterBar, type ActiveFilter } from '../routes/ui.js';

export const FLAG_KINDS = [
  'speeding',
  'straightlining',
  'warningsOverridden',
  'otherText',
  'doubleEntry',
  'shortPages',
  'positionCluster',
  'farFromAddress',
] as const;

interface QueueRow {
  id: string;
  externalId: string | null;
  interviewer: string | null;
  mode: string;
  status: string;
  disposition: string | null;
  submittedAt: string | null;
  activeMs: number;
  flags: Record<string, unknown>;
  sampled: boolean;
  submissions: number;
  comments: number;
  /** Who keyed the second paper entry folded into this one, if any. */
  secondClerk?: string | null;
  /** Differences between the two paper entries still to resolve. */
  openDifferences?: number;
}

interface InterviewerCount {
  id: string;
  name: string | null;
  interviews: number;
  flagged: number;
}

/** The results a reviewer most often sorts by: complete interviews apart from the rest. */
const DISPOSITIONS = ['COMPLETE', 'PARTIAL', 'SCREENED_OUT', 'REFUSAL', 'BREAK_OFF', 'QUOTA_FULL'];

/** Rows of the queue shown at a time. */
const BLOCK = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = [
  'submitted,in_review',
  'submitted',
  'in_review',
  'approved',
  'returned',
  'rejected',
];

export const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Flag chips: warm colours for problems, with the text always written out. */
export function FlagChips({ flags }: { flags: Record<string, unknown> }) {
  const { t } = useTranslation();
  const set = FLAG_KINDS.filter((k) => flags[k] !== undefined);
  if (!set.length) return null;
  const risk = typeof flags.risk === 'number' ? flags.risk : 0;
  return (
    <span className="flex flex-wrap gap-1">
      {risk > 0 ? (
        <span
          className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-semibold text-rose-900"
          data-risk={risk}
        >
          {t('review.risk', { n: risk })}
        </span>
      ) : null}
      {set.map((k) => (
        <span
          key={k}
          className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-ink-900"
          data-flag={k}
        >
          {t(`review.flags.${k}`)}
        </span>
      ))}
    </span>
  );
}

/** The review queue (R2); the coding of "other" answers has a tab of its own (`CodingTab`). */
export function ReviewTab({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col gap-8 text-sm">
      <Queue projectId={projectId} />
    </div>
  );
}

/** The coding of "other" answers (R6), a tab beside the review queue. */
export function CodingTab({ projectId }: { projectId: string }) {
  return (
    <div className="text-sm">
      <Coding projectId={projectId} />
    </div>
  );
}

/** Who may code "other" answers: correctors and reviewers. */
export function useCanCode(projectId: string) {
  const canCode = useCan('interviews.correct', projectId);
  const canReview = useCan('interviews.review', projectId);
  return !!(canCode || canReview);
}

const useCodingOverview = (projectId: string) =>
  useQuery({
    queryKey: ['coding', projectId],
    queryFn: () =>
      api<{ variable: string; total: number; uncoded: number }[]>(`/projects/${projectId}/coding`),
  });

/** The coding tab's name, with how many "other" texts still wait for a code. */
export function CodingTabLabel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const overview = useCodingOverview(projectId);
  const pending = (overview.data ?? []).reduce((n, v) => n + v.uncoded, 0);
  return (
    <>
      {t('review.coding.tab')}
      {pending ? (
        <span className="tabular-nums" data-testid="coding-pending">
          {' · '}
          {pending}
        </span>
      ) : null}
    </>
  );
}

function Queue({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // The interviewer and result can come in the address (`?interviewer=`, `?result=`): a link
  // from Metrics opens the queue on one person's interviews.
  const raw = useSearch({ strict: false }) as { interviewer?: string; result?: string };
  // Only values the queue can ask for: a mistyped link opens the whole queue, not an error.
  const search = {
    interviewer: UUID.test(raw.interviewer ?? '') ? raw.interviewer!.toLowerCase() : undefined,
    result: DISPOSITIONS.includes(raw.result ?? '') ? raw.result : undefined,
  };
  const [status, setStatus] = useState(STATUSES[0]!);
  const [flag, setFlag] = useState('');
  const [mode, setMode] = useState('');
  const [disposition, setDispositionState] = useState(search.result ?? '');
  const [interviewer, setInterviewerState] = useState(search.interviewer ?? '');
  useEffect(() => setInterviewerState(search.interviewer ?? ''), [search.interviewer]);
  useEffect(() => setDispositionState(search.result ?? ''), [search.result]);
  /** A filter chosen here goes to the address too, so Back and reload keep it. */
  const keep = (key: 'interviewer' | 'result', value: string) =>
    void navigate({
      to: '.',
      search: (s: Record<string, unknown>) =>
        key === 'interviewer'
          ? { ...s, interviewer: value || undefined }
          : { ...s, result: value || undefined },
      replace: true,
    });
  const setInterviewer = (v: string) => {
    setInterviewerState(v);
    keep('interviewer', v);
  };
  const setDisposition = (v: string) => {
    setDispositionState(v);
    keep('result', v);
  };
  const [sampled, setSampled] = useState(false);
  const [byRisk, setByRisk] = useState(false);
  const [active, setActive] = useState(0);
  const table = useRef<HTMLTableSectionElement>(null);
  // Up to 200 at once, shown 20 at a time.
  const params = new URLSearchParams({ status, limit: '200' });
  if (flag) params.set('flag', flag);
  if (mode) params.set('mode', mode);
  if (disposition) params.set('disposition', disposition);
  if (interviewer) params.set('interviewerId', interviewer);
  if (sampled) params.set('sampled', 'true');
  if (byRisk) params.set('sort', 'risk');
  const q = useQuery({
    queryKey: ['review-queue', projectId, params.toString()],
    queryFn: () =>
      api<{ total: number; rows: QueueRow[]; interviewers?: InterviewerCount[] }>(
        `/projects/${projectId}/review/queue?${params.toString()}`,
      ),
  });
  const rows = q.data?.rows ?? [];
  const people = q.data?.interviewers ?? [];
  // The queue is shown by blocks of 20; a change of filters starts again from the first.
  const [visible, setVisible] = useState(BLOCK);
  const filtersKey = params.toString();
  useEffect(() => setVisible(BLOCK), [filtersKey]);
  const shown = rows.slice(0, visible);
  const open = (id: string) =>
    navigate({
      to: '/projects/$projectId/review/$interviewId',
      params: { projectId, interviewId: id },
    });

  useEffect(() => {
    table.current?.querySelector<HTMLElement>(`[data-row="${active}"] button`)?.focus();
  }, [active]);

  const selectCls = `${controlCls} w-auto`;
  const chips: ActiveFilter[] = [
    ...(flag
      ? [
          {
            id: 'flag',
            label: t('review.queue.flag'),
            value: t(`review.flags.${flag}`),
            onRemove: () => setFlag(''),
          },
        ]
      : []),
    ...(mode
      ? [
          {
            id: 'mode',
            label: t('review.queue.mode'),
            value: modeLabel(t, mode),
            onRemove: () => setMode(''),
          },
        ]
      : []),
    ...(disposition
      ? [
          {
            id: 'result',
            label: t('review.queue.result'),
            value: dispositionLabel(t, disposition),
            onRemove: () => setDisposition(''),
          },
        ]
      : []),
    ...(interviewer
      ? [
          {
            id: 'interviewer',
            label: t('review.queue.interviewer'),
            value:
              people.find((p) => p.id === interviewer)?.name ?? t('review.queue.chosenInterviewer'),
            onRemove: () => setInterviewer(''),
          },
        ]
      : []),
    ...(sampled
      ? [
          {
            id: 'sampled',
            label: t('review.queue.sampleChip'),
            value: t('review.queue.sampleOnly'),
            onRemove: () => setSampled(false),
          },
        ]
      : []),
    ...(byRisk
      ? [
          {
            id: 'risk',
            label: t('review.queue.order'),
            value: t('review.queue.byRisk'),
            onRemove: () => setByRisk(false),
          },
        ]
      : []),
  ];

  return (
    <section aria-labelledby="review-queue" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="review-queue" className="text-base font-semibold">
          {t('review.queue.title')}
        </h2>
        <FilterBar
          className="min-w-0 flex-1"
          lead={
            <label className="flex items-center gap-2">
              <span>{t('review.queue.status')}</span>
              <select
                className={selectCls}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`review.queue.statuses.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          }
          active={chips}
          count={t('review.queue.total', { count: q.data?.total ?? 0 })}
        >
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('review.queue.flag')}</span>
            <select className={selectCls} value={flag} onChange={(e) => setFlag(e.target.value)}>
              <option value="">{t('review.queue.anyFlag')}</option>
              {FLAG_KINDS.map((f) => (
                <option key={f} value={f}>
                  {t(`review.flags.${f}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('review.queue.mode')}</span>
            <select className={selectCls} value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">{t('review.queue.anyMode')}</option>
              {['CATI', 'CAPI', 'CAWI', 'PAPI'].map((m) => (
                <option key={m} value={m}>
                  {modeLabel(t, m)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('review.queue.result')}</span>
            <select
              className={selectCls}
              value={disposition}
              onChange={(e) => setDisposition(e.target.value)}
            >
              <option value="">{t('review.queue.anyResult')}</option>
              {DISPOSITIONS.map((d) => (
                <option key={d} value={d}>
                  {dispositionLabel(t, d)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('review.queue.interviewer')}</span>
            <select
              className={selectCls}
              value={interviewer}
              onChange={(e) => setInterviewer(e.target.value)}
            >
              <option value="">{t('review.queue.anyInterviewer')}</option>
              {/* Chosen in a link (from Metrics) but with nothing under these filters. */}
              {interviewer && !people.some((p) => p.id === interviewer) ? (
                <option value={interviewer}>{t('review.queue.chosenInterviewer')}</option>
              ) : null}
              {/* Each person with how many interviews wait and how many have flags. */}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {[
                    p.name ?? '—',
                    t('review.queue.personCount', { count: p.interviews }),
                    ...(p.flagged ? [t('review.queue.personFlagged', { count: p.flagged })] : []),
                  ].join(' · ')}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-2 pb-1">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={byRisk}
                onChange={(e) => setByRisk(e.target.checked)}
              />
              {t('review.queue.byRisk')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sampled}
                onChange={(e) => setSampled(e.target.checked)}
              />
              {t('review.queue.sampled')}
            </label>
          </div>
        </FilterBar>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap" data-testid="review-queue">
            <thead className="text-left text-slate-600 [&_th]:pr-4">
              <tr>
                <th scope="col">{t('review.queue.case')}</th>
                <th scope="col">{t('review.queue.interviewer')}</th>
                <th scope="col">{t('review.queue.mode')}</th>
                <th scope="col">{t('review.queue.status')}</th>
                <th scope="col">{t('review.queue.submitted')}</th>
                <th scope="col">{t('review.queue.length')}</th>
                <th scope="col">{t('review.queue.flags')}</th>
              </tr>
            </thead>
            <tbody
              ref={table}
              className="divide-y divide-slate-100 [&_td]:pr-4"
              onKeyDown={(e) => {
                if ((e.target as HTMLElement).closest('input, select, textarea')) return;
                if (e.key === 'j' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(shown.length - 1, a + 1));
                } else if (e.key === 'k' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                }
              }}
            >
              {shown.map((r, i) => (
                <tr
                  key={r.id}
                  data-row={i}
                  data-interview={r.id}
                  data-case={r.externalId ?? ''}
                  className={i === active ? 'bg-indigo-50' : ''}
                >
                  <td className="py-1.5">
                    <button
                      type="button"
                      className="font-medium text-indigo-ink-700 underline"
                      onFocus={() => setActive(i)}
                      onClick={() => void open(r.id)}
                      aria-label={t('review.queue.open', { id: r.externalId ?? r.id.slice(0, 8) })}
                    >
                      {r.externalId ?? r.id.slice(0, 8)}
                    </button>
                    {r.sampled ? (
                      <span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-ink-900">
                        {t('review.queue.sampleBadge')}
                      </span>
                    ) : null}
                    {r.submissions > 1 ? (
                      <span className="ml-1 text-xs text-slate-600">
                        {t('review.queue.round', { n: r.submissions })}
                      </span>
                    ) : null}
                    {r.secondClerk ? (
                      <span
                        className={`ml-1 rounded px-1 text-xs ${r.openDifferences ? 'bg-amber-100 text-amber-ink-900' : 'bg-slate-100 text-slate-700'}`}
                        data-testid="double-entry"
                      >
                        {r.openDifferences
                          ? t('review.queue.doubleOpen', {
                              count: r.openDifferences,
                              name: r.secondClerk,
                            })
                          : t('review.queue.doubleDone', { name: r.secondClerk })}
                      </span>
                    ) : null}
                  </td>
                  <td>{r.interviewer ?? '—'}</td>
                  <td>{modeLabel(t, r.mode)}</td>
                  <td>
                    {t(`interview.status.${r.status}`, { defaultValue: r.status })}
                    {r.disposition ? ` · ${dispositionLabel(t, r.disposition)}` : ''}
                  </td>
                  <td>
                    {r.submittedAt
                      ? new Date(r.submittedAt).toLocaleString(i18n.language, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })
                      : '—'}
                  </td>
                  <td className="tabular-nums">{minutes(r.activeMs)}</td>
                  <td>
                    <FlagChips flags={r.flags} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown.length ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                className={smallBtn}
                data-testid="queue-more"
                onClick={() => setVisible((v) => v + BLOCK)}
              >
                {t('review.queue.more', {
                  n: Math.min(BLOCK, rows.length - shown.length),
                  count: rows.length - shown.length,
                })}
              </button>
            </div>
          ) : (q.data?.total ?? 0) > rows.length ? (
            <p className="mt-3 text-slate-700" data-testid="queue-capped">
              {t('review.queue.capped', { n: rows.length })}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-slate-600">{t('review.queue.keys')}</p>
        </div>
      ) : (
        <p className="text-slate-600">{t('review.queue.none')}</p>
      )}
    </section>
  );
}

interface CodingDetail {
  variable: string;
  codes: { code: number; label: string }[];
  texts: { key: string; text: string; count: number; code: number | null }[];
}

function Coding({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const overview = useCodingOverview(projectId);
  const [variable, setVariable] = useState('');
  const current = variable || overview.data?.[0]?.variable || '';
  const detail = useQuery({
    queryKey: ['coding', projectId, current],
    queryFn: () => api<CodingDetail>(`/projects/${projectId}/coding/${current}`),
    enabled: !!current,
  });
  const [codes, setCodes] = useState<{ code: number; label: string }[]>([]);
  useEffect(() => setCodes(detail.data?.codes ?? []), [detail.data?.codes]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const refresh = async (d: CodingDetail) => {
    qc.setQueryData(['coding', projectId, current], d);
    await qc.invalidateQueries({ queryKey: ['coding', projectId], exact: true });
  };
  const saveCodes = useMutation({
    mutationFn: () =>
      api<CodingDetail>(`/projects/${projectId}/coding/${current}/codes`, {
        method: 'PUT',
        body: { codes: codes.filter((c) => c.code && c.label.trim()) },
      }),
    onSuccess: refresh,
    onError: (e) => setMessage(localiseError(t, e)),
  });
  const assign = useMutation({
    mutationFn: () =>
      api<CodingDetail & { changed: number }>(`/projects/${projectId}/coding/${current}/assign`, {
        method: 'POST',
        body: {
          texts: detail.data!.texts.filter((x) => picked.has(x.key)).map((x) => x.text),
          code: code ? Number(code) : null,
        },
      }),
    onSuccess: async (d) => {
      setMessage(t('review.coding.applied', { count: d.changed }));
      setPicked(new Set());
      await refresh(d);
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });

  return (
    <section aria-labelledby="review-coding" className="flex flex-col gap-3">
      <h2 id="review-coding" className="text-base font-semibold">
        {t('review.coding.title')}
      </h2>
      {!overview.data?.length ? (
        <p className="text-slate-600">{t('review.coding.empty')}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label={t('review.coding.variables')}>
            <ul className="flex flex-col gap-1">
              {overview.data.map((v) => (
                <li key={v.variable}>
                  <button
                    type="button"
                    aria-current={v.variable === current ? 'true' : undefined}
                    className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-indigo-50 aria-[current=true]:bg-indigo-100"
                    onClick={() => setVariable(v.variable)}
                  >
                    <span className="font-mono">{v.variable}</span>
                    <span className="text-xs text-slate-600">{t('review.coding.uncoded', v)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {detail.data ? (
            <div className="flex flex-col gap-4" data-testid="coding">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">{t('review.coding.codes')}</legend>
                {codes.map((c, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="number"
                      aria-label={t('review.coding.code')}
                      className={`${controlCls} w-24`}
                      value={c.code || ''}
                      onChange={(e) =>
                        setCodes(
                          codes.map((x, j) =>
                            j === i ? { ...x, code: Number(e.target.value) } : x,
                          ),
                        )
                      }
                    />
                    <input
                      aria-label={t('review.coding.label')}
                      className={`${controlCls} flex-1`}
                      value={c.label}
                      onChange={(e) =>
                        setCodes(
                          codes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                ))}
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() =>
                      setCodes([
                        ...codes,
                        { code: Math.max(0, ...codes.map((c) => c.code)) + 1, label: '' },
                      ])
                    }
                  >
                    {t('review.coding.addCode')}
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saveCodes.isPending}
                    onClick={() => saveCodes.mutate()}
                  >
                    {t('review.coding.saveCodes')}
                  </Button>
                </div>
              </fieldset>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="text-left text-slate-600">
                    <tr>
                      <th scope="col">
                        <span className="sr-only">{t('review.coding.select', { text: '' })}</span>
                      </th>
                      <th scope="col">{t('review.coding.texts')}</th>
                      <th scope="col">{t('review.coding.count')}</th>
                      <th scope="col">{t('review.coding.code')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {detail.data.texts.map((x) => (
                      <tr key={x.key} data-text={x.key}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t('review.coding.select', { text: x.text })}
                            checked={picked.has(x.key)}
                            onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(x.key);
                              else next.delete(x.key);
                              setPicked(next);
                            }}
                          />
                        </td>
                        <td className="py-1">{x.text}</td>
                        <td className="tabular-nums">{x.count}</td>
                        <td>
                          {x.code === null
                            ? '—'
                            : `${x.code} ${detail.data!.codes.find((c) => c.code === x.code)?.label ?? ''}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span>{t('review.coding.assign')}</span>
                  <select
                    className={`${controlCls} w-auto`}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  >
                    <option value="">{t('review.coding.none')}</option>
                    {detail.data.codes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={!picked.size || assign.isPending}
                  onClick={() => assign.mutate()}
                >
                  {t('review.coding.apply')}
                </Button>
              </div>
              <p
                role="status"
                aria-live="polite"
                className="empty:hidden"
                data-testid="coding-message"
              >
                {message}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
