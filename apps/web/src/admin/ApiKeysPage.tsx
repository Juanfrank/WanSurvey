import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_KEY_MAX_DAYS, API_KEY_SCOPES } from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, QueryState } from '../routes/ui.js';

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

/** Keys of the integration API: created once, shown once, revoked at will. */
export function ApiKeysPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
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
  const refresh = () => qc.invalidateQueries({ queryKey: ['api-keys'] });
  const revoke = useMutation({
    mutationFn: (k: Key) => api(`/api-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const state = (k: Key) =>
    k.revokedAt
      ? t('admin.apiKeysPage.revoked')
      : new Date(k.expiresAt) <= new Date()
        ? t('admin.apiKeysPage.expired')
        : t('admin.apiKeysPage.active');
  const projectName = (id: string | null) =>
    id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : t('admin.apiKeysPage.allProjects');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1 className="text-2xl font-bold">{t('admin.apiKeys')}</h1>
        <Button onClick={() => setCreating(true)}>{t('admin.apiKeysPage.add')}</Button>
      </div>
      <p className="-mt-3 max-w-3xl text-slate-600">{t('admin.apiKeysPage.intro')}</p>
      {revoke.isError ? <ErrorText>{t('admin.apiKeysPage.error')}</ErrorText> : null}
      <QueryState query={keys}>{null}</QueryState>
      {keys.data && keys.data.length === 0 ? (
        <Card>
          <p className="text-slate-600">{t('admin.apiKeysPage.none')}</p>
        </Card>
      ) : null}
      {keys.data?.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="api-keys">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.name')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.scopes')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.project')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.expires')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.lastUsed')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.apiKeysPage.status')}</th>
                <th className="py-2">
                  <span className="sr-only">{t('admin.apiKeysPage.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id} data-key={k.name} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{k.name}</div>
                    <div className="font-mono text-xs text-slate-500">wsk_{k.keyId}_…</div>
                  </td>
                  <td className="py-2 pr-4">
                    {k.scopes.map((s) => t(`admin.apiKeysPage.scopeNames.${s}`)).join(', ')}
                  </td>
                  <td className="py-2 pr-4">{projectName(k.projectId)}</td>
                  <td className="whitespace-nowrap py-2 pr-4">
                    {when.format(new Date(k.expiresAt))}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4">
                    {k.lastUsedAt
                      ? when.format(new Date(k.lastUsedAt))
                      : t('admin.apiKeysPage.never')}
                  </td>
                  <td className="py-2 pr-4">{state(k)}</td>
                  <td className="py-2">
                    {k.revokedAt ? null : (
                      <button
                        type="button"
                        className={smallBtn}
                        aria-label={t('admin.apiKeysPage.revokeName', { name: k.name })}
                        onClick={() => {
                          if (
                            window.confirm(t('admin.apiKeysPage.confirmRevoke', { name: k.name }))
                          )
                            revoke.mutate(k);
                        }}
                      >
                        {t('admin.apiKeysPage.revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

  return (
    <Dialog title={t('admin.apiKeysPage.add')} onClose={onClose}>
      <form
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
        <div className="flex gap-3">
          <Button type="submit" disabled={!name.trim() || !scopes.length || create.isPending}>
            {t('admin.apiKeysPage.create')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('admin.apiKeysPage.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
