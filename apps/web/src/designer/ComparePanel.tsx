import { useQueries } from '@tanstack/react-query';
import { compareVersions, tryParse, type FieldChange } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls } from './fields.js';
import type { VersionSummary } from './hooks.js';
import { makeDescriber } from './useRouting.js';

type Pick = 'draft' | number;

const STATUS_CLS: Record<string, string> = {
  added: 'bg-emerald-100 text-emerald-900',
  removed: 'bg-red-100 text-red-900',
  changed: 'bg-amber-100 text-amber-900',
  moved: 'bg-sky-100 text-sky-900',
};

/** Two versions (or a version and the draft) side by side: what was added, removed, moved or edited. */
export function ComparePanel({
  projectId,
  qid,
  versions,
  draft,
}: {
  projectId: string;
  qid: string;
  versions: VersionSummary[];
  draft: Questionnaire | null;
}) {
  const { t } = useTranslation();
  const latest = versions[0]?.version ?? null;
  // Defaults to the latest version, following new publications until the person picks one.
  const [chosen, setFrom] = useState<Pick | null>(null);
  const from = chosen ?? latest ?? 'draft';
  const [to, setTo] = useState<Pick>('draft');
  const picks: Pick[] = [from, to];
  const loaded = useQueries({
    queries: picks.map((p) => ({
      queryKey: ['version', qid, p],
      queryFn: () =>
        api<{ definition: unknown }>(`/projects/${projectId}/questionnaires/${qid}/versions/${p}`),
      enabled: p !== 'draft',
      staleTime: Infinity,
    })),
  });
  const [a, b] = picks.map((p, i) => {
    if (p === 'draft') return draft;
    const parsed = Questionnaire.safeParse(loaded[i]!.data?.definition);
    return parsed.success ? parsed.data : null;
  });
  const result = useMemo(() => (a && b ? compareVersions(a, b) : null), [a, b]);
  const describeA = useMemo(() => (a ? makeDescriber(a, t) : null), [a, t]);
  const describeB = useMemo(() => (b ? makeDescriber(b, t) : null), [b, t]);
  const label = (p: Pick) => (p === 'draft' ? t('designer.compare.draft') : `v${p}`);
  const options: Pick[] = ['draft', ...versions.map((v) => v.version)];
  const parsePick = (v: string): Pick => (v === 'draft' ? 'draft' : Number(v));

  const logic = (src: string | null, describe: typeof describeA) => {
    if (!src) return '—';
    const r = tryParse(src);
    return describe ? describe(r.ok ? r.node : null, src) : src;
  };
  const cell = (c: FieldChange, side: 'before' | 'after') => {
    const v = c[side];
    if (c.kind === 'logic')
      return (
        <>
          {logic(v, side === 'before' ? describeA : describeB)}
          {v ? <code className="mt-0.5 block text-[11px] text-slate-500">{v}</code> : null}
        </>
      );
    return v === null || v === '' ? '—' : v;
  };
  const fieldName = (c: FieldChange) => (c.kind === 'text' ? `${c.field} (${c.lang})` : c.field);
  const table = (changes: FieldChange[], caption: string) => (
    <table className="w-full table-fixed text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead className="text-left text-slate-600">
        <tr>
          <th scope="col" className="w-1/4 px-2 py-1">
            {t('designer.compare.field')}
          </th>
          <th scope="col" className="px-2 py-1">
            {label(from)}
          </th>
          <th scope="col" className="px-2 py-1">
            {label(to)}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 align-top">
        {changes.map((c) => (
          <tr key={fieldName(c)}>
            <th scope="row" className="px-2 py-1 text-left font-mono font-normal">
              {fieldName(c)}
            </th>
            <td className="break-words px-2 py-1 text-slate-700">{cell(c, 'before')}</td>
            <td className="break-words px-2 py-1">{cell(c, 'after')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <section aria-labelledby="compare-h" className="flex flex-col gap-3" data-testid="compare">
      <h2 id="compare-h" className="font-semibold">
        {t('designer.compare.title')}
      </h2>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        {(
          [
            ['compare-from', t('designer.compare.from'), from, setFrom],
            ['compare-to', t('designer.compare.to'), to, setTo],
          ] as const
        ).map(([id, text, value, set]) => (
          <label key={id} className="flex flex-col gap-1">
            <span className="font-medium">{text}</span>
            <select
              id={id}
              className={`${controlCls} w-auto`}
              value={String(value)}
              onChange={(e) => set(parsePick(e.target.value))}
            >
              {options.map((o) => (
                <option key={String(o)} value={String(o)}>
                  {label(o)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {!result ? (
        <p aria-busy="true" className="text-sm text-slate-600">
          {t('designer.compare.loading')}
        </p>
      ) : (
        <>
          <p role="status" className="text-sm" data-testid="compare-summary">
            {result.items.length || result.questionnaire.length
              ? t('designer.compare.summary', result.counts)
              : t('designer.compare.same')}
          </p>
          {result.questionnaire.length ? (
            <div className="rounded-md border border-slate-200">
              <h3 className="border-b border-slate-200 bg-slate-50 px-2 py-1 text-sm font-medium">
                {t('designer.compare.questionnaire')}
              </h3>
              {table(result.questionnaire, t('designer.compare.questionnaire'))}
            </div>
          ) : null}
          <ul className="flex flex-col gap-2">
            {result.items.map((i) => (
              <li
                key={i.id}
                className="rounded-md border border-slate-200"
                data-compare-item={i.id}
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1 text-sm">
                  <span className={`rounded px-1.5 text-xs ${STATUS_CLS[i.status]}`}>
                    {t(`designer.compare.status.${i.status}`)}
                  </span>
                  <span className="font-mono">{i.name ?? i.id}</span>
                  <span className="text-xs text-slate-600">
                    {t(`designer.compare.kind.${i.kind}`)}
                  </span>
                  {i.moved ? (
                    <span className="text-xs text-slate-600">
                      {i.parentBefore !== i.parentAfter
                        ? t('designer.compare.movedTo', {
                            from: i.parentBefore ?? '—',
                            to: i.parentAfter ?? '—',
                          })
                        : t('designer.compare.reordered')}
                    </span>
                  ) : null}
                </div>
                {i.changes.length ? table(i.changes, i.name ?? i.id) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
