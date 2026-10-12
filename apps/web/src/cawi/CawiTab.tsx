import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LAWFUL_BASES, type CawiSettings, type LawfulBasis } from '@wansurvey/schema';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
import { controlCls, inputCls } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';

interface TemplateRow {
  kind: 'invitation' | 'reminder';
  language: string;
  subject: string;
  body: string;
  custom: boolean;
}

interface Funnel {
  total: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  started: number;
  completed: number;
  bounced: number;
  reminders: number;
}

interface Wave {
  id: string;
  name: string;
  status: 'draft' | 'sending' | 'sent';
  questionnaireId: string;
  reminderDays: number[];
  filter: string | null;
  createdAt: string;
  funnel: Funnel;
}

const STEPS = [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'started',
  'completed',
  'bounced',
] as const;

/** Placeholders shown literally in help text (not filled by the interface's translations). */
const LITERAL = {
  case: { field: '{{case.field}}', campo: '{{case.campo}}' },
  link: '{{link}}',
  unsubscribe: '{{unsubscribe}}',
};

/** Fills a template the way the server does, for the preview. */
function preview(text: string, sample: Record<string, unknown>) {
  return text.replace(/\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g, (_m, name: string) => {
    if (name === 'link') return 'https://…/s/••••••';
    if (name === 'unsubscribe') return 'https://…/u/••••••';
    if (name.startsWith('case.')) {
      const v = sample[name.slice(5)];
      return v === null || v === undefined ? '' : String(v);
    }
    return '';
  });
}

/**
 * Web surveys for project staff: the lawful basis and completion page, e-mail wording with a
 * preview, waves with their funnel, the open link and the do-not-e-mail list.
 */
export function CawiTab({ project }: { project: Project }) {
  return (
    <div className="flex flex-col gap-8 text-sm">
      <WavesSection projectId={project.id} />
      <div className="grid gap-8 lg:grid-cols-2">
        <SendingSettings project={project} />
        <OpenLinkSection projectId={project.id} />
      </div>
      <TemplatesSection projectId={project.id} />
      <Suppressions projectId={project.id} />
    </div>
  );
}

function SendingSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<CawiSettings>(project.settings.cawi);
  const [message, setMessage] = useState('');
  useEffect(() => setForm(project.settings.cawi), [project.settings.cawi]);
  const save = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: { settings: { cawi: form } },
      }),
    onSuccess: (p) => {
      qc.setQueryData(['project', project.id], p);
      setMessage(t('cawi.settings.saved'));
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  return (
    <form
      className="flex flex-col gap-3"
      aria-labelledby="cawi-settings"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage('');
        save.mutate();
      }}
    >
      <h2 id="cawi-settings" className="text-base font-semibold">
        {t('cawi.settings.title')}
      </h2>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('cawi.settings.lawfulBasis')}</span>
        <select
          className={`${controlCls} w-auto`}
          aria-describedby="cawi-lawful-help"
          value={form.lawfulBasis ?? ''}
          onChange={(e) =>
            setForm({ ...form, lawfulBasis: (e.target.value || null) as LawfulBasis | null })
          }
        >
          <option value="">{t('cawi.settings.none')}</option>
          {LAWFUL_BASES.map((b) => (
            <option key={b} value={b}>
              {t(`cawi.settings.bases.${b}`)}
            </option>
          ))}
        </select>
        <span id="cawi-lawful-help" className="text-slate-600">
          {t('cawi.settings.lawfulHelp')}
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('cawi.settings.senderName')}</span>
        <input
          className={inputCls}
          value={form.senderName}
          maxLength={100}
          onChange={(e) => setForm({ ...form, senderName: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('cawi.settings.completionMessage')}</span>
        <textarea
          className={`${inputCls} min-h-[3rem]`}
          aria-describedby="cawi-completion-help"
          value={form.completionMessage}
          maxLength={2000}
          onChange={(e) => setForm({ ...form, completionMessage: e.target.value })}
        />
        <span id="cawi-completion-help" className="text-slate-600">
          {t('cawi.settings.completionHelp')}
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('cawi.settings.redirectUrl')}</span>
        <input
          type="url"
          className={inputCls}
          value={form.redirectUrl}
          placeholder="https://"
          onChange={(e) => setForm({ ...form, redirectUrl: e.target.value })}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {t('cawi.settings.save')}
        </Button>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </div>
    </form>
  );
}

function TemplatesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['email-templates', projectId],
    queryFn: () => api<TemplateRow[]>(`/projects/${projectId}/email-templates`),
  });
  const sample = useQuery({
    queryKey: ['cases-preview', projectId],
    queryFn: () =>
      api<{ rows: { externalId: string; sample: Record<string, unknown> }[] }>(
        `/projects/${projectId}/cases?limit=1`,
      ),
  });
  const [kind, setKind] = useState<'invitation' | 'reminder'>('invitation');
  const languages = [...new Set((list.data ?? []).map((x) => x.language))];
  const [language, setLanguage] = useState('es');
  const current = list.data?.find((x) => x.kind === kind && x.language === language);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (current) {
      setSubject(current.subject);
      setBody(current.body);
    }
  }, [current?.kind, current?.language, current?.subject, current?.body]);
  const save = useMutation({
    mutationFn: () =>
      api<TemplateRow[]>(`/projects/${projectId}/email-templates`, {
        method: 'PUT',
        body: { kind, language, subject, body },
      }),
    onSuccess: (rows) => {
      qc.setQueryData(['email-templates', projectId], rows);
      setMessage(t('cawi.templates.saved'));
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  const example = sample.data?.rows[0];
  const shown = example?.sample ?? {};

  return (
    <section aria-labelledby="cawi-templates" className="flex flex-col gap-3">
      <h2 id="cawi-templates" className="text-base font-semibold">
        {t('cawi.templates.title')}
      </h2>
      <p className="text-slate-600">{t('cawi.templates.help', LITERAL)}</p>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('cawi.templates.kind')}</span>
          <select
            className={`${controlCls} w-auto`}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'invitation' | 'reminder')}
          >
            {(['invitation', 'reminder'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`cawi.templates.kinds.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {languages.length > 1 ? (
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cawi.templates.language')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {current && !current.custom ? (
          <span className="self-end text-slate-600">{t('cawi.templates.default')}</span>
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMessage('');
            save.mutate();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cawi.templates.subject')}</span>
            <input
              className={inputCls}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cawi.templates.body')}</span>
            <textarea
              className={`${inputCls} min-h-[14rem] font-mono text-xs`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending || !subject.trim() || !body.trim()}>
              {t('cawi.templates.save')}
            </Button>
            <p role="status" aria-live="polite">
              {message}
            </p>
          </div>
        </form>
        <section
          aria-label={t('cawi.templates.preview')}
          className="rounded-md border border-slate-200 bg-white p-3"
          data-testid="template-preview"
        >
          <p className="mb-2 text-xs text-slate-600">
            {t('cawi.templates.preview')}
            {example ? ` · ${t('cawi.templates.previewCase')} ${example.externalId}` : ''}
          </p>
          <p className="font-semibold">{preview(subject, shown)}</p>
          <p className="mt-2 whitespace-pre-line">{preview(body, shown)}</p>
        </section>
      </div>
    </section>
  );
}

function WavesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const waves = useQuery({
    queryKey: ['waves', projectId],
    queryFn: () => api<Wave[]>(`/projects/${projectId}/waves`),
    refetchInterval: 10_000,
  });
  const qs = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; publishedVersions: number }[]>(
        `/projects/${projectId}/questionnaires`,
      ),
  });
  const usable = (qs.data ?? []).filter((q) => q.publishedVersions > 0);
  const [name, setName] = useState('');
  const [qid, setQid] = useState('');
  const [filter, setFilter] = useState('');
  const [reminders, setReminders] = useState('3, 7');
  const [toCati, setToCati] = useState(false);
  const [message, setMessage] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<Wave>(`/projects/${projectId}/waves`, {
        method: 'POST',
        body: {
          name: name.trim(),
          questionnaireId: qid || usable[0]?.id,
          ...(filter.trim() ? { filter: filter.trim() } : {}),
          reminderDays: reminders
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
          bouncesToCati: toCati,
        },
      }),
    onSuccess: async () => {
      setMessage(t('cawi.waves.created'));
      setName('');
      await qc.invalidateQueries({ queryKey: ['waves', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  const send = useMutation({
    mutationFn: (id: string) =>
      api<{ queued: number; skipped: { noEmail: number; optedOut: number; suppressed: number } }>(
        `/projects/${projectId}/waves/${id}/send`,
        { method: 'POST' },
      ),
    onSuccess: async (r) => {
      setMessage(
        `${t('cawi.waves.queued', { count: r.queued })} ${t('cawi.waves.skipped', r.skipped)}`,
      );
      await qc.invalidateQueries({ queryKey: ['waves', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });

  return (
    <section aria-labelledby="cawi-waves" className="flex flex-col gap-4">
      <h2 id="cawi-waves" className="text-base font-semibold">
        {t('cawi.waves.title')}
      </h2>
      <p role="status" aria-live="polite" className="empty:hidden" data-testid="waves-message">
        {message}
      </p>
      {waves.data?.length ? (
        <ul className="flex flex-col gap-3" data-testid="waves">
          {waves.data.map((w) => (
            <li
              key={w.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              data-wave={w.name}
            >
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <span className="font-semibold">{w.name}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                  {t(`cawi.waves.status.${w.status}`)}
                </span>
                {w.filter ? <code className="text-xs text-slate-600">{w.filter}</code> : null}
                {w.status === 'draft' ? (
                  <Button
                    type="button"
                    className="ml-auto px-3 py-1 text-sm"
                    disabled={send.isPending}
                    aria-label={t('cawi.waves.send', { name: w.name })}
                    onClick={() => send.mutate(w.id)}
                  >
                    {t('cawi.waves.sendConfirm')}
                  </Button>
                ) : null}
              </div>
              <FunnelChart name={w.name} funnel={w.funnel} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-600">{t('cawi.waves.none')}</p>
      )}
      <form
        className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3"
        aria-labelledby="cawi-new-wave"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage('');
          create.mutate();
        }}
      >
        <h3 id="cawi-new-wave" className="font-semibold">
          {t('cawi.waves.new')}
        </h3>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cawi.waves.name')}</span>
            <input
              className={controlCls}
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {usable.length > 1 ? (
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('cawi.waves.questionnaire')}</span>
              <select
                className={`${controlCls} w-auto`}
                value={qid || usable[0]?.id}
                onChange={(e) => setQid(e.target.value)}
              >
                {usable.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cawi.waves.filter')}</span>
            <input
              className={`${controlCls} font-mono`}
              value={filter}
              placeholder={t('cawi.waves.filterHelp')}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cawi.waves.reminders')}</span>
            <input
              className={controlCls}
              value={reminders}
              aria-describedby="cawi-reminders-help"
              onChange={(e) => setReminders(e.target.value)}
            />
            <span id="cawi-reminders-help" className="text-xs text-slate-600">
              {t('cawi.waves.remindersHelp')}
            </span>
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={toCati} onChange={(e) => setToCati(e.target.checked)} />
          {t('cawi.waves.bouncesToCati')}
        </label>
        <div>
          <Button type="submit" disabled={create.isPending || !name.trim() || !usable.length}>
            {t('cawi.waves.create')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Horizontal bars, each step as a share of the invitations, with the numbers as text. */
function FunnelChart({ name, funnel }: { name: string; funnel: Funnel }) {
  const { t } = useTranslation();
  const total = Math.max(1, funnel.total);
  return (
    <figure aria-label={t('cawi.waves.funnel', { name })} data-testid="funnel">
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)_6rem] items-center gap-x-3 gap-y-1">
        {STEPS.map((s) => {
          const n = funnel[s];
          return (
            <div key={s} className="contents" data-step={s} data-count={n}>
              <dt>{t(`cawi.waves.steps.${s}`)}</dt>
              <dd className="h-3 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div
                  className={`h-full ${s === 'bounced' ? 'bg-red-500' : s === 'completed' ? 'bg-emerald-600' : 'bg-indigo-500'}`}
                  style={{ width: `${(n / total) * 100}%` }}
                />
              </dd>
              <dd className="text-right tabular-nums">
                {t('cawi.waves.ofTotal', { n, total: funnel.total })}
              </dd>
            </div>
          );
        })}
      </dl>
      <figcaption className="mt-2 text-xs text-slate-600">
        {t('cawi.waves.reminderCount', { count: funnel.reminders })}
      </figcaption>
    </figure>
  );
}

function OpenLinkSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const link = useQuery({
    queryKey: ['open-link', projectId],
    queryFn: () =>
      api<{ link: { active: boolean; url: string } | null }>(`/projects/${projectId}/open-link`),
  });
  const qs = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; publishedVersions: number }[]>(
        `/projects/${projectId}/questionnaires`,
      ),
  });
  const first = useMemo(() => qs.data?.find((q) => q.publishedVersions > 0)?.id, [qs.data]);
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      api<{ link: { active: boolean; url: string } }>(`/projects/${projectId}/open-link`, {
        method: 'PUT',
        body: { active, ...(link.data?.link ? {} : { questionnaireId: first }) },
      }),
    onSuccess: (r) => qc.setQueryData(['open-link', projectId], r),
  });
  const l = link.data?.link;
  return (
    <section aria-labelledby="cawi-open" className="flex flex-col gap-2">
      <h2 id="cawi-open" className="text-base font-semibold">
        {t('cawi.openLink.title')}
      </h2>
      <p className="text-slate-600">{t('cawi.openLink.help')}</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={!!l?.active}
          disabled={toggle.isPending || (!l && !first)}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        {t('cawi.openLink.active')}
      </label>
      {l?.active ? (
        <p>
          <span className="font-medium">{t('cawi.openLink.url')}:</span>{' '}
          <a className="break-all text-indigo-700 underline" href={l.url} data-testid="open-link">
            {l.url}
          </a>
        </p>
      ) : null}
    </section>
  );
}

function Suppressions({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: ['suppressions', projectId],
    queryFn: () =>
      api<{ id: string; email: string; reason: string; createdAt: string }[]>(
        `/projects/${projectId}/suppressions`,
      ),
  });
  return (
    <details className="rounded-md border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer font-semibold">
        {t('cawi.suppressions.title', { count: list.data?.length ?? 0 })}
      </summary>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {(list.data ?? []).map((s) => (
          <li key={s.id}>
            {s.email}{' '}
            <span className="text-slate-600">
              ({t(`cawi.suppressions.reasons.${s.reason}`, { defaultValue: s.reason })})
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
