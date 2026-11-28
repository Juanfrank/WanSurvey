import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { InfoTip } from '../cases/samplingControls.js';
import {
  Button,
  Card,
  Drawer,
  ErrorText,
  MoreMenu,
  QueryState,
  PageHeader,
  TableScroll,
} from '../routes/ui.js';

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
  // Who reads the activity log sees the webhooks, read only.
  const canManage = !!me.data?.permissions.includes('apikeys.manage');
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
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.webhooks')}
        aside={
          <InfoTip
            id="webhooks-intro"
            term={t('admin.webhooks')}
            text={t('admin.webhooksPage.intro')}
            align="start"
          />
        }
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>{t('admin.webhooksPage.add')}</Button>
          ) : null
        }
      />
      {canManage ? null : (
        <p className="text-sm text-slate-600">{t('admin.webhooksPage.readOnly')}</p>
      )}
      {act.isError ? <ErrorText>{t('admin.webhooksPage.error')}</ErrorText> : null}
      <QueryState query={list}>{null}</QueryState>
      {list.data && list.data.length === 0 ? (
        <Card>
          <p className="text-slate-600">{t('admin.webhooksPage.none')}</p>
        </Card>
      ) : null}
      {list.data?.length ? (
        <Card className="p-4!">
          <TableScroll label={t('admin.webhooks')}>
            <table className="w-full text-left text-sm [&_td]:whitespace-nowrap">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-semibold">{t('admin.webhooksPage.url')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.webhooksPage.eventsLabel')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.webhooksPage.project')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.webhooksPage.state')}</th>
                  <th className="py-2 pr-4 font-semibold">
                    {t('admin.webhooksPage.lastWeekHead')}
                  </th>
                  <th className="py-2">
                    <span className="sr-only">{t('admin.webhooksPage.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((e) => {
                  const week = t('admin.webhooksPage.lastWeek', {
                    ok: e.lastWeek.delivered ?? 0,
                    waiting: e.lastWeek.pending ?? 0,
                    failed: e.lastWeek.failed ?? 0,
                  });
                  const state = e.enabled
                    ? t('admin.webhooksPage.on')
                    : `${t('admin.webhooksPage.off')}${e.disabledReason ? `: ${e.disabledReason}` : ''}`;
                  return (
                    <tr key={e.id} data-webhook={e.url} className="border-b border-slate-100">
                      <td className="py-1.5 pr-4 font-mono" title={e.url}>
                        <span className="block max-w-[22rem] truncate">{e.url}</span>
                      </td>
                      <td className="py-1.5 pr-4">
                        <ul className="flex gap-1">
                          {e.events.map((v) => (
                            <li
                              key={v}
                              title={t(`admin.webhooksPage.events.${v}`)}
                              className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                            >
                              <span aria-hidden="true">
                                {t(`admin.webhooksPage.eventShort.${v}`)}
                              </span>
                              <span className="sr-only">{t(`admin.webhooksPage.events.${v}`)}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="py-1.5 pr-4">{projectName(e.projectId)}</td>
                      <td className="py-1.5 pr-4" title={state}>
                        <span className="block max-w-[14rem] truncate">{state}</span>
                      </td>
                      <td className="py-1.5 pr-4 tabular-nums" title={week}>
                        <span aria-hidden="true">
                          <span className="text-emerald-ink-800">{e.lastWeek.delivered ?? 0}</span>
                          {' · '}
                          <span>{e.lastWeek.pending ?? 0}</span>
                          {' · '}
                          <span className={e.lastWeek.failed ? 'text-red-ink-800' : ''}>
                            {e.lastWeek.failed ?? 0}
                          </span>
                        </span>
                        <span className="sr-only">{week}</span>
                      </td>
                      <td className="py-1 text-right">
                        <span className="inline-flex items-center gap-2">
                          <button type="button" className={smallBtn} onClick={() => setLog(e)}>
                            {t('admin.webhooksPage.deliveries')}
                          </button>
                          {canManage ? (
                            <MoreMenu
                              label={t('admin.webhooksPage.actionsFor', { url: e.url })}
                              entries={[
                                {
                                  type: 'item',
                                  id: 'toggle',
                                  label: e.enabled
                                    ? t('admin.webhooksPage.disable')
                                    : t('admin.webhooksPage.enable'),
                                  onSelect: () =>
                                    act.mutate({
                                      path: `/webhooks/${e.id}`,
                                      method: 'PATCH',
                                      body: { enabled: !e.enabled },
                                    }),
                                },
                                {
                                  type: 'item',
                                  id: 'test',
                                  label: t('admin.webhooksPage.test'),
                                  onSelect: () =>
                                    act.mutate({ path: `/webhooks/${e.id}/test`, method: 'POST' }),
                                },
                                {
                                  type: 'item',
                                  id: 'rotate',
                                  label: t('admin.webhooksPage.rotate'),
                                  onSelect: () => {
                                    if (window.confirm(t('admin.webhooksPage.confirmRotate')))
                                      act.mutate({
                                        path: `/webhooks/${e.id}/rotate-secret`,
                                        method: 'POST',
                                      });
                                  },
                                },
                                { type: 'separator' },
                                {
                                  type: 'item',
                                  id: 'delete',
                                  label: t('admin.webhooksPage.remove'),
                                  onSelect: () => {
                                    if (window.confirm(t('admin.webhooksPage.confirmDelete')))
                                      act.mutate({ path: `/webhooks/${e.id}`, method: 'DELETE' });
                                  },
                                },
                              ]}
                            />
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}
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
      {log ? <LogDialog endpoint={log} canManage={canManage} onClose={() => setLog(null)} /> : null}
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
  const formId = useId();
  return (
    <Drawer
      title={t('admin.webhooksPage.add')}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('admin.webhooksPage.cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={!events.length || create.isPending}>
            {t('admin.webhooksPage.create')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
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
      </form>
    </Drawer>
  );
}

function LogDialog({
  endpoint,
  canManage,
  onClose,
}: {
  endpoint: Endpoint;
  canManage: boolean;
  onClose(): void;
}) {
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
              <th className="py-2">
                <span className="sr-only">{t('admin.webhooksPage.actions')}</span>
              </th>
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
                  {canManage ? (
                    <button type="button" className={smallBtn} onClick={() => again.mutate(d.id)}>
                      {t('admin.webhooksPage.redeliver')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
