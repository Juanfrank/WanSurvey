import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { CheckField, Hint, inputCls } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, Field } from '../routes/ui.js';

interface Tenant {
  id: string;
  name: string;
  settings: { defaultLanguage?: string; defaultTimezone?: string };
}

interface Sso {
  configured: boolean;
  entraTenantId: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  enabled: boolean;
  enforceSso: boolean;
  allowedDomains: string[];
  redirectUri: string;
}

/** Languages offered for new projects; a project can add any other. */
const LANGUAGES = ['es', 'en', 'pt', 'fr', 'qu', 'ay'];

const zones = (): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf?.('timeZone') ?? ['UTC'];
};

/** A confirmation, by key so it follows a change of language. */
function Saved({ text }: { text: string | null }) {
  const { t } = useTranslation();
  return text ? (
    <p role="status" className="text-sm text-emerald-ink-800">
      {t(text)}
    </p>
  ) : null;
}

/** The organisation: its name, defaults of new projects, and Microsoft sign-in. */
export function OrganisationPage() {
  const { t } = useTranslation();
  const me = useMe();
  const tenant = useQuery({
    queryKey: ['tenant', me.data?.tenantId],
    queryFn: () => api<Tenant>('/tenant'),
    enabled: !!me.data,
  });
  const sso = useQuery({
    queryKey: ['tenant-sso', me.data?.tenantId],
    queryFn: () => api<Sso>('/tenant/sso'),
    enabled: !!me.data,
  });
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('admin.organisation')}</h1>
      <p className="-mt-3 max-w-3xl text-slate-600">{t('admin.org.intro')}</p>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {tenant.data ? <General tenant={tenant.data} /> : <div aria-busy="true" />}
        {sso.data ? <SsoForm sso={sso.data} /> : <div aria-busy="true" />}
      </div>
    </div>
  );
}

function General({ tenant }: { tenant: Tenant }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(tenant.name);
  const [language, setLanguage] = useState(tenant.settings.defaultLanguage ?? 'es');
  const [zone, setZone] = useState(
    tenant.settings.defaultTimezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  );
  const [saved, setSaved] = useState<string | null>(null);
  const languageName = useMemo(() => {
    const names = new Intl.DisplayNames([i18n.language], { type: 'language' });
    return (code: string) => names.of(code) ?? code;
  }, [i18n.language]);
  const zoneList = useMemo(() => {
    const all = zones();
    return all.includes(zone) ? all : [zone, ...all];
  }, [zone]);
  const save = useMutation({
    mutationFn: () =>
      api('/tenant', {
        method: 'PATCH',
        body: {
          name: name.trim(),
          settings: { defaultLanguage: language, defaultTimezone: zone },
        },
      }),
    onSuccess: async () => {
      setSaved('admin.org.saved');
      await qc.invalidateQueries({ queryKey: ['tenant'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  useEffect(() => setSaved(null), [name, language, zone]);
  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <h2 className="text-lg font-semibold">{t('admin.org.general')}</h2>
        <Field
          id="org-name"
          label={t('admin.org.name')}
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="org-language" className="text-sm font-medium text-slate-700">
                {t('admin.org.defaultLanguage')}
              </label>
              <select
                id="org-language"
                className={`${inputCls} py-2`}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {(LANGUAGES.includes(language) ? LANGUAGES : [language, ...LANGUAGES]).map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="org-zone" className="text-sm font-medium text-slate-700">
                {t('admin.org.defaultTimezone')}
              </label>
              <select
                id="org-zone"
                className={`${inputCls} py-2`}
                value={zone}
                onChange={(e) => setZone(e.target.value)}
              >
                {zoneList.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Hint>{t('admin.org.defaultsHint')}</Hint>
        </div>
        {save.isError ? <ErrorText>{t('admin.org.error')}</ErrorText> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {t('admin.org.save')}
          </Button>
          <Saved text={saved} />
        </div>
      </form>
    </Card>
  );
}

function SsoForm({ sso }: { sso: Sso }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [directory, setDirectory] = useState(sso.entraTenantId ?? '');
  const [clientId, setClientId] = useState(sso.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(sso.enabled);
  const [enforce, setEnforce] = useState(sso.enforceSso);
  const [domains, setDomains] = useState(sso.allowedDomains.join(', '));
  const [saved, setSaved] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api('/tenant/sso', {
        method: 'PUT',
        body: {
          entraTenantId: directory.trim(),
          clientId: clientId.trim(),
          ...(secret ? { clientSecret: secret } : {}),
          enabled,
          enforceSso: enabled && enforce,
          allowedDomains: domains
            .split(/[,\s]+/)
            .map((d) => d.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: async () => {
      setSecret('');
      setSaved('admin.org.ssoSaved');
      await qc.invalidateQueries({ queryKey: ['tenant-sso'] });
    },
  });
  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(null);
          save.mutate();
        }}
      >
        <h2 className="text-lg font-semibold">{t('admin.org.sso')}</h2>
        <p className="-mt-2 text-sm text-slate-600">{t('admin.org.ssoIntro')}</p>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">{t('admin.org.redirectUri')}</span>
          <code className="break-all rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-800">
            {sso.redirectUri}
          </code>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="sso-directory"
            label={t('admin.org.entraTenantId')}
            value={directory}
            autoComplete="off"
            onChange={(e) => setDirectory(e.target.value)}
          />
          <Field
            id="sso-client"
            label={t('admin.org.clientId')}
            value={clientId}
            autoComplete="off"
            onChange={(e) => setClientId(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Field
            id="sso-secret"
            type="password"
            label={t('admin.org.clientSecret')}
            value={secret}
            autoComplete="new-password"
            aria-describedby={sso.hasClientSecret ? 'sso-secret-hint' : undefined}
            onChange={(e) => setSecret(e.target.value)}
          />
          {sso.hasClientSecret ? (
            <Hint id="sso-secret-hint">{t('admin.org.secretKept')}</Hint>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Field
            id="sso-domains"
            label={t('admin.org.domains')}
            value={domains}
            aria-describedby="sso-domains-hint"
            onChange={(e) => setDomains(e.target.value)}
          />
          <Hint id="sso-domains-hint">{t('admin.org.domainsHint')}</Hint>
        </div>
        <CheckField label={t('admin.org.enabled')} checked={enabled} onChange={setEnabled} />
        <CheckField
          label={t('admin.org.enforce')}
          checked={enabled && enforce}
          onChange={setEnforce}
          disabled={!enabled}
        />
        {save.isError ? <ErrorText>{save.error.message || t('admin.org.error')}</ErrorText> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending || !directory.trim() || !clientId.trim()}>
            {t('admin.org.saveSso')}
          </Button>
          <Saved text={saved} />
        </div>
      </form>
    </Card>
  );
}
