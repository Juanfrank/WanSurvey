import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedbackItem } from '@wansurvey/schema/feedback';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Field } from '../routes/ui.js';
import { EMOJI, Face } from './Faces.js';

export interface FeedbackPoint {
  id: string;
  name: string;
  question: Record<string, string>;
  faces: 3 | 5;
  askComment: boolean;
  active: boolean;
  slug: string;
  url: string;
  counts: Record<string, number>;
  createdAt?: string;
  updatedAt?: string;
  version: number;
  items: FeedbackItem[];
}

interface Results {
  point: FeedbackPoint;
  counts: Record<string, number>;
  channels: Record<string, number>;
  comments: { score: number; comment: string; ref: string | null; at: string }[];
  itemCounts?: Record<string, Record<string, number>>;
  texts?: { item: string; score: number; text: string; ref: string | null; at: string }[];
}

const btn =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50 aria-pressed:border-indigo-600 aria-pressed:bg-indigo-50';

/** Share of answers on the best face (3 faces) or the best two (5 faces). */
export function satisfied(p: { faces: 3 | 5; counts: Record<string, number> }) {
  const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const good = p.faces === 3 ? (p.counts[3] ?? 0) : (p.counts[4] ?? 0) + (p.counts[5] ?? 0);
  return good / total;
}

/** The quick-feedback points of a project (they sit in its questionnaire list). */
export function useFeedbackPoints(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['feedback', projectId],
    queryFn: () => api<FeedbackPoint[]>(`/projects/${projectId}/feedback`),
    enabled,
  });
}

export interface FeedbackDraft {
  question: string;
  faces: 3 | 5;
  askComment: boolean;
}

/** The parts of the new-item form that only quick feedback has: question, faces, comment. */
export function FeedbackFields({
  value,
  onChange,
}: {
  value: FeedbackDraft;
  onChange(v: FeedbackDraft): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="feedback-fields">
      <Field
        id="fb-question"
        label={t('feedback.question')}
        value={value.question}
        placeholder={t('feedback.questionDefault')}
        onChange={(e) => onChange({ ...value, question: e.target.value })}
      />
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium text-slate-700">{t('feedback.faces')}</legend>
        {([3, 5] as const).map((n) => (
          <label key={n} className="flex items-center gap-2">
            <input
              type="radio"
              name="fb-faces"
              checked={value.faces === n}
              onChange={() => onChange({ ...value, faces: n })}
            />
            <span className="flex -space-x-1" aria-hidden>
              {Array.from({ length: n }, (_, i) => (
                <Face key={i} score={i + 1} faces={n} size={20} />
              ))}
            </span>
            {t(`feedback.faces${n}`)}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.askComment}
          onChange={(e) => onChange({ ...value, askComment: e.target.checked })}
        />
        {t('feedback.askComment')}
      </label>
    </div>
  );
}

/** The faces of a point, small, as its icon in lists. */
export function FacesIcon({ faces }: { faces: 3 | 5 }) {
  return (
    <span className="inline-flex -space-x-1 align-middle" aria-hidden>
      {Array.from({ length: faces }, (_, i) => (
        <Face key={i} score={i + 1} faces={faces} size={18} />
      ))}
    </span>
  );
}

function CopyBox({ label, value, id }: { label: string; value: string; id: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-start gap-2">
        <textarea
          id={id}
          readOnly
          rows={value.includes('\n') ? 4 : 1}
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs"
          value={value}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className={btn}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            })
          }
        >
          {t('feedback.copy')}
        </button>
      </div>
      <span role="status" className="text-xs text-emerald-ink-800">
        {done ? t('feedback.copied') : ''}
      </span>
    </div>
  );
}

/** One link per face, and ready-made code for an e-mail and for a web page. */
export function FeedbackLinks({ point }: { point: FeedbackPoint }) {
  const { t } = useTranslation();
  const scores = Array.from({ length: point.faces }, (_, i) => i + 1);
  const labels = t(`feedback.labels${point.faces}`, { returnObjects: true }) as string[];
  const html = [
    '<table role="presentation" cellpadding="6"><tr>',
    ...scores.map(
      (s) =>
        `  <td align="center"><a href="${point.url}?r=${s}" style="font-size:36px;text-decoration:none" title="${labels[s - 1]}">${EMOJI[point.faces][s - 1]}</a><br><span style="font:12px sans-serif">${labels[s - 1]}</span></td>`,
    ),
    '</tr></table>',
  ].join('\n');
  const iframe = `<iframe src="${point.url}?embed=1" title="${point.name}" width="380" height="${point.askComment ? 320 : 190}" style="border:0"></iframe>`;
  return (
    <div className="flex flex-col gap-4 rounded-md bg-slate-50 p-3" data-testid="feedback-links">
      <p className="text-sm text-slate-600">{t('feedback.linksHelp')}</p>
      <ul className="flex flex-col gap-1.5">
        {scores.map((s) => (
          <li key={s} className="flex flex-wrap items-center gap-2 text-sm">
            <Face score={s} faces={point.faces} size={24} />
            <span className="w-24">{labels[s - 1]}</span>
            <code
              className="min-w-0 break-all rounded bg-white px-1.5 py-0.5"
              aria-label={t('feedback.linkOf', { n: s })}
            >
              {`${point.url}?r=${s}`}
            </code>
            <a
              className="text-indigo-ink-700 underline"
              href={`${point.url}?r=${s}`}
              target="_blank"
              rel="noreferrer"
            >
              {t('feedback.open')}
            </a>
          </li>
        ))}
      </ul>
      <CopyBox id={`fb-html-${point.id}`} label={t('feedback.emailCode')} value={html} />
      <CopyBox id={`fb-iframe-${point.id}`} label={t('feedback.iframeCode')} value={iframe} />
    </div>
  );
}

/** Counts per face and channel, the latest comments, and keying of paper slips. */
export function FeedbackResults({ projectId, point }: { projectId: string; point: FeedbackPoint }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const results = useQuery({
    queryKey: ['feedback-results', point.id],
    queryFn: () => api<Results>(`/projects/${projectId}/feedback/${point.id}/results`),
  });
  const labels = t(`feedback.labels${point.faces}`, { returnObjects: true }) as string[];
  const key = useMutation({
    mutationFn: (score: number) =>
      api(`/projects/${projectId}/feedback/${point.id}/paper`, { method: 'POST', body: { score } }),
    onSuccess: async (_r, score) => {
      setStatus(t('feedback.keyed', { label: labels[score - 1] }));
      await qc.invalidateQueries({ queryKey: ['feedback-results', point.id] });
      await qc.invalidateQueries({ queryKey: ['feedback', projectId] });
    },
  });
  const data = results.data;
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div
      className="grid gap-4 rounded-md bg-slate-50 p-3 md:grid-cols-2"
      data-testid="feedback-results"
    >
      <div className="flex flex-col gap-2">
        <table className="w-full text-sm">
          <caption className="mb-1 text-left font-medium">
            {t('feedback.answers', { count: total })}
          </caption>
          <tbody>
            {Array.from({ length: point.faces }, (_, i) => point.faces - i).map((s) => {
              const n = data?.counts[s] ?? 0;
              return (
                <tr key={s}>
                  <th
                    scope="row"
                    className="flex items-center gap-2 py-0.5 pr-2 text-left font-normal"
                  >
                    <Face score={s} faces={point.faces} size={20} />
                    {labels[s - 1]}
                  </th>
                  <td className="w-full py-0.5">
                    <div className="h-3 rounded-sm bg-slate-200">
                      <div
                        aria-hidden
                        className="h-3 rounded-sm bg-indigo-600"
                        style={{ width: `${total ? (100 * n) / total : 0}%` }}
                      />
                    </div>
                  </td>
                  <td className="pl-2 text-right tabular-nums" data-count={s}>
                    {n}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data ? (
          <p className="text-xs text-slate-600">
            {t('feedback.byChannel')}:{' '}
            {(['link', 'widget', 'paper'] as const)
              .map((c) => `${t(`feedback.channels.${c}`)} ${data.channels[c] ?? 0}`)
              .join(' · ')}
          </p>
        ) : null}
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-sm font-medium">{t('feedback.keyPaper')}</p>
          <p className="text-xs text-slate-600">{t('feedback.keyPaperHelp')}</p>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: point.faces }, (_, i) => i + 1).map((s) => (
              <button
                key={s}
                type="button"
                className={`${btn} flex items-center gap-1.5`}
                onClick={() => key.mutate(s)}
                aria-label={`${t('feedback.keyPaper')}: ${labels[s - 1]}`}
              >
                <Face score={s} faces={point.faces} size={22} />
                {labels[s - 1]}
              </button>
            ))}
          </div>
          <p role="status" className="text-xs text-emerald-ink-800">
            {status}
          </p>
        </div>
      </div>
      {point.items?.some((it) => it.type !== 'text') ? (
        <div className="flex flex-col gap-3 md:col-span-2" data-testid="feedback-items">
          <h3 className="text-sm font-medium">{t('feedback.itemsResults')}</h3>
          {point.items
            .filter((it) => it.type !== 'text')
            .map((it) => {
              const c = data?.itemCounts?.[it.id] ?? {};
              const n = Object.values(c).reduce((a, b) => a + b, 0);
              const rows =
                it.type === 'yesno'
                  ? [
                      { code: 1, label: t('feedback.yes') },
                      { code: 2, label: t('feedback.no') },
                    ]
                  : it.type === 'number'
                    ? Object.keys(c)
                        .map(Number)
                        .sort((a, b) => a - b)
                        .map((code) => ({ code, label: String(code) }))
                    : (it.options ?? []).map((o) => ({
                        code: o.code,
                        label: o.label[Object.keys(o.label)[0]!] ?? String(o.code),
                      }));
              return (
                <table key={it.id} className="w-full text-sm" data-item-results={it.id}>
                  <caption className="mb-1 text-left text-xs text-slate-600">
                    <span className="font-mono">{it.id}</span> · {it.text[Object.keys(it.text)[0]!]}
                  </caption>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.code}>
                        <th scope="row" className="w-48 py-0.5 pr-2 text-left font-normal">
                          {r.label}
                        </th>
                        <td className="w-full py-0.5">
                          <div className="h-3 rounded-sm bg-slate-200">
                            <div
                              aria-hidden
                              className="h-3 rounded-sm bg-indigo-600"
                              style={{ width: `${n ? (100 * (c[r.code] ?? 0)) / n : 0}%` }}
                            />
                          </div>
                        </td>
                        <td className="pl-2 text-right tabular-nums" data-code={r.code}>
                          {c[r.code] ?? 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })}
        </div>
      ) : null}
      <div>
        <h3 className="mb-1 text-sm font-medium">{t('feedback.comments')}</h3>
        {data?.texts?.length || data?.comments.length ? (
          <ul className="flex max-h-64 flex-col gap-2 overflow-auto text-sm">
            {(data.texts?.length
              ? data.texts.map((x) => ({ score: x.score, comment: x.text, ref: x.ref }))
              : data.comments
            ).map((c, i) => (
              <li key={i} className="flex gap-2">
                <Face score={c.score} faces={point.faces} size={18} />
                <span>
                  {c.comment}
                  {c.ref ? <span className="ml-1 text-xs text-slate-500">({c.ref})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{t('feedback.noComments')}</p>
        )}
      </div>
    </div>
  );
}
