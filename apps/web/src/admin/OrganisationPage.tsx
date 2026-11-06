import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCENTS,
  THEME_DEFAULTS,
  accentTokens,
  orgTheme,
  type Accent,
  type ThemeDefault,
} from '@wansurvey/schema';
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
  branding?: unknown;
}

interface Sso {
  configured: boolean;
  /** The directory and secret are the deployment's (ENTRA_*): shown, not edited. */
  managedByDeployment?: boolean;
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
  // Always in the page, so screen readers announce the text when it appears.
  return (
    <p role="status" className="text-sm text-emerald-ink-800 empty:hidden">
      {text ? t(text) : null}
    </p>
  );
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
        {tenant.data ? <Appearance tenant={tenant.data} /> : null}
        {sso.data ? <SsoEditor sso={sso.data} /> : <div aria-busy="true" />}
        <BiFrequency />
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

function SsoEditor({ sso }: { sso: Sso }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [directory, setDirectory] = useState(sso.entraTenantId ?? '');
  const [clientId, setClientId] = useState(sso.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(sso.enabled);
  const [enforce, setEnforce] = useState(sso.enforceSso);
  const [domains, setDomains] = useState(sso.allowedDomains.join(', '));
  const [saved, setSaved] = useState<string | null>(null);
  // The directory, application and secret of the deployment are shown, not edited, and not sent.
  const managed = !!sso.managedByDeployment;
  const save = useMutation({
    mutationFn: () =>
      api('/tenant/sso', {
        method: 'PUT',
        body: {
          ...(managed
            ? {}
            : {
                entraTenantId: directory.trim(),
                clientId: clientId.trim(),
                ...(secret ? { clientSecret: secret } : {}),
              }),
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
        <p className="-mt-2 text-sm text-slate-600">
          {t(managed ? 'admin.org.ssoManaged' : 'admin.org.ssoIntro')}
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">{t('admin.org.redirectUri')}</span>
          <code className="break-all rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-800">
            {sso.redirectUri}
          </code>
        </div>
        {managed ? (
          <dl className="flex flex-col gap-3">
            {(
              [
                [t('admin.org.entraTenantId'), sso.entraTenantId ?? ''],
                [t('admin.org.clientId'), sso.clientId ?? ''],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-sm font-medium text-slate-700">{label}</dt>
                <dd>
                  <code className="break-all rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-800">
                    {value}
                  </code>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <>
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
          </>
        )}
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
          <Button
            type="submit"
            disabled={save.isPending || (!managed && (!directory.trim() || !clientId.trim()))}
          >
            {t('admin.org.saveSso')}
          </Button>
          <Saved text={saved} />
        </div>
      </form>
    </Card>
  );
}

/**
 * The organisation's default theme and accent colour. Both are only defaults: a person who
 * picks their own theme in the account menu keeps it. Colours come from a short palette whose
 * text contrast is checked in both themes, so the interface stays readable.
 */
function Appearance({ tenant }: { tenant: Tenant }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const current = orgTheme(tenant.branding);
  const [def, setDef] = useState<ThemeDefault>(current.default);
  const [accent, setAccent] = useState<Accent>(current.accent);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api('/tenant', { method: 'PATCH', body: { branding: { theme: { default: def, accent } } } }),
    onSuccess: async () => {
      setSaved('admin.org.appearance.saved');
      await qc.invalidateQueries({ queryKey: ['tenant'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  useEffect(() => setSaved(null), [def, accent]);
  const swatch = (a: Accent) => accentTokens(a, 'light')['indigo-600'] ?? '#0050dd';
  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        data-testid="org-appearance"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 className="text-lg font-semibold">{t('admin.org.appearance.title')}</h2>
        <label className="flex max-w-xs flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            {t('admin.org.appearance.theme')}
          </span>
          <select
            className={`${inputCls} py-2`}
            value={def}
            onChange={(e) => setDef(e.target.value as ThemeDefault)}
          >
            {THEME_DEFAULTS.map((v) => (
              <option key={v} value={v}>
                {t(`app.themes.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-slate-700">
            {t('admin.org.appearance.accent')}
          </legend>
          <div className="flex flex-wrap gap-3">
            {ACCENTS.map((a) => (
              <label
                key={a}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
              >
                <input
                  type="radio"
                  name="org-accent"
                  checked={accent === a}
                  onChange={() => setAccent(a)}
                />
                <span
                  aria-hidden="true"
                  className="h-5 w-5 rounded-full border border-slate-300"
                  style={{ background: swatch(a) }}
                />
                {t(`admin.org.appearance.accents.${a}`)}
              </label>
            ))}
          </div>
          <Hint>{t('admin.org.appearance.hint')}</Hint>
        </fieldset>
        {save.isError ? <ErrorText>{t('admin.org.appearance.error')}</ErrorText> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {t('admin.org.save')}
          </Button>
          <Saved text={saved} />
        </div>
      </form>
    </Card>
  );
}

interface BiSetting {
  refreshMinutes: number | null;
  source: 'deployment' | 'setting';
  deploymentCron: string;
  lastRunAt: string | null;
}

/** Choices offered; `''` is the deployment's own schedule and `0` is never. */
const BI_CHOICES = ['', '15', '30', '60', '180', '360', '720', '1440', '10080', '0'] as const;

/** How often the analysis model (Power BI, SQL export) is refreshed; one setting for the installation. */
function BiFrequency() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = !!me.data?.permissions.includes('tenant.manage');
  const setting = useQuery({
    queryKey: ['app-settings-bi'],
    queryFn: () => api<BiSetting>('/app-settings/bi'),
    enabled: !!me.data,
  });
  const current =
    setting.data?.source === 'setting' ? String(setting.data.refreshMinutes ?? 0) : '';
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const shown = value ?? current;
  const save = useMutation({
    mutationFn: () =>
      api('/app-settings/bi', {
        method: 'POST',
        body: { refreshMinutes: shown === '' ? null : Number(shown) },
      }),
    onSuccess: async () => {
      setSaved('admin.org.bi.saved');
      setValue(null);
      await qc.invalidateQueries({ queryKey: ['app-settings-bi'] });
    },
  });
  const refresh = useMutation({
    mutationFn: () => api<{ ran: boolean }>('/app-settings/bi/refresh', { method: 'POST' }),
    onSuccess: (r) => setSaved(r.ran ? 'admin.org.bi.refreshed' : 'admin.org.bi.upToDate'),
  });
  const last = setting.data?.lastRunAt
    ? new Date(setting.data.lastRunAt).toLocaleString(i18n.language)
    : null;
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
        <h2 className="text-lg font-semibold">{t('admin.org.bi.title')}</h2>
        <p className="text-sm text-slate-600">{t('admin.org.bi.intro')}</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="bi-frequency" className="text-sm font-medium text-slate-700">
            {t('admin.org.bi.frequency')}
          </label>
          <select
            id="bi-frequency"
            className={`${inputCls} py-2`}
            value={shown}
            disabled={!canManage}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(null);
            }}
          >
            {BI_CHOICES.map((c) => (
              <option key={c} value={c}>
                {t(`admin.org.bi.choice.${c === '' ? 'deployment' : c}`)}
              </option>
            ))}
          </select>
          <Hint>
            {shown === ''
              ? t('admin.org.bi.deploymentHint', { cron: setting.data?.deploymentCron ?? '' })
              : t('admin.org.bi.settingHint')}
          </Hint>
        </div>
        <p className="text-sm text-slate-600">
          {last ? t('admin.org.bi.last', { when: last }) : t('admin.org.bi.never')}
        </p>
        {save.isError || refresh.isError ? <ErrorText>{t('admin.org.error')}</ErrorText> : null}
        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={value === null || save.isPending}>
              {t('admin.org.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={refresh.isPending}
              onClick={() => {
                setSaved(null);
                refresh.mutate();
              }}
            >
              {t('admin.org.bi.refreshNow')}
            </Button>
            <Saved text={saved} />
          </div>
        ) : null}
      </form>
    </Card>
  );
}
