import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { dispositionLabel, localiseError, modeLabel } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';

export const FLAG_KINDS = [
  'speeding',
  'straightlining',
  'warningsOverridden',
  'otherText',
  'doubleEntry',
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
}

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
  return (
    <span className="flex flex-wrap gap-1">
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

/** The review queue and the coding of "other" answers (R2, R6). */
export function ReviewTab({ projectId }: { projectId: string }) {
  const canCode = useCan('interviews.correct', projectId) || false;
  const canReview = useCan('interviews.review', projectId);
  return (
    <div className="flex flex-col gap-8 text-sm">
      <Queue projectId={projectId} />
      {canCode || canReview ? <Coding projectId={projectId} /> : null}
    </div>
  );
}

function Queue({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState(STATUSES[0]!);
  const [flag, setFlag] = useState('');
  const [mode, setMode] = useState('');
  const [sampled, setSampled] = useState(false);
  const [active, setActive] = useState(0);
  const table = useRef<HTMLTableSectionElement>(null);
  const params = new URLSearchParams({ status });
  if (flag) params.set('flag', flag);
  if (mode) params.set('mode', mode);
  if (sampled) params.set('sampled', 'true');
  const q = useQuery({
    queryKey: ['review-queue', projectId, params.toString()],
    queryFn: () =>
      api<{ total: number; rows: QueueRow[] }>(
        `/projects/${projectId}/review/queue?${params.toString()}`,
      ),
  });
  const rows = q.data?.rows ?? [];
  const open = (id: string) =>
    navigate({
      to: '/projects/$projectId/review/$interviewId',
      params: { projectId, interviewId: id },
    });

  useEffect(() => {
    table.current?.querySelector<HTMLElement>(`[data-row="${active}"] button`)?.focus();
  }, [active]);

  return (
    <section aria-labelledby="review-queue" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <h2 id="review-queue" className="text-base font-semibold">
          {t('review.queue.title')}
        </h2>
        <label className="flex flex-col gap-1">
          <span>{t('review.queue.status')}</span>
          <select
            className={`${controlCls} w-auto`}
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
        <label className="flex flex-col gap-1">
          <span>{t('review.queue.flag')}</span>
          <select
            className={`${controlCls} w-auto`}
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
          >
            <option value="">{t('review.queue.anyFlag')}</option>
            {FLAG_KINDS.map((f) => (
              <option key={f} value={f}>
                {t(`review.flags.${f}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('review.queue.mode')}</span>
          <select
            className={`${controlCls} w-auto`}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="">{t('review.queue.anyMode')}</option>
            {['CATI', 'CAPI', 'CAWI', 'PAPI'].map((m) => (
              <option key={m} value={m}>
                {modeLabel(t, m)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={sampled} onChange={(e) => setSampled(e.target.checked)} />
          {t('review.queue.sampled')}
        </label>
        <span className="pb-2 text-slate-600">
          {t('review.queue.total', { count: q.data?.total ?? 0 })} · {t('review.queue.keys')}
        </span>
      </div>
      {rows.length ? (
        <table className="w-full" data-testid="review-queue">
          <thead className="text-left text-slate-600">
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
            className="divide-y divide-slate-100"
            onKeyDown={(e) => {
              if ((e.target as HTMLElement).closest('input, select, textarea')) return;
              if (e.key === 'j' || e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === 'k' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              }
            }}
          >
            {rows.map((r, i) => (
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
  const overview = useQuery({
    queryKey: ['coding', projectId],
    queryFn: () =>
      api<{ variable: string; total: number; uncoded: number }[]>(`/projects/${projectId}/coding`),
  });
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
                    className="px-3 py-1 text-sm"
                    disabled={saveCodes.isPending}
                    onClick={() => saveCodes.mutate()}
                  >
                    {t('review.coding.saveCodes')}
                  </Button>
                </div>
              </fieldset>
              <table className="w-full max-w-2xl">
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
                  className="px-3 py-1.5 text-sm"
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
