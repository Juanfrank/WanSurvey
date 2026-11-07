import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import {
  buildQuery,
  paramQuestions,
  segmentLinks,
  valueProblem,
  withQuery,
  type ParamQuestion,
} from './linkParams.js';

interface Row {
  key: number;
  param: string;
  value: string;
}

/** The value box of one parameter, by what its question takes. */
function ValueField({
  q,
  value,
  onChange,
  label,
}: {
  q: ParamQuestion;
  value: string;
  onChange(v: string): void;
  label: string;
}) {
  const { t } = useTranslation();
  if (q.type === 'single' || q.type === 'yesno')
    return (
      <select
        className={`${controlCls} w-auto`}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('cawi.builder.pickValue')}</option>
        {q.options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label} ({o.code})
          </option>
        ))}
      </select>
    );
  if (q.type === 'multi') {
    const on = new Set(
      value
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean),
    );
    return (
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">{label}</legend>
        {q.options.map((o) => (
          <label key={o.code} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={on.has(o.code)}
              onChange={(e) => {
                const next = new Set(on);
                if (e.target.checked) next.add(o.code);
                else next.delete(o.code);
                onChange(
                  q.options
                    .filter((x) => next.has(x.code))
                    .map((x) => x.code)
                    .join(','),
                );
              }}
            />
            {o.label} ({o.code})
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <input
      className={`${controlCls} ${q.type === 'text' ? 'w-72' : 'w-48'}`}
      {...(q.type === 'text' ? { maxLength: q.maxLength ?? 500 } : {})}
      type={
        q.type === 'numeric' || q.type === 'scale' ? 'number' : q.type === 'date' ? 'date' : 'text'
      }
      {...(q.type === 'scale' && q.scale ? { min: q.scale.min, max: q.scale.max } : {})}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Builds the address of a web survey with questions answered beforehand, as link parameters
 * (`?sede=2&grupo=B`): the questions of the questionnaire that take a parameter, each with the
 * values it accepts, a live preview to copy, and, optionally, one address per value of one of
 * them to hand out by segment. A value the question would not take is marked: the survey would
 * drop it and ask.
 */
export function LinkBuilder({
  projectId,
  questionnaireId,
  baseUrl,
  onQueryChange,
  segments = true,
}: {
  projectId: string;
  questionnaireId: string;
  /** The address the parameters go on (the open link, or a case's link as an example). */
  baseUrl: string | null;
  /** Receives the query string as it is built, for addresses made elsewhere (every personal link). */
  onQueryChange?(query: string): void;
  segments?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const uid = useId();
  const detail = useQuery({
    queryKey: ['questionnaire', projectId, questionnaireId],
    queryFn: () =>
      api<{ latestVersion: number | null }>(
        `/projects/${projectId}/questionnaires/${questionnaireId}`,
      ),
  });
  const v = detail.data?.latestVersion ?? null;
  const version = useQuery({
    queryKey: ['questionnaire-version', projectId, questionnaireId, v],
    enabled: v !== null,
    queryFn: () =>
      api<{ definition: Parameters<typeof paramQuestions>[0] }>(
        `/projects/${projectId}/questionnaires/${questionnaireId}/versions/${v}`,
      ),
  });
  const questions = useMemo(
    () => (version.data ? paramQuestions(version.data.definition, i18n.language) : []),
    [version.data, i18n.language],
  );
  const byParam = new Map(questions.map((q) => [q.param, q]));

  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState(1);
  const [copied, setCopied] = useState('');
  const used = new Set(rows.map((r) => r.param));
  const free = questions.filter((q) => !used.has(q.param));
  const problems = rows.map((r) => {
    const q = byParam.get(r.param);
    return q ? valueProblem(q, r.value) : null;
  });
  const query = buildQuery(rows);
  const url = baseUrl ? withQuery(baseUrl, query) : null;
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);

  const [segmentParam, setSegmentParam] = useState('');
  const segmentQ = byParam.get(segmentParam);
  const segmentable = questions.filter(
    (q) => (q.type === 'single' || q.type === 'yesno' || q.type === 'scale') && q.options.length,
  );
  const [chosen, setChosen] = useState<string[] | null>(null);
  const segmentValues = segmentQ ? (chosen ?? segmentQ.options.map((o) => o.code)) : [];
  const links =
    baseUrl && segmentQ
      ? segmentLinks(
          baseUrl,
          rows.filter((r) => r.param !== segmentQ.param),
          segmentQ,
          segmentValues,
        )
      : [];

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied('');
    }
  };
  const csv = () => {
    const lines = [['value', 'label', 'url'], ...links.map((l) => [l.value, l.label, l.url])]
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines], { type: 'text/csv' }));
    a.download = `${segmentParam || 'enlaces'}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3"
      aria-labelledby={`${uid}-title`}
      data-testid="link-builder"
    >
      <h3 id={`${uid}-title`} className="font-semibold">
        {t('cawi.builder.title')}
      </h3>
      <p className="max-w-prose text-slate-600">{t('cawi.builder.help')}</p>
      {detail.isPending || (v !== null && version.isPending) ? (
        <p aria-busy="true">{t('cawi.builder.loading')}</p>
      ) : v === null ? (
        <p className="text-slate-600">{t('cawi.builder.notPublished')}</p>
      ) : questions.length === 0 ? (
        <p className="text-slate-600" data-testid="builder-none">
          {t('cawi.builder.none')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => {
              const q = byParam.get(r.param);
              return (
                <li
                  key={r.key}
                  className="flex flex-wrap items-start gap-2"
                  data-param-row={r.param}
                >
                  <select
                    className={`${controlCls} w-auto`}
                    value={r.param}
                    aria-label={t('cawi.builder.question', { n: i + 1 })}
                    onChange={(e) =>
                      setRows(
                        rows.map((x) =>
                          x.key === r.key ? { ...x, param: e.target.value, value: '' } : x,
                        ),
                      )
                    }
                  >
                    {[...(q ? [q] : []), ...free].map((o) => (
                      <option key={o.param} value={o.param}>
                        {o.text} · ?{o.param}
                      </option>
                    ))}
                  </select>
                  {q ? (
                    <ValueField
                      q={q}
                      value={r.value}
                      label={t('cawi.builder.value', { param: q.param })}
                      onChange={(value) =>
                        setRows(rows.map((x) => (x.key === r.key ? { ...x, value } : x)))
                      }
                    />
                  ) : null}
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                  >
                    {t('cawi.builder.remove')}
                  </button>
                  {q?.type === 'text' ? (
                    <p className="basis-full text-xs text-slate-600">
                      {t('cawi.builder.textNote', { max: q.maxLength ?? 500 })}
                    </p>
                  ) : null}
                  {problems[i] ? (
                    <p role="alert" className="basis-full text-xs font-medium text-red-ink-800">
                      {t(`cawi.builder.problems.${problems[i]}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div>
            <button
              type="button"
              className={smallBtn}
              disabled={free.length === 0}
              onClick={() => {
                setRows([...rows, { key: next, param: free[0]!.param, value: '' }]);
                setNext(next + 1);
              }}
            >
              {t('cawi.builder.add')}
            </button>
          </div>

          {url ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{t('cawi.builder.result')}</span>
              <code
                className="break-all rounded bg-slate-100 p-2 text-xs"
                data-testid="builder-url"
              >
                {url}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={smallBtn} onClick={() => void copy(url, 'url')}>
                  {t('cawi.builder.copy')}
                </button>
                <a className={smallBtn} href={url} target="_blank" rel="noopener noreferrer">
                  {t('cawi.builder.test')}
                </a>
                <span role="status" className="text-xs text-emerald-ink-800">
                  {copied === 'url' ? t('cawi.builder.copied') : ''}
                </span>
              </div>
              <p className="text-xs text-slate-600">{t('cawi.builder.hidden')}</p>
            </div>
          ) : null}

          {segments && segmentable.length ? (
            <fieldset className="flex flex-col gap-2 border-t border-slate-200 pt-3">
              <legend className="font-medium">{t('cawi.builder.segmentTitle')}</legend>
              <p className="max-w-prose text-xs text-slate-600">{t('cawi.builder.segmentHelp')}</p>
              <select
                className={`${controlCls} w-auto`}
                value={segmentParam}
                aria-label={t('cawi.builder.segmentBy')}
                onChange={(e) => {
                  setSegmentParam(e.target.value);
                  setChosen(null);
                }}
              >
                <option value="">{t('cawi.builder.segmentNone')}</option>
                {segmentable.map((q) => (
                  <option key={q.param} value={q.param}>
                    {q.text} · ?{q.param}
                  </option>
                ))}
              </select>
              {segmentQ ? (
                <>
                  <div className="flex flex-wrap gap-3">
                    {segmentQ.options.map((o) => (
                      <label key={o.code} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={segmentValues.includes(o.code)}
                          onChange={(e) =>
                            setChosen(
                              e.target.checked
                                ? [...segmentValues, o.code]
                                : segmentValues.filter((c) => c !== o.code),
                            )
                          }
                        />
                        {o.label} ({o.code})
                      </label>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="segment-links">
                      <thead>
                        <tr className="text-left text-xs text-slate-600">
                          <th scope="col" className="pr-4">
                            {t('cawi.builder.segment')}
                          </th>
                          <th scope="col">{t('cawi.links.url')}</th>
                          <th scope="col">
                            <span className="sr-only">{t('cawi.builder.copy')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {links.map((l) => (
                          <tr key={l.value} data-segment={l.value}>
                            <td className="pr-4">{l.label}</td>
                            <td className="break-all font-mono text-xs">{l.url}</td>
                            <td>
                              <button
                                type="button"
                                className={smallBtn}
                                aria-label={t('cawi.builder.copyOf', { name: l.label })}
                                onClick={() => void copy(l.url, l.value)}
                              >
                                {copied === l.value
                                  ? t('cawi.builder.copied')
                                  : t('cawi.builder.copy')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <button
                      type="button"
                      className={smallBtn}
                      onClick={csv}
                      disabled={!links.length}
                    >
                      {t('cawi.links.download')}
                    </button>
                  </div>
                </>
              ) : null}
            </fieldset>
          ) : null}
        </>
      )}
    </section>
  );
}
