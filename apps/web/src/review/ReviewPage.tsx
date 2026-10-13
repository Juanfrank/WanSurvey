import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  createInterview,
  own,
  respondentFromCase,
  type CompiledQuestionnaire,
  type InterviewSession,
} from '@wansurvey/logic';
import type { Question } from '@wansurvey/schema';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';
import { FlagChips, minutes } from './ReviewTab.js';

type To = 'in_review' | 'approved' | 'returned' | 'rejected';

export interface ReviewComment {
  id: string;
  variable: string | null;
  body: string;
  author: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface Detail {
  interview: {
    id: string;
    externalId: string | null;
    interviewer: string | null;
    mode: string;
    language: string;
    status: string;
    disposition: string | null;
    startedAt: string;
    submittedAt: string | null;
    activeMs: number;
    flags: Record<string, unknown>;
    sampled: boolean;
    submissions: number;
    state: Record<string, unknown>;
  };
  context: { case?: Record<string, unknown> };
  compiled: CompiledQuestionnaire;
  timings: Record<string, number>;
  notes: { key: string; text: string }[];
  warnings: { key: string; ruleId: string }[];
  paper: { date?: string | null; minutes?: number | null } | null;
  history: {
    variable: string;
    oldValue: unknown;
    newValue: unknown;
    at: string;
    source: string;
    reason: string | null;
    by: string | null;
  }[];
  comments: ReviewComment[];
  allowed: To[];
  canCorrect: boolean;
  canComment: boolean;
}

export function shownValue(v: unknown, session: InterviewSession, key: string): string {
  if (v === null || v === undefined || v === '') return '—';
  const name = key
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!;
  if (typeof v === 'object' && v && '$special' in v)
    return session.specialLabel((v as { $special: 'DK' }).$special);
  if (typeof v === 'number' || typeof v === 'string') {
    const label = session.labelOf(name, v);
    return label ? `${v} · ${label}` : String(v);
  }
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object'))
    return v.map((x) => session.labelOf(name, x as string) ?? String(x)).join(', ');
  return JSON.stringify(v);
}

/**
 * The review screen (R4): the interview read-only along the path it took, with time per
 * question, notes, confirmed warnings, every change and the comment threads; corrections and
 * the status changes the reviewer may make. Keys: A approve, R return.
 */
export function ReviewPage() {
  const { projectId, interviewId } = useParams({ strict: false }) as {
    projectId: string;
    interviewId: string;
  };
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['review', interviewId],
    queryFn: () => api<Detail>(`/review/interviews/${interviewId}`),
  });
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<To | null>(null);
  const [text, setText] = useState('');
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<string | null | undefined>(undefined);
  const d = detail.data;

  const session = useMemo(() => {
    if (!d) return null;
    const s = createInterview(d.compiled, {
      mode: d.interview.mode as never,
      language: d.interview.language,
      seed: d.interview.id,
      now: () => new Date(d.interview.startedAt),
      context: { case: d.context.case ?? {}, respondent: respondentFromCase(d.context.case ?? {}) },
      state: d.interview.state as never,
    });
    s.drainEvents();
    return s;
  }, [d]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['review', interviewId] });
  const move = useMutation({
    mutationFn: (v: { to: To; comment?: string }) =>
      api(`/review/interviews/${interviewId}/transition`, { method: 'POST', body: v }),
    onSuccess: async (_r, v) => {
      setDialog(null);
      setText('');
      setMessage(t('review.screen.done', { status: t(`interview.status.${v.to}`) }));
      await qc.invalidateQueries({ queryKey: ['review-queue', projectId] });
      await refresh();
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!d || dialog || correcting || commenting !== undefined) return;
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'a' && d.allowed.includes('approved')) {
        e.preventDefault();
        move.mutate({ to: 'approved' });
      } else if (e.key === 'r' && d.allowed.includes('returned')) {
        e.preventDefault();
        setDialog('returned');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (detail.error) return <p role="alert">{localiseError(t, detail.error)}</p>;
  if (!d || !session) return <p aria-busy="true">…</p>;
  const path = session.path().filter((e) => e.kind === 'question');
  const answers = session.getAnswers();
  const byKey = (k: string | null) => d.comments.filter((c) => c.variable === k);
  const historyOf = (k: string) => d.history.filter((h) => h.variable === k);

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="review-screen">
      <nav aria-label={t('designer.breadcrumb')} className="text-slate-600">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'review' }}
          className="hover:underline"
        >
          {t('review.screen.back')}
        </Link>
      </nav>
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <h1 className="text-lg font-semibold">
          {t('review.screen.title', { id: d.interview.externalId ?? d.interview.id.slice(0, 8) })}
        </h1>
        <span>{d.interview.interviewer ?? '—'}</span>
        <span>{d.interview.mode}</span>
        <span data-testid="review-status" data-status={d.interview.status}>
          {t('review.screen.status', {
            status: t(`interview.status.${d.interview.status}`, {
              defaultValue: d.interview.status,
            }),
          })}
          {d.interview.disposition ? ` · ${d.interview.disposition}` : ''}
        </span>
        <span className="tabular-nums">
          {t('review.screen.length', { time: minutes(d.interview.activeMs) })}
        </span>
        {d.interview.submissions > 1 ? (
          <span>{t('review.queue.round', { n: d.interview.submissions })}</span>
        ) : null}
        <FlagChips flags={d.interview.flags} />
        {d.paper?.date || d.paper?.minutes ? (
          <span>
            {t('review.screen.paper', {
              date: d.paper.date ?? '—',
              minutes: d.paper.minutes ?? '—',
            })}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {d.allowed.map((to) => (
            <Button
              key={to}
              type="button"
              variant={to === 'approved' ? 'primary' : 'secondary'}
              className="px-3 py-1.5 text-sm"
              disabled={move.isPending}
              aria-keyshortcuts={to === 'approved' ? 'A' : to === 'returned' ? 'R' : undefined}
              onClick={() =>
                to === 'returned' || to === 'rejected' ? setDialog(to) : move.mutate({ to })
              }
            >
              {t(`review.screen.actions.${to}`)}
            </Button>
          ))}
        </div>
      </header>
      <p role="status" aria-live="polite" className="empty:hidden" data-testid="review-message">
        {message}
      </p>
      {d.allowed.length ? (
        <p className="text-xs text-slate-600">{t('review.screen.keys')}</p>
      ) : null}

      <section
        aria-labelledby="review-path"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id="review-path" className="mb-2 text-base font-semibold">
          {t('review.screen.path')}
        </h2>
        <ol className="flex flex-col divide-y divide-slate-100">
          {path.map((e) => {
            const v = answers[e.key];
            const changes = historyOf(e.key);
            const notes = d.notes.filter((n) => n.key === e.key);
            const warns = d.warnings.filter((w) => w.key === e.key);
            const comments = byKey(e.key);
            const ms = d.timings[e.key];
            return (
              <li key={e.key} className="flex flex-col gap-1 py-2" data-qkey={e.key}>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs text-slate-600">{e.key}</span>
                  <span className="flex-1">{session.text(e.key)}</span>
                  {ms !== undefined ? (
                    <span className="tabular-nums text-xs text-slate-600">
                      {t('review.screen.time', { s: Math.round(ms / 100) / 10 })}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" data-testid="answer">
                    {v === undefined || v === null ? (
                      <span className="text-slate-600">{t('review.screen.noAnswer')}</span>
                    ) : (
                      shownValue(v, session, e.key)
                    )}
                  </span>
                  {changes.length > 1 ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-slate-600">
                        {t('review.screen.changes', { count: changes.length })}
                      </summary>
                      <ul>
                        {changes.map((h, i) => (
                          <li key={i}>
                            {JSON.stringify(h.oldValue)} → {JSON.stringify(h.newValue)} ·{' '}
                            {h.by ?? h.source}
                            {h.reason ? ` (${h.reason})` : ''} ·{' '}
                            {new Date(h.at).toLocaleString(i18n.language)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {d.canComment ? (
                    <button type="button" className={smallBtn} onClick={() => setCommenting(e.key)}>
                      {t('review.screen.comment')}
                      <span className="sr-only"> {e.key}</span>
                    </button>
                  ) : null}
                  {d.canCorrect ? (
                    <button type="button" className={smallBtn} onClick={() => setCorrecting(e.key)}>
                      {t('review.screen.correct')}
                      <span className="sr-only"> {e.key}</span>
                    </button>
                  ) : null}
                </div>
                {notes.map((n, i) => (
                  <p key={`n${i}`} className="text-xs text-slate-700">
                    {t('review.screen.note', { text: n.text })}
                  </p>
                ))}
                {warns.map((w, i) => (
                  <p key={`w${i}`} className="text-xs text-amber-900">
                    {t('review.screen.warning', { rule: w.ruleId })}
                  </p>
                ))}
                <CommentList comments={comments} onChange={refresh} />
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="review-comments" className="flex flex-col gap-2">
        <h2 id="review-comments" className="text-base font-semibold">
          {t('review.screen.comments')}
        </h2>
        <CommentList comments={byKey(null)} onChange={refresh} />
        {d.canComment ? (
          <div>
            <button type="button" className={smallBtn} onClick={() => setCommenting(null)}>
              {t('review.screen.addComment')}
            </button>
          </div>
        ) : null}
      </section>

      {dialog ? (
        <Dialog
          title={
            dialog === 'returned' ? t('review.screen.returnTitle') : t('review.screen.rejectTitle')
          }
          onClose={() => setDialog(null)}
        >
          <form
            className="flex flex-col gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              move.mutate({ to: dialog, comment: text.trim() || undefined });
            }}
          >
            <p>
              {dialog === 'returned'
                ? t('review.screen.returnHelp')
                : t('review.screen.rejectHelp')}
            </p>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('review.screen.commentText')}</span>
              <textarea
                className={`${inputCls} min-h-[5rem]`}
                value={text}
                required={dialog === 'returned'}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDialog(null)}>
                {t('review.screen.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={move.isPending || (dialog === 'returned' && !text.trim())}
              >
                {t('review.screen.confirm')}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {commenting !== undefined ? (
        <CommentDialog
          interviewId={interviewId}
          variable={commenting}
          onClose={() => setCommenting(undefined)}
          onDone={async () => {
            setCommenting(undefined);
            await refresh();
          }}
        />
      ) : null}
      {correcting ? (
        <CorrectDialog
          interviewId={interviewId}
          session={session}
          compiled={d.compiled}
          variable={correcting}
          onClose={() => setCorrecting(null)}
          onDone={async (msg) => {
            setCorrecting(null);
            setMessage(msg);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Comments with who and when, each one markable as dealt with. */
export function CommentList({
  comments,
  onChange,
}: {
  comments: ReviewComment[];
  onChange?: () => unknown;
}) {
  const { t, i18n } = useTranslation();
  if (!comments.length) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="comments">
      {comments.map((c) => (
        <li
          key={c.id}
          className={`rounded-md border-l-4 px-2 py-1 text-sm ${c.resolvedAt ? 'border-slate-300 bg-slate-50 text-slate-600' : 'border-amber-400 bg-amber-50'}`}
        >
          <span className="font-medium">{c.author ?? '—'}</span>{' '}
          <span className="text-xs text-slate-600">
            {new Date(c.createdAt).toLocaleString(i18n.language, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </span>
          {c.resolvedAt ? (
            <span className="ml-1 text-xs">({t('review.screen.resolved')})</span>
          ) : null}
          <p className="whitespace-pre-line">{c.body}</p>
          {onChange ? (
            <button
              type="button"
              className="text-xs text-indigo-700 underline"
              onClick={() =>
                void api(`/review/comments/${c.id}/resolve`, { method: 'POST' }).then(onChange)
              }
            >
              {c.resolvedAt ? t('review.screen.reopen') : t('review.screen.resolve')}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function CommentDialog({
  interviewId,
  variable,
  onClose,
  onDone,
}: {
  interviewId: string;
  variable: string | null;
  onClose(): void;
  onDone(): unknown;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  return (
    <Dialog
      title={
        variable ? `${t('review.screen.comment')} · ${variable}` : t('review.screen.addComment')
      }
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          api(`/review/interviews/${interviewId}/comments`, {
            method: 'POST',
            body: { variable, body: body.trim() },
          }).then(onDone, (err: unknown) => setError(localiseError(t, err)));
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('review.screen.commentText')}</span>
          <textarea
            className={`${inputCls} min-h-[5rem]`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <p role="alert" className="empty:hidden text-red-800">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('review.screen.cancel')}
          </Button>
          <Button type="submit" disabled={!body.trim()}>
            {t('review.screen.send')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CorrectDialog({
  interviewId,
  session,
  compiled,
  variable,
  onClose,
  onDone,
}: {
  interviewId: string;
  session: InterviewSession;
  compiled: CompiledQuestionnaire;
  variable: string;
  onClose(): void;
  onDone(message: string): unknown;
}) {
  const { t } = useTranslation();
  const name = variable
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!;
  const info = own(compiled.vars, name);
  const q = info ? (compiled.nodes[info.node]!.def as Question) : null;
  const options =
    q && (q.type === 'single' || q.type === 'multi') ? session.optionsFor(variable).options : [];
  const current = session.getAnswer(variable);
  const [value, setValue] = useState(
    current === null || current === undefined
      ? ''
      : Array.isArray(current)
        ? current.join(',')
        : String(current),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const parse = (): unknown => {
    if (!q) return value;
    if (q.type === 'numeric') return value === '' ? null : Number(value);
    if (q.type === 'single') return value === '' ? null : Number(value);
    if (q.type === 'multi')
      return value
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
    return value;
  };
  return (
    <Dialog title={t('review.screen.correctTitle', { key: variable })} onClose={onClose}>
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          api<{ cleared: string[]; restored: string[] }>(
            `/review/interviews/${interviewId}/correct`,
            {
              method: 'POST',
              body: { variable, value: parse(), reason: reason.trim() },
            },
          ).then(
            (r) =>
              onDone(
                t('review.screen.corrected', {
                  cleared: [
                    r.cleared.length
                      ? t('review.screen.cleared', { keys: r.cleared.join(', ') })
                      : '',
                    r.restored.length
                      ? t('review.screen.restored', { keys: r.restored.join(', ') })
                      : '',
                  ].join(' '),
                }),
              ),
            (err: unknown) => setError(localiseError(t, err)),
          );
        }}
      >
        <p className="text-slate-700">{session.text(variable)}</p>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('review.screen.value')}</span>
          {q?.type === 'single' ? (
            <select className={inputCls} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">—</option>
              {options.map((o) => (
                <option key={String(o.code)} value={String(o.code)}>
                  {o.code} · {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputCls}
              type={q?.type === 'numeric' ? 'number' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('review.screen.reason')}</span>
          <textarea
            className={`${inputCls} min-h-[3rem]`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <p role="alert" className="empty:hidden text-red-800">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('review.screen.cancel')}
          </Button>
          <Button type="submit" disabled={reason.trim().length < 3}>
            {t('review.screen.correct')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
