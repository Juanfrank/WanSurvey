import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { inputCls, smallBtn } from './fields.js';
import { dateTime } from '../format.js';

export interface Comment {
  id: string;
  itemId: string | null;
  parentId: string | null;
  authorName: string | null;
  body: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  createdAt: string;
  mine: boolean;
}

/** Every comment of a questionnaire, refreshed while the designer is open. */
export function useComments(projectId: string, qid: string) {
  return useQuery({
    queryKey: ['comments', qid],
    queryFn: () => api<Comment[]>(`/projects/${projectId}/questionnaires/${qid}/comments`),
    refetchInterval: 15_000,
  });
}

/** Open threads per item id (`''` for the questionnaire as a whole), for outline badges. */
export function openCounts(comments: Comment[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of comments ?? [])
    if (!c.parentId && !c.resolvedAt) m.set(c.itemId ?? '', (m.get(c.itemId ?? '') ?? 0) + 1);
  return m;
}

/**
 * Review comments on the selected item (or on the whole questionnaire): threads with replies,
 * resolve and reopen, and a list of every open thread to jump between them.
 */
export function CommentsPanel({
  projectId,
  qid,
  itemId,
  canWrite,
  onGoTo,
}: {
  projectId: string;
  qid: string;
  /** null: comments on the questionnaire as a whole. */
  itemId: string | null;
  canWrite: boolean;
  onGoTo(itemId: string | null): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const all = useComments(projectId, qid);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const replyBox = useRef<HTMLTextAreaElement>(null);
  // The reply box opens on request, so typing can start at once.
  useEffect(() => {
    if (replyTo) replyBox.current?.focus();
  }, [replyTo]);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState('');
  const base = `/projects/${projectId}/questionnaires/${qid}/comments`;
  const act = useMutation({
    mutationFn: (req: { path?: string; method: 'POST' | 'DELETE'; body?: object }) =>
      api(`${base}${req.path ?? ''}`, { method: req.method, body: req.body }),
    onSuccess: async () => {
      setError('');
      await qc.invalidateQueries({ queryKey: ['comments', qid] });
    },
    onError: (e) => setError(localiseError(t, e)),
  });

  const comments = all.data ?? [];
  const threads = comments.filter((c) => !c.parentId && c.itemId === itemId);
  const shown = threads.filter((c) => showResolved || !c.resolvedAt);
  const replies = (id: string) => comments.filter((c) => c.parentId === id);
  const open = comments.filter((c) => !c.parentId && !c.resolvedAt);
  const title = itemId
    ? t('designer.comments.onItem', { id: itemId })
    : t('designer.comments.general');

  const bubble = (c: Comment) => (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-slate-600">
        <span className="font-medium text-slate-800">
          {c.authorName ?? '—'}
          {c.mine ? ` (${t('designer.comments.you')})` : ''}
        </span>{' '}
        · <time dateTime={c.createdAt}>{dateTime(c.createdAt)}</time>
      </p>
      <p className="whitespace-pre-wrap">{c.body}</p>
    </div>
  );

  return (
    <section
      aria-labelledby="comments-h"
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm"
      data-testid="comments"
    >
      <h2 id="comments-h" className="font-semibold">
        {t('designer.comments.title')} · <span className="font-normal">{title}</span>
      </h2>
      {shown.length ? (
        <ol className="flex flex-col gap-3">
          {shown.map((c) => (
            <li
              key={c.id}
              className={`flex flex-col gap-2 rounded-md border p-2 ${c.resolvedAt ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50'}`}
              data-thread={c.id}
            >
              {bubble(c)}
              {replies(c.id).length ? (
                <ol className="ml-3 flex flex-col gap-2 border-l-2 border-slate-200 pl-3">
                  {replies(c.id).map((r) => (
                    <li key={r.id}>{bubble(r)}</li>
                  ))}
                </ol>
              ) : null}
              {c.resolvedAt ? (
                <p className="text-xs text-slate-600">
                  {t('designer.comments.resolved', { who: c.resolvedByName ?? '—' })}
                </p>
              ) : null}
              {canWrite ? (
                <div className="flex flex-wrap gap-2">
                  {replyTo !== c.id ? (
                    <button type="button" className={smallBtn} onClick={() => setReplyTo(c.id)}>
                      {t('designer.comments.reply')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() =>
                      act.mutate({
                        method: 'POST',
                        path: `/${c.id}/${c.resolvedAt ? 'reopen' : 'resolve'}`,
                      })
                    }
                  >
                    {c.resolvedAt ? t('designer.comments.reopen') : t('designer.comments.resolve')}
                  </button>
                  {c.mine && !replies(c.id).length ? (
                    <button
                      type="button"
                      className={smallBtn}
                      onClick={() => {
                        if (window.confirm(t('designer.comments.confirmDelete')))
                          act.mutate({ method: 'DELETE', path: `/${c.id}` });
                      }}
                    >
                      {t('designer.comments.delete')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {replyTo === c.id ? (
                <form
                  className="flex flex-col gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!reply.trim()) return;
                    act.mutate(
                      { method: 'POST', body: { parentId: c.id, body: reply } },
                      {
                        onSuccess: () => {
                          setReply('');
                          setReplyTo(null);
                        },
                      },
                    );
                  }}
                >
                  <label className="flex flex-col gap-1">
                    <span className="sr-only">
                      {t('designer.comments.replyTo', { who: c.authorName ?? '—' })}
                    </span>
                    <textarea
                      className={`${inputCls} min-h-[3.5rem]`}
                      ref={replyBox}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <button type="submit" className={smallBtn} disabled={!reply.trim()}>
                      {t('designer.comments.reply')}
                    </button>
                    <button type="button" className={smallBtn} onClick={() => setReplyTo(null)}>
                      {t('designer.library.cancel')}
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-slate-600">{t('designer.comments.none')}</p>
      )}
      {threads.some((c) => c.resolvedAt) ? (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          {t('designer.comments.showResolved')}
        </label>
      ) : null}
      {canWrite ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            act.mutate(
              { method: 'POST', body: { itemId, body: draft } },
              { onSuccess: () => setDraft('') },
            );
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('designer.comments.add')}</span>
            <textarea
              className={`${inputCls} min-h-[3.5rem]`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <div>
            <button type="submit" className={smallBtn} disabled={!draft.trim() || act.isPending}>
              {t('designer.comments.send')}
            </button>
          </div>
        </form>
      ) : null}
      <p role="status" aria-live="polite" className="text-red-ink-800">
        {error}
      </p>
      {open.length ? (
        <details>
          <summary className="cursor-pointer font-medium">
            {t('designer.comments.allOpen')} ·{' '}
            {t('designer.comments.allOpenCount', { count: open.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1" data-testid="open-threads">
            {open.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2">
                <button type="button" className={smallBtn} onClick={() => onGoTo(c.itemId)}>
                  {t('designer.comments.goTo', { id: c.itemId ?? t('designer.settings.title') })}
                </button>
                <span className="truncate text-slate-700">{c.body}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
