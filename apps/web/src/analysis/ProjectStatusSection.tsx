import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
import { FoldedHelp } from '../designer/fields.js';
import { localiseError, useNote } from '../i18n-messages.js';
import { Button, ErrorText, QueryState } from '../routes/ui.js';

type Status = 'draft' | 'active' | 'closed' | 'archived';
type Action = 'activate' | 'close' | 'reopen' | 'archive' | 'restore' | 'backToDraft';

/** The moves from each status, the main one first. */
const MOVES: Record<Status, { action: Action; to: Status }[]> = {
  draft: [{ action: 'activate', to: 'active' }],
  active: [
    { action: 'close', to: 'closed' },
    { action: 'backToDraft', to: 'draft' },
  ],
  closed: [
    { action: 'archive', to: 'archived' },
    { action: 'reopen', to: 'active' },
  ],
  archived: [{ action: 'restore', to: 'closed' }],
};

interface Closeout {
  status: string;
  openCases: number;
  openInterviews: number;
  pendingReview: number;
  exportsDone: number;
  lastExportAt: string | null;
  activeShareLinks: number;
  projectMembers: number;
}

/**
 * The project's life cycle (draft → active → closed → archived) with explicit moves, and what
 * is still open before closing or archiving it. The change is audited by the API.
 */
export function ProjectStatusSection({ project }: { project: Project }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [message, setMessage] = useNote();
  const [error, setError] = useState<string | null>(null);
  const status = (project.status in MOVES ? project.status : 'draft') as Status;
  const closeout = useQuery({
    queryKey: ['closeout', project.id],
    queryFn: () => api<Closeout>(`/projects/${project.id}/closeout`),
    enabled: status !== 'draft',
  });
  const move = useMutation({
    mutationFn: (to: Status) =>
      api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: { status: to } }),
    onSuccess: async (p) => {
      qc.setQueryData(['project', project.id], p);
      setError(null);
      setMessage({
        key: 'analysis.lifecycle.changed',
        vars: { status: { key: `app.projectStatus.${p.status}` } },
      });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['closeout', project.id] });
    },
    onError: (e) => {
      setMessage(null);
      setError(localiseError(t, e));
    },
  });
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium' });
  const c = closeout.data;
  // Items that still need attention are marked; the rest are plain.
  const items: { key: string; text: string; open: boolean }[] = c
    ? [
        {
          key: 'openCases',
          text: t('analysis.lifecycle.openCases', { count: c.openCases }),
          open: c.openCases > 0,
        },
        {
          key: 'openInterviews',
          text: t('analysis.lifecycle.openInterviews', { count: c.openInterviews }),
          open: c.openInterviews > 0,
        },
        {
          key: 'pendingReview',
          text: t('analysis.lifecycle.pendingReview', { count: c.pendingReview }),
          open: c.pendingReview > 0,
        },
        {
          key: 'exports',
          text:
            c.exportsDone && c.lastExportAt
              ? t('analysis.lifecycle.exportsDone', {
                  count: c.exportsDone,
                  date: date(c.lastExportAt),
                })
              : t('analysis.lifecycle.noExport'),
          open: !c.exportsDone,
        },
        {
          key: 'activeShareLinks',
          text: t('analysis.lifecycle.activeShareLinks', { count: c.activeShareLinks }),
          open: c.activeShareLinks > 0,
        },
        {
          key: 'projectMembers',
          text: t('analysis.lifecycle.projectMembers', { count: c.projectMembers }),
          open: c.projectMembers > 0,
        },
      ]
    : [];

  return (
    <section
      aria-labelledby="lifecycle-title"
      className="flex max-w-3xl flex-col gap-4"
      data-testid="project-status"
    >
      <h3 id="lifecycle-title" className="text-lg font-semibold">
        {t('analysis.lifecycle.title')}
      </h3>
      <FoldedHelp className="-mt-3 max-w-prose">{t('analysis.lifecycle.help')}</FoldedHelp>
      <p className="font-medium" data-testid="project-status-current">
        {t('analysis.lifecycle.current', { status: t(`analysis.lifecycle.states.${status}`) })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {MOVES[status].map((m, i) => (
          <Button
            key={m.action}
            type="button"
            variant={i === 0 ? 'primary' : 'secondary'}
            disabled={move.isPending}
            onClick={() => {
              const ask =
                m.action === 'close' || m.action === 'archive'
                  ? t(`analysis.lifecycle.confirm.${m.action}`, { name: project.name })
                  : null;
              if (ask && !window.confirm(ask)) return;
              move.mutate(m.to);
            }}
          >
            {t(`analysis.lifecycle.actions.${m.action}`)}
          </Button>
        ))}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </div>
      <ErrorText>{error}</ErrorText>
      {status !== 'draft' ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">{t('analysis.lifecycle.checklist')}</h4>
          <p className="text-slate-600">{t('analysis.lifecycle.checklistHelp')}</p>
          <QueryState query={closeout}>
            <ul className="flex flex-col gap-1" data-testid="closeout">
              {items.map((it) => (
                <li key={it.key} data-item={it.key} data-open={it.open} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className={it.open ? 'text-amber-ink-900' : 'text-emerald-ink-900'}
                  >
                    {it.open ? '!' : '✓'}
                  </span>
                  {it.text}
                </li>
              ))}
            </ul>
          </QueryState>
        </div>
      ) : null}
    </section>
  );
}
