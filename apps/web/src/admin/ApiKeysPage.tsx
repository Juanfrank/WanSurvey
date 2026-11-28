import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_KEY_MAX_DAYS, API_KEY_SCOPES } from '@wansurvey/schema';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { InfoTip } from '../cases/samplingControls.js';
import { ReadOnlyBadge } from './ReadOnlyBadge.js';
import {
  Button,
  Card,
  Drawer,
  ErrorText,
  QueryState,
  PageHeader,
  TableScroll,
} from '../routes/ui.js';
import { wordsLocale } from '../format.js';

interface Key {
  id: string;
  name: string;
  keyId: string;
  scopes: string[];
  projectId: string | null;
  allowedIps: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Keys of the integration API: created once, shown once, revoked at will. Whoever reads the
 * activity log without managing the keys sees them read only.
 */
export function ApiKeysPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = !!me.data?.permissions.includes('apikeys.manage');
  const keys = useQuery({
    queryKey: ['api-keys', me.data?.tenantId],
    queryFn: () => api<Key[]>('/api-keys'),
    enabled: !!me.data,
  });
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string }[]>('/projects'),
    enabled: !!me.data,
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['api-keys'] });
  const revoke = useMutation({
    mutationFn: (k: Key) => api(`/api-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRevoking(null);
      await refresh();
    },
  });
  const when = new Intl.DateTimeFormat(wordsLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const state = (k: Key) =>
    k.revokedAt
      ? t('admin.apiKeysPage.revoked')
      : new Date(k.expiresAt) <= new Date()
        ? t('admin.apiKeysPage.expired')
        : t('admin.apiKeysPage.active');
  const projectName = (id: string | null) =>
    id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : t('admin.apiKeysPage.allProjects');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.apiKeys')}
        aside={
          <InfoTip
            id="api-keys-intro"
            term={t('admin.apiKeys')}
            text={t('admin.apiKeysPage.intro')}
            align="start"
          />
        }
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>{t('admin.apiKeysPage.add')}</Button>
          ) : (
            <ReadOnlyBadge id="api-keys-read-only" text={t('admin.apiKeysPage.readOnly')} />
          )
        }
      />
      <QueryState query={keys}>{null}</QueryState>
      {keys.data && keys.data.length === 0 ? (
        <Card>
          <p className="text-slate-600">{t('admin.apiKeysPage.none')}</p>
        </Card>
      ) : null}
      {keys.data?.length ? (
        <Card className="p-4!">
          <TableScroll label={t('admin.apiKeys')}>
            <table
              className="w-full text-left text-sm [&_td]:whitespace-nowrap"
              data-testid="api-keys"
            >
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.name')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.scopes')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.project')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.expires')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.lastUsed')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.status')}</th>
                  {canManage ? (
                    <th className="py-2">
                      <span className="sr-only">{t('admin.apiKeysPage.actions')}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {keys.data.map((k) => (
                  <tr key={k.id} data-key={k.name} className="border-b border-slate-100">
                    <td className="py-1.5 pr-4">
                      <span className="font-medium">{k.name}</span>
                      <span className="ml-2 font-mono text-xs text-slate-500">wsk_{k.keyId}_…</span>
                    </td>
                    <td className="py-1.5 pr-4">
                      <ul className="flex gap-1">
                        {k.scopes.map((s) => (
                          <li
                            key={s}
                            title={t(`admin.apiKeysPage.scopeNames.${s}`)}
                            className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                          >
                            <span aria-hidden="true">{t(`admin.apiKeysPage.scopeShort.${s}`)}</span>
                            <span className="sr-only">
                              {t(`admin.apiKeysPage.scopeNames.${s}`)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="py-1.5 pr-4">{projectName(k.projectId)}</td>
                    <td className="py-1.5 pr-4">{when.format(new Date(k.expiresAt))}</td>
                    <td className="py-1.5 pr-4">
                      {k.lastUsedAt
                        ? when.format(new Date(k.lastUsedAt))
                        : t('admin.apiKeysPage.never')}
                    </td>
                    <td className="py-1.5 pr-4">{state(k)}</td>
                    {canManage ? (
                      <td className="py-1 text-right">
                        {k.revokedAt ? null : (
                          <button
                            type="button"
                            className={smallBtn}
                            aria-label={t('admin.apiKeysPage.revokeName', { name: k.name })}
                            onClick={() => {
                              revoke.reset();
                              setRevoking(k);
                            }}
                          >
                            {t('admin.apiKeysPage.revoke')}
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}
      {creating ? (
        <NewKeyDialog
          projects={projects.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={async (key) => {
            setCreating(false);
            setCreated(key);
            await refresh();
          }}
        />
      ) : null}
      {revoking ? (
        <Dialog
          title={t('admin.apiKeysPage.revokeTitle', { name: revoking.name })}
          onClose={() => setRevoking(null)}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-slate-700">{t('admin.apiKeysPage.revokeBody')}</p>
            {revoke.isError ? <ErrorText>{t('admin.apiKeysPage.error')}</ErrorText> : null}
            <div className="flex gap-3">
              <Button disabled={revoke.isPending} onClick={() => revoke.mutate(revoking)}>
                {t('admin.apiKeysPage.revokeConfirm')}
              </Button>
              <Button variant="secondary" onClick={() => setRevoking(null)}>
                {t('admin.apiKeysPage.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {created ? (
        <Dialog title={t('admin.apiKeysPage.add')} onClose={() => setCreated(null)}>
          <div className="flex flex-col gap-4">
            <p role="status">{t('admin.apiKeysPage.shownOnce')}</p>
            <code
              data-testid="new-api-key"
              className="break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm"
            >
              {created}
            </code>
            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(created)}
              >
                {t('admin.apiKeysPage.copy')}
              </Button>
              <Button onClick={() => setCreated(null)}>{t('admin.apiKeysPage.done')}</Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function NewKeyDialog({
  projects,
  onClose,
  onCreated,
}: {
  projects: { id: string; name: string }[];
  onClose(): void;
  onCreated(key: string): Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['projects:read', 'cases:read']);
  const [projectId, setProjectId] = useState('');
  const [expires, setExpires] = useState(day(new Date(Date.now() + 90 * 86_400_000)));
  const [ips, setIps] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<{ key: string }>('/api-keys', {
        method: 'POST',
        body: {
          name,
          scopes,
          projectId: projectId || null,
          // The end of that day, in the viewer's time zone.
          expiresAt: new Date(`${expires}T23:59:59`).toISOString(),
          allowedIps: ips
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: (r) => onCreated(r.key),
  });
  const max = day(new Date(Date.now() + (API_KEY_MAX_DAYS - 1) * 86_400_000));
  const toggle = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const formId = useId();

  return (
    <Drawer
      title={t('admin.apiKeysPage.add')}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('admin.apiKeysPage.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!name.trim() || !scopes.length || create.isPending}
          >
            {t('admin.apiKeysPage.create')}
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
          {t('admin.apiKeysPage.name')}
          <input
            className={inputCls}
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-slate-700">
            {t('admin.apiKeysPage.scopes')}
          </legend>
          {API_KEY_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
              {t(`admin.apiKeysPage.scopeNames.${s}`)}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          {t('admin.apiKeysPage.project')}
          <select
            className={inputCls}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('admin.apiKeysPage.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          {t('admin.apiKeysPage.expires')}
          <input
            type="date"
            className={inputCls}
            required
            min={day(new Date(Date.now() + 86_400_000))}
            max={max}
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          {t('admin.apiKeysPage.ips')}
          <textarea
            className={inputCls}
            rows={3}
            value={ips}
            onChange={(e) => setIps(e.target.value)}
          />
        </label>
        {create.isError ? <ErrorText>{t('admin.apiKeysPage.error')}</ErrorText> : null}
      </form>
    </Drawer>
  );
}
