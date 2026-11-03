import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, QueryState } from '../routes/ui.js';

const EVENTS = [
  'interview.submitted',
  'interview.status_changed',
  'case.status_changed',
  'export.ready',
] as const;

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  projectId: string | null;
  enabled: boolean;
  disabledReason: string | null;
  lastWeek: Record<string, number>;
}
interface Delivery {
  id: string;
  event: string;
  status: string;
  attempt: number;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
}

/** Outgoing webhooks: who is told when something happens, and how the telling went. */
export function WebhooksPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const list = useQuery({
    queryKey: ['webhooks', me.data?.tenantId],
    queryFn: () => api<Endpoint[]>('/webhooks'),
    enabled: !!me.data,
  });
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string }[]>('/projects'),
    enabled: !!me.data,
  });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Endpoint | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });
  const act = useMutation({
    mutationFn: (a: { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) =>
      api<{ secret?: string } | null>(a.path, { method: a.method, body: a.body }),
    onSuccess: async (r) => {
      if (r?.secret) setSecret(r.secret);
      await refresh();
    },
  });
  const projectName = (id: string | null) =>
    id
      ? (projects.data?.find((p) => p.id === id)?.name ?? id)
      : t('admin.webhooksPage.allProjects');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1 className="text-2xl font-bold">{t('admin.webhooks')}</h1>
        <Button onClick={() => setCreating(true)}>{t('admin.webhooksPage.add')}</Button>
      </div>
      <p className="-mt-3 max-w-3xl text-slate-600">{t('admin.webhooksPage.intro')}</p>
      {act.isError ? <ErrorText>{t('admin.webhooksPage.error')}</ErrorText> : null}
      <QueryState query={list}>{null}</QueryState>
      {list.data && list.data.length === 0 ? (
        <Card>
          <p className="text-slate-600">{t('admin.webhooksPage.none')}</p>
        </Card>
      ) : null}
      <ul className="flex flex-col gap-4">
        {(list.data ?? []).map((e) => (
          <li key={e.id} data-webhook={e.url}>
            <Card className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="break-all font-mono text-sm font-semibold">{e.url}</div>
                  <div className="text-sm text-slate-600">
                    {e.events.map((v) => t(`admin.webhooksPage.events.${v}`)).join(', ')} ·{' '}
                    {projectName(e.projectId)}
                  </div>
                  <div className="text-sm">
                    {e.enabled
                      ? t('admin.webhooksPage.on')
                      : `${t('admin.webhooksPage.off')}${e.disabledReason ? `: ${e.disabledReason}` : ''}`}
                    {' · '}
                    {t('admin.webhooksPage.lastWeek', {
                      ok: e.lastWeek.delivered ?? 0,
                      waiting: e.lastWeek.pending ?? 0,
                      failed: e.lastWeek.failed ?? 0,
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() =>
                      act.mutate({
                        path: `/webhooks/${e.id}`,
                        method: 'PATCH',
                        body: { enabled: !e.enabled },
                      })
                    }
                  >
                    {e.enabled ? t('admin.webhooksPage.disable') : t('admin.webhooksPage.enable')}
                  </button>
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => act.mutate({ path: `/webhooks/${e.id}/test`, method: 'POST' })}
                  >
                    {t('admin.webhooksPage.test')}
                  </button>
                  <button type="button" className={smallBtn} onClick={() => setLog(e)}>
                    {t('admin.webhooksPage.deliveries')}
                  </button>
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => {
                      if (window.confirm(t('admin.webhooksPage.confirmRotate')))
                        act.mutate({ path: `/webhooks/${e.id}/rotate-secret`, method: 'POST' });
                    }}
                  >
                    {t('admin.webhooksPage.rotate')}
                  </button>
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => {
                      if (window.confirm(t('admin.webhooksPage.confirmDelete')))
                        act.mutate({ path: `/webhooks/${e.id}`, method: 'DELETE' });
                    }}
                  >
                    {t('admin.webhooksPage.remove')}
                  </button>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {creating ? (
        <NewDialog
          projects={projects.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={async (s) => {
            setCreating(false);
            setSecret(s);
            await refresh();
          }}
        />
      ) : null}
      {secret ? (
        <Dialog title={t('admin.webhooksPage.secretTitle')} onClose={() => setSecret(null)}>
          <div className="flex flex-col gap-4">
            <p role="status">{t('admin.webhooksPage.shownOnce')}</p>
            <code
              data-testid="webhook-secret"
              className="break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm"
            >
              {secret}
            </code>
            <Button onClick={() => setSecret(null)}>{t('admin.webhooksPage.done')}</Button>
          </div>
        </Dialog>
      ) : null}
      {log ? <LogDialog endpoint={log} onClose={() => setLog(null)} /> : null}
    </div>
  );
}

function NewDialog({
  projects,
  onClose,
  onCreated,
}: {
  projects: { id: string; name: string }[];
  onClose(): void;
  onCreated(secret: string): Promise<void>;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<string[]>(['interview.submitted']);
  const [projectId, setProjectId] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<{ secret: string }>('/webhooks', {
        method: 'POST',
        body: { url, events, projectId: projectId || null },
      }),
    onSuccess: (r) => onCreated(r.secret),
  });
  const toggle = (v: string) =>
    setEvents((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  return (
    <Dialog title={t('admin.webhooksPage.add')} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          {t('admin.webhooksPage.url')}
          <input
            className={inputCls}
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-slate-700">
            {t('admin.webhooksPage.eventsLabel')}
          </legend>
          {EVENTS.map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input type="checkbox" checked={events.includes(v)} onChange={() => toggle(v)} />
              {t(`admin.webhooksPage.events.${v}`)}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          {t('admin.webhooksPage.project')}
          <select
            className={inputCls}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('admin.webhooksPage.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {create.isError ? <ErrorText>{t('admin.webhooksPage.error')}</ErrorText> : null}
        <div className="flex gap-3">
          <Button type="submit" disabled={!events.length || create.isPending}>
            {t('admin.webhooksPage.create')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('admin.webhooksPage.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LogDialog({ endpoint, onClose }: { endpoint: Endpoint; onClose(): void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['webhook-deliveries', endpoint.id],
    queryFn: () => api<Delivery[]>(`/webhooks/${endpoint.id}/deliveries`),
  });
  const again = useMutation({
    mutationFn: (id: string) => api(`/webhooks/deliveries/${id}/redeliver`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-deliveries'] }),
  });
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <Dialog title={t('admin.webhooksPage.deliveries')} onClose={onClose} wide>
      <QueryState query={q}>{null}</QueryState>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 pr-3">{t('admin.webhooksPage.when')}</th>
              <th className="py-2 pr-3">{t('admin.webhooksPage.event')}</th>
              <th className="py-2 pr-3">{t('admin.webhooksPage.state')}</th>
              <th className="py-2 pr-3">{t('admin.webhooksPage.attempts')}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((d) => (
              <tr key={d.id} className="border-b border-slate-100">
                <td className="whitespace-nowrap py-2 pr-3">
                  {when.format(new Date(d.createdAt))}
                </td>
                <td className="py-2 pr-3">{d.event}</td>
                <td className="py-2 pr-3">
                  {t(`admin.webhooksPage.status.${d.status}`)}
                  {d.statusCode ? ` (${d.statusCode})` : d.error ? ` (${d.error})` : ''}
                </td>
                <td className="py-2 pr-3">{d.attempt}</td>
                <td className="py-2">
                  <button type="button" className={smallBtn} onClick={() => again.mutate(d.id)}>
                    {t('admin.webhooksPage.redeliver')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
