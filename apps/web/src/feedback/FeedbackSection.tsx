import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { Button, Card, ErrorText, Field } from '../routes/ui.js';
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
}

interface Results {
  point: FeedbackPoint;
  counts: Record<string, number>;
  channels: Record<string, number>;
  comments: { score: number; comment: string; ref: string | null; at: string }[];
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

/**
 * Quick feedback in a project: faces answered by link, widget or printed slip (F1). Set up
 * here, with each point's links and embedding code, its slips to print and its results.
 */
export function FeedbackSection({ projectId, lang }: { projectId: string; lang: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['feedback', projectId],
    queryFn: () => api<FeedbackPoint[]>(`/projects/${projectId}/feedback`),
  });
  const [open, setOpen] = useState<{ id: string; view: 'links' | 'results' } | null>(null);
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [faces, setFaces] = useState<3 | 5>(3);
  const [askComment, setAskComment] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<FeedbackPoint>(`/projects/${projectId}/feedback`, {
        method: 'POST',
        body: {
          name: name.trim(),
          question: { [lang]: question.trim() || t('feedback.questionDefault') },
          faces,
          askComment,
        },
      }),
    onSuccess: async (p) => {
      setName('');
      setQuestion('');
      await qc.invalidateQueries({ queryKey: ['feedback', projectId] });
      setOpen({ id: p.id, view: 'links' });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const toggle = useMutation({
    mutationFn: (p: FeedbackPoint) =>
      api(`/projects/${projectId}/feedback/${p.id}`, {
        method: 'PATCH',
        body: { active: !p.active },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feedback', projectId] }),
  });
  const pct = (v: number | null) =>
    v === null
      ? '–'
      : new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 }).format(
          v,
        );

  return (
    <Card>
      <section
        aria-labelledby="fb-h"
        className="flex flex-col gap-4"
        data-testid="feedback-section"
      >
        <div>
          <h2 id="fb-h" className="text-lg font-semibold">
            {t('feedback.title')}
          </h2>
          <p className="text-sm text-slate-600">{t('feedback.help')}</p>
        </div>
        {list.data?.length ? (
          <ul className="flex flex-col divide-y divide-slate-100">
            {list.data.map((p) => {
              const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
              return (
                <li key={p.id} className="flex flex-col gap-3 py-3" data-feedback={p.name}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="flex -space-x-1" aria-hidden>
                      {Array.from({ length: p.faces }, (_, i) => (
                        <Face key={i} score={i + 1} faces={p.faces} size={22} />
                      ))}
                    </span>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-sm text-slate-600">
                      {t('feedback.answers', { count: total })} ·{' '}
                      {t('feedback.satisfied', { pct: pct(satisfied(p)) })}
                    </span>
                    {!p.active ? (
                      <span className="rounded bg-slate-100 px-1.5 text-xs text-slate-700">
                        {t('feedback.inactive')}
                      </span>
                    ) : null}
                    <span className="ml-auto flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className={btn}
                        aria-pressed={open?.id === p.id && open.view === 'links'}
                        onClick={() =>
                          setOpen((o) =>
                            o?.id === p.id && o.view === 'links'
                              ? null
                              : { id: p.id, view: 'links' },
                          )
                        }
                      >
                        {t('feedback.links')}
                      </button>
                      <Link
                        to="/projects/$projectId/feedback/$pointId/print"
                        params={{ projectId, pointId: p.id }}
                        className={btn}
                      >
                        {t('feedback.print')}
                      </Link>
                      <button
                        type="button"
                        className={btn}
                        aria-pressed={open?.id === p.id && open.view === 'results'}
                        onClick={() =>
                          setOpen((o) =>
                            o?.id === p.id && o.view === 'results'
                              ? null
                              : { id: p.id, view: 'results' },
                          )
                        }
                      >
                        {t('feedback.results')}
                      </button>
                      <button type="button" className={btn} onClick={() => toggle.mutate(p)}>
                        {p.active ? t('feedback.switchOff') : t('feedback.switchOn')}
                      </button>
                    </span>
                  </div>
                  {open?.id === p.id && open.view === 'links' ? <Links point={p} /> : null}
                  {open?.id === p.id && open.view === 'results' ? (
                    <ResultsPanel projectId={projectId} point={p} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{list.isLoading ? '…' : t('feedback.none')}</p>
        )}
        <details className="rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer font-medium">{t('feedback.create')}</summary>
          <form
            className="mt-3 flex max-w-xl flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (name.trim()) create.mutate();
            }}
          >
            <Field
              id="fb-name"
              label={t('feedback.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Field
              id="fb-question"
              label={t('feedback.question')}
              value={question}
              placeholder={t('feedback.questionDefault')}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 font-medium text-slate-700">{t('feedback.faces')}</legend>
              {([3, 5] as const).map((n) => (
                <label key={n} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="fb-faces"
                    checked={faces === n}
                    onChange={() => setFaces(n)}
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
                checked={askComment}
                onChange={(e) => setAskComment(e.target.checked)}
              />
              {t('feedback.askComment')}
            </label>
            <ErrorText>{error}</ErrorText>
            <div>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {t('feedback.add')}
              </Button>
            </div>
          </form>
        </details>
      </section>
    </Card>
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
function Links({ point }: { point: FeedbackPoint }) {
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
function ResultsPanel({ projectId, point }: { projectId: string; point: FeedbackPoint }) {
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
      <div>
        <h3 className="mb-1 text-sm font-medium">{t('feedback.comments')}</h3>
        {data?.comments.length ? (
          <ul className="flex max-h-64 flex-col gap-2 overflow-auto text-sm">
            {data.comments.map((c, i) => (
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
