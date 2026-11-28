import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LAWFUL_BASES, type CawiSettings, type LawfulBasis } from '@wansurvey/schema';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
import { Dialog } from '../designer/Dialog.js';
import { controlCls, FoldedHelp, inputCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { LinkBuilder } from './LinkBuilder.js';
import { maskLink } from './linkParams.js';
import { Button, Drawer, MoreMenu, type MenuEntry } from '../routes/ui.js';

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
  channel: 'email' | 'sms' | 'links';
  linksExpireAt: string | null;
}

/** A day chosen in a date field, as the end of that day where the person is. */
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();
/** An instant as the local day a date field shows. */
const localDay = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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
export function CawiTab({
  projectId,
  questionnaireId,
}: {
  projectId: string;
  questionnaireId: string;
}) {
  return (
    <div className="flex flex-col gap-8 text-sm">
      <WavesSection projectId={projectId} questionnaireId={questionnaireId} />
      <OpenLinkSection projectId={projectId} questionnaireId={questionnaireId} />
    </div>
  );
}

/** The project's web survey settings: sending, e-mail wording and the do-not-e-mail list. */
export function CawiProjectSettings({ project }: { project: Project }) {
  return (
    <div className="flex flex-col gap-8 text-sm">
      <SendingSettings project={project} />
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
      </label>
      <FoldedHelp id="cawi-lawful-help" className="-mt-2 max-w-prose">
        {t('cawi.settings.lawfulHelp')}
      </FoldedHelp>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.trackOpens}
          onChange={(e) => setForm({ ...form, trackOpens: e.target.checked })}
        />
        <span>{t('cawi.settings.trackOpens')}</span>
      </label>
      <FoldedHelp className="-mt-2 max-w-prose">{t('cawi.settings.trackOpensHelp')}</FoldedHelp>
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
      </label>
      <FoldedHelp id="cawi-completion-help" className="-mt-2 max-w-prose">
        {t('cawi.settings.completionHelp')}
      </FoldedHelp>
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
  const currentKey = current && `${current.kind}/${current.language}`;
  const currentSubject = current?.subject;
  const currentBody = current?.body;
  useEffect(() => {
    if (currentSubject !== undefined && currentBody !== undefined) {
      setSubject(currentSubject);
      setBody(currentBody);
    }
  }, [currentKey, currentSubject, currentBody]);
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
      <FoldedHelp className="max-w-prose">{t('cawi.templates.help', LITERAL)}</FoldedHelp>
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

function WavesSection({
  projectId,
  questionnaireId,
}: {
  projectId: string;
  questionnaireId: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const all = useQuery({
    queryKey: ['waves', projectId],
    queryFn: () => api<Wave[]>(`/projects/${projectId}/waves`),
    refetchInterval: 10_000,
  });
  // The outreach (waves) of this questionnaire.
  const waves = { data: all.data?.filter((w) => w.questionnaireId === questionnaireId) };
  const qs = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; publishedVersions: number }[]>(
        `/projects/${projectId}/questionnaires`,
      ),
  });
  const published = !!qs.data?.find((q) => q.id === questionnaireId)?.publishedVersions;
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [reminders, setReminders] = useState('3, 7');
  const [toCati, setToCati] = useState(false);
  const [expires, setExpires] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms' | 'links'>('email');
  const [linksOf, setLinksOf] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // "New outreach" opens its form in a side panel; it closes once the outreach is made.
  const [creating, setCreating] = useState(false);
  const formId = useId();
  const create = useMutation({
    mutationFn: () =>
      api<Wave>(`/projects/${projectId}/waves`, {
        method: 'POST',
        body: {
          name: name.trim(),
          questionnaireId,
          ...(filter.trim() ? { filter: filter.trim() } : {}),
          reminderDays: (channel === 'links' ? '' : reminders)
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
          bouncesToCati: toCati,
          channel,
          ...(expires ? { linksExpireAt: endOfDay(expires) } : {}),
        },
      }),
    onSuccess: async () => {
      setMessage(t('cawi.waves.created'));
      setName('');
      setExpires('');
      setCreating(false);
      await qc.invalidateQueries({ queryKey: ['waves', projectId] });
    },
    // Shown in the side panel, which stays open.
  });
  const send = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) =>
      api<{
        queued: number;
        links?: number;
        skipped: {
          noEmail?: number;
          noPhone?: number;
          badNumber?: number;
          optedOut: number;
          suppressed: number;
        };
      }>(`/projects/${projectId}/waves/${id}/send`, {
        method: 'POST',
        body: { confirm: !!confirm },
      }),
    onSuccess: async (r, { id }) => {
      if (r.links !== undefined) {
        setMessage(t('cawi.links.made', { count: r.links }));
        setLinksOf(id);
      } else
        setMessage(
          `${t('cawi.waves.queued', { count: r.queued })} ${t('cawi.waves.skipped', {
            noEmail:
              (r.skipped.noEmail ?? 0) + (r.skipped.noPhone ?? 0) + (r.skipped.badNumber ?? 0),
            optedOut: r.skipped.optedOut,
            suppressed: r.skipped.suppressed,
          })}`,
        );
      await qc.invalidateQueries({ queryKey: ['waves', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });

  /** An SMS wave costs money: what it would do and cost is shown first, and a large one asks twice. */
  const sendSms = async (w: Wave) => {
    try {
      const p = await api<{
        recipients: number;
        estimatedSegments: number;
        estimatedCost: number;
        needsConfirmation: boolean;
        confirmAbove: number;
      }>(`/projects/${projectId}/waves/${w.id}/preview`);
      if (!window.confirm(t('cawi.sms.confirm', { name: w.name, ...p }))) return;
      if (p.needsConfirmation && !window.confirm(t('cawi.sms.confirmBig', p))) return;
      send.mutate({ id: w.id, confirm: p.needsConfirmation });
    } catch (e) {
      setMessage(localiseError(t, e));
    }
  };

  return (
    <section aria-labelledby="cawi-waves" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="cawi-waves" className="text-base font-semibold">
          {t('cawi.waves.title')}
        </h2>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          aria-haspopup="dialog"
          onClick={() => {
            create.reset();
            setCreating(true);
          }}
        >
          + {t('cawi.waves.new')}
        </Button>
      </div>
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
                    aria-label={
                      w.channel === 'links'
                        ? t('cawi.links.make', { name: w.name })
                        : t('cawi.waves.send', { name: w.name })
                    }
                    onClick={() =>
                      w.channel === 'sms' ? void sendSms(w) : send.mutate({ id: w.id })
                    }
                  >
                    {w.channel === 'links'
                      ? t('cawi.links.makeShort')
                      : t('cawi.waves.sendConfirm')}
                  </Button>
                ) : w.channel === 'links' ? (
                  <button
                    type="button"
                    className="ml-auto rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50"
                    aria-expanded={linksOf === w.id}
                    onClick={() => setLinksOf(linksOf === w.id ? null : w.id)}
                  >
                    {t('cawi.links.show')}
                  </button>
                ) : null}
                {w.channel === 'links' ? (
                  <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-ink-800">
                    {t('cawi.links.chip')}
                  </span>
                ) : null}
                {w.linksExpireAt ? (
                  <span className="text-xs text-slate-600" data-testid="wave-expiry">
                    {t('cawi.links.expireOn', { day: localDay(w.linksExpireAt) })}
                  </span>
                ) : null}
              </div>
              {linksOf === w.id ? <WaveLinks projectId={projectId} wave={w} /> : null}
              <FunnelChart name={w.name} funnel={w.funnel} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-600">{t('cawi.waves.none')}</p>
      )}
      {creating ? (
        <Drawer
          title={t('cawi.waves.new')}
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                {t('cawi.links.cancel')}
              </Button>
              <Button
                type="submit"
                form={formId}
                disabled={create.isPending || !name.trim() || !published}
              >
                {t('cawi.waves.create')}
              </Button>
            </>
          }
        >
          <form
            id={formId}
            className="flex flex-col gap-4 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage('');
              create.mutate();
            }}
          >
            <p role="alert" className="text-red-ink-700 empty:hidden">
              {create.isError ? localiseError(t, create.error) : ''}
            </p>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="font-medium">{t('cawi.waves.name')}</span>
                <input
                  className={controlCls}
                  value={name}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium">{t('cawi.waves.filter')}</span>
                <input
                  className={`${controlCls} font-mono`}
                  value={filter}
                  placeholder={t('cawi.waves.filterHelp')}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <label className={`flex flex-col gap-1 ${channel === 'links' ? 'hidden' : ''}`}>
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
              <label className="flex flex-col gap-1">
                <span className="font-medium">{t('cawi.links.expires')}</span>
                <input
                  type="date"
                  className={controlCls}
                  value={expires}
                  min={localDay(new Date().toISOString())}
                  aria-describedby="cawi-expires-help"
                  onChange={(e) => setExpires(e.target.value)}
                />
                <span id="cawi-expires-help" className="text-xs text-slate-600">
                  {t('cawi.links.expiresHelp')}
                </span>
              </label>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 font-medium">{t('cawi.links.channel')}</legend>
              {(['email', 'sms', 'links'] as const).map((c) => (
                <label key={c} className="flex items-start gap-2">
                  <input
                    type="radio"
                    className="mt-1"
                    name="wave-channel"
                    checked={channel === c}
                    onChange={() => setChannel(c)}
                  />
                  <span>
                    <span className="font-medium">{t(`cawi.links.channels.${c}`)}</span>
                    <span className="block text-xs text-slate-600">
                      {t(`cawi.links.channelHints.${c}`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {channel === 'email' || channel === 'sms' ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={toCati}
                  onChange={(e) => setToCati(e.target.checked)}
                />
                {t('cawi.waves.bouncesToCati')}
              </label>
            ) : null}
          </form>
        </Drawer>
      ) : null}
    </section>
  );
}

type WaveLink = {
  id: string;
  externalId: string;
  url: string;
  status: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

/** How many personal links are listed at first, and added by "Show 20 more". */
const LINKS_STEP = 20;

/**
 * The personal links of a "links only" wave: one per case, to hand out by any channel. Link
 * parameters can be added to all of them (e.g. ?sede=2 for a branch), behind "Link parameters".
 * Each link opens a person's survey, so they are handled like passwords: cut short on screen,
 * shown or copied one by one, and every listing and download is logged. The list shows 20 at a
 * time; each row's actions (show, copy, change the expiry date, revoke) are in its "⋯".
 */
function WaveLinks({ projectId, wave }: { projectId: string; wave: Wave }) {
  const { t } = useTranslation();
  const [extra, setExtra] = useState('');
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState('');
  const [limit, setLimit] = useState(LINKS_STEP);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [dating, setDating] = useState<WaveLink | null>(null);
  const paramsId = useId();
  // Kept as a message key, so it follows a change of interface language.
  const [note, setNote] = useState<{ key: string; values: Record<string, string> } | null>(null);
  const qc = useQueryClient();
  // Each change is logged by the server; the list is read again afterwards (and that listing too).
  const changed = (key: string, values: Record<string, string>) => {
    setProblem('');
    setNote({ key, values });
    void qc.invalidateQueries({ queryKey: ['wave-links', wave.id] });
  };
  const revoke = useMutation({
    mutationFn: (l: WaveLink) =>
      api(`/projects/${projectId}/waves/${wave.id}/links/${l.id}/revoke`, { method: 'POST' }),
    onSuccess: (_, l) => changed('cawi.links.revoked', { id: l.externalId }),
    onError: (e) => setProblem(localiseError(t, e)),
  });
  const expiry = useMutation({
    mutationFn: ({ l, day }: { l: WaveLink; day: string }) =>
      api(`/projects/${projectId}/waves/${wave.id}/links/${l.id}`, {
        method: 'PATCH',
        body: { expiresAt: day ? endOfDay(day) : null },
      }),
    onSuccess: (_, { l, day }) => {
      setDating(null);
      changed(day ? 'cawi.links.expirySet' : 'cawi.links.expiryCleared', {
        id: l.externalId,
        day,
      });
    },
  });
  const links = useQuery({
    queryKey: ['wave-links', wave.id],
    queryFn: () => api<WaveLink[]>(`/projects/${projectId}/waves/${wave.id}/links`),
    // Each listing is logged: fetched when opened, not again on every focus of the window.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [built, setBuilt] = useState('');
  // The parameters of the builder, then any typed by hand, go on every link.
  const params = [built, extra.trim().replace(/^[?&]+/, '')].filter(Boolean).join('&');
  const withParams = (url: string) => (params ? `${url}?${params}` : url);
  const csv = async () => {
    setProblem('');
    // Fetched again for the file, so the log says it was downloaded.
    let all: WaveLink[];
    try {
      all = await api<WaveLink[]>(`/projects/${projectId}/waves/${wave.id}/links?for=download`);
    } catch (e) {
      setProblem(localiseError(t, e));
      return;
    }
    const rows = [
      ['case', 'url', 'status'],
      ...all.map((l) => [l.externalId, withParams(l.url), l.status]),
    ];
    const text = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `${wave.name.normalize('NFKD').replace(/[^\w-]+/g, '-') || 'enlaces'}.csv`;
    // Attached for the click, so browsers keep the file name.
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const copy = async (l: WaveLink) => {
    setProblem('');
    try {
      // Missing on pages not served over HTTPS: say so rather than pretend.
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(withParams(l.url));
      setNote({ key: 'cawi.links.copiedOne', values: { id: l.externalId } });
    } catch {
      setNote(null);
      setProblem(t('cawi.links.copyFailed'));
    }
  };
  const closed = (l: WaveLink) => !!l.revokedAt || l.status === 'completed';
  const entriesFor = (l: WaveLink): MenuEntry[] => [
    {
      type: 'item',
      id: 'show',
      label: t(shown.has(l.externalId) ? 'cawi.links.hideOne' : 'cawi.links.showOne', {
        id: l.externalId,
      }),
      onSelect: () =>
        setShown((s) => {
          const next = new Set(s);
          if (!next.delete(l.externalId)) next.add(l.externalId);
          return next;
        }),
    },
    {
      type: 'item',
      id: 'copy',
      label: t('cawi.links.copyOne', { id: l.externalId }),
      onSelect: () => void copy(l),
    },
    {
      type: 'item',
      id: 'expiry',
      label: t('cawi.links.changeExpiry'),
      disabled: closed(l),
      onSelect: () => {
        expiry.reset();
        setDating(l);
      },
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'revoke',
      label: t('cawi.links.revokeOne', { id: l.externalId }),
      disabled: closed(l) || revoke.isPending,
      onSelect: () => {
        if (window.confirm(t('cawi.links.revokeConfirm', { id: l.externalId }))) revoke.mutate(l);
      },
    },
  ];
  const all = links.data ?? [];
  const rows = all.slice(0, limit);
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-md bg-slate-50 p-3" data-testid="wave-links">
      <p className="text-sm font-medium text-amber-ink-900" role="note">
        {t('cawi.links.secret')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={smallBtn}
          aria-expanded={paramsOpen}
          aria-controls={paramsId}
          onClick={() => setParamsOpen((o) => !o)}
        >
          {t('cawi.links.paramsOpen')}
          {params ? ` · ${params.split('&').filter(Boolean).length}` : ''}{' '}
          <span aria-hidden="true">{paramsOpen ? '▴' : '▾'}</span>
        </button>
        <Button type="button" size="sm" onClick={() => void csv()}>
          {t('cawi.links.download')}
        </Button>
        <span className="text-xs text-slate-600">
          {t('cawi.links.shown', { shown: rows.length, total: all.length })}
        </span>
        <p role="alert" className="text-sm text-red-ink-700 empty:hidden">
          {problem}
        </p>
        <p role="status" className="text-sm text-slate-700 empty:hidden" data-testid="links-note">
          {note ? t(note.key, note.values) : ''}
        </p>
      </div>
      {/* Folded, not unmounted: the builder keeps its choices while it is closed. */}
      <div id={paramsId} hidden={!paramsOpen} className="flex flex-col gap-2">
        <FoldedHelp className="text-sm">{t('cawi.links.help')}</FoldedHelp>
        <LinkBuilder
          projectId={projectId}
          questionnaireId={wave.questionnaireId}
          baseUrl={links.data?.[0]?.url ?? null}
          onQueryChange={setBuilt}
          segments={false}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('cawi.links.params')}</span>
          <input
            className={`${controlCls} max-w-md font-mono`}
            value={extra}
            placeholder="sede=2"
            onChange={(e) => setExtra(e.target.value)}
          />
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-600">
              <th scope="col" className="pr-4">
                {t('cawi.links.case')}
              </th>
              <th scope="col" className="pr-4">
                {t('cawi.links.url')}
              </th>
              <th scope="col" className="pr-4">
                {t('cawi.links.status')}
              </th>
              <th scope="col" className="pr-2">
                {t('cawi.links.expiresCol')}
              </th>
              <th scope="col">
                <span className="sr-only">{t('cawi.links.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.externalId} data-link={l.externalId} className="whitespace-nowrap">
                <td className="py-0.5 pr-4 font-mono">{l.externalId}</td>
                <td className="max-w-[28rem] truncate pr-4 font-mono text-xs" data-link-url="">
                  {shown.has(l.externalId) ? withParams(l.url) : maskLink(withParams(l.url))}
                </td>
                <td className="pr-4">{t(`cawi.links.statuses.${l.status}`)}</td>
                <td className="pr-2 tabular-nums" data-testid="link-expiry">
                  {l.expiresAt ? localDay(l.expiresAt) : t('cawi.links.noExpiry')}
                </td>
                <td className="py-0.5 text-right">
                  <MoreMenu
                    label={t('cawi.links.actionsOne', { id: l.externalId })}
                    entries={entriesFor(l)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {all.length > rows.length ? (
        <div>
          <button
            type="button"
            className={smallBtn}
            onClick={() => setLimit((n) => n + LINKS_STEP)}
          >
            {t('cawi.links.showMore', { count: all.length - rows.length })}
          </button>
        </div>
      ) : null}
      {dating ? (
        <ExpiryDialog
          link={dating}
          pending={expiry.isPending}
          error={expiry.isError ? localiseError(t, expiry.error) : ''}
          onClose={() => setDating(null)}
          onSave={(day) => expiry.mutate({ l: dating, day })}
        />
      ) : null}
    </div>
  );
}

/** Changes (or clears) the end date of one personal link. */
function ExpiryDialog({
  link,
  pending,
  error,
  onClose,
  onSave,
}: {
  link: WaveLink;
  pending: boolean;
  error: string;
  onClose(): void;
  onSave(day: string): void;
}) {
  const { t } = useTranslation();
  const [day, setDay] = useState(localDay(link.expiresAt));
  const helpId = useId();
  return (
    <Dialog
      title={t('cawi.links.expiryTitle', { id: link.externalId })}
      onClose={onClose}
      closeLabel={t('app.close')}
    >
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(day);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('cawi.links.expiresCol')}</span>
          <input
            type="date"
            className={`${controlCls} w-auto self-start`}
            aria-label={t('cawi.links.expiresOne', { id: link.externalId })}
            aria-describedby={helpId}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
          <span id={helpId} className="text-xs text-slate-600">
            {t('cawi.links.expiryEmpty')}
          </span>
        </label>
        <p role="alert" className="text-red-ink-700 empty:hidden">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('cawi.links.cancel')}
          </Button>
          <Button type="submit" disabled={pending || day === localDay(link.expiresAt)}>
            {t('cawi.links.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Horizontal bars, each step as a share of the invitations, with the numbers as text. */
function FunnelChart({ name, funnel }: { name: string; funnel: Funnel }) {
  const { t } = useTranslation();
  const total = Math.max(1, funnel.total);
  return (
    <figure aria-label={t('cawi.waves.funnel', { name })} data-testid="funnel">
      <dl className="grid grid-cols-[11rem_minmax(0,1fr)_6rem] items-center gap-x-3 gap-y-1">
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

function OpenLinkSection({
  projectId,
  questionnaireId,
}: {
  projectId: string;
  questionnaireId: string;
}) {
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
  const first = useMemo(
    () => qs.data?.find((q) => q.id === questionnaireId && q.publishedVersions > 0)?.id,
    [qs.data, questionnaireId],
  );
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      api<{ link: { active: boolean; url: string } }>(`/projects/${projectId}/open-link`, {
        method: 'PUT',
        body: { active, ...(link.data?.link ? {} : { questionnaireId: first }) },
      }),
    onSuccess: (r) => qc.setQueryData(['open-link', projectId], r),
  });
  const l = link.data?.link;
  // The link builder (answers and segments in the link) waits behind a button.
  const [builderOpen, setBuilderOpen] = useState(false);
  const builderId = useId();
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
        <>
          <p>
            <span className="font-medium">{t('cawi.openLink.url')}:</span>{' '}
            <a
              className="break-all text-indigo-ink-700 underline"
              href={l.url}
              data-testid="open-link"
            >
              {l.url}
            </a>
          </p>
          <div>
            <button
              type="button"
              className={smallBtn}
              aria-expanded={builderOpen}
              aria-controls={builderId}
              onClick={() => setBuilderOpen((o) => !o)}
            >
              {t('cawi.links.paramsOpen')} <span aria-hidden="true">{builderOpen ? '▴' : '▾'}</span>
            </button>
          </div>
          <div id={builderId} hidden={!builderOpen}>
            <LinkBuilder
              projectId={projectId}
              questionnaireId={questionnaireId}
              baseUrl={l.url}
              shortLink
            />
          </div>
        </>
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
