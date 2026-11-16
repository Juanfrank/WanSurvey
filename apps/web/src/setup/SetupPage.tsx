import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { CheckField, Hint } from '../designer/fields.js';
import { LogoMark, LogoName } from '../routes/Logo.js';
import { Button, Card, ErrorText, Field } from '../routes/ui.js';

interface Step {
  id: 'server' | 'migrations' | 'login' | 'tables';
  state: 'ok' | 'pending' | 'blocked';
  reason?:
    | 'unreachable'
    | 'login_failed'
    | 'not_visible'
    | 'other'
    | 'owner_login_failed'
    | 'migration_failed';
}
interface Diagnosis {
  ready: boolean;
  steps: Step[];
}
interface Status {
  setup: boolean;
  mode: 'missing' | 'not-ready';
  diagnosis: Diagnosis | null;
}

interface Plan {
  tables: string;
  users: string;
  /** Only when a migration is newer than the structure of the first script. */
  migrations: string | null;
  pendingMigrations: string[];
  settings: { name: string; value: string; secret: boolean; onlyToMigrate?: boolean }[];
  passwordVariables: string[];
}

/** A script to copy: the text in a box, with Copy and Download. */
function Script({ id, text, file }: { id: string; text: string; file: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n').length;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={id}
        readOnly
        aria-label={file}
        value={text}
        rows={10}
        className="w-full rounded-md border border-slate-300 bg-slate-50 p-3 font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? t('setup.copied') : t('setup.copy')}
        </Button>
        <Button type="button" variant="secondary" onClick={download}>
          {t('setup.download')} ({file})
        </Button>
        <span className="text-xs text-slate-600">{t('setup.lines', { n: lines })}</span>
      </div>
    </div>
  );
}

/**
 * The installation wizard: shown while the API has no database settings. It asks for names and
 * addresses (never a password) and answers with the two SQL scripts and the settings.
 */
export function SetupPage() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<Status>('/setup/status'),
    retry: false,
    // With a database set, the wizard checks it by itself: here we only look at what it found.
    refetchInterval: (q) => (q.state.data?.mode === 'not-ready' ? 8_000 : false),
  });
  const recheck = useMutation({
    mutationFn: () => api<{ diagnosis: Diagnosis | null }>('/setup/check', { method: 'POST' }),
    onSuccess: () => void status.refetch(),
  });
  const diagnosis = status.data?.diagnosis ?? null;
  // Ready: the API closes the wizard and starts the application. Once it answers as the
  // application (not as the wizard), the sign-in page is next.
  useEffect(() => {
    if (!diagnosis?.ready) return;
    let stop = false;
    const wait = async () => {
      for (let i = 0; i < 90 && !stop; i++) {
        await new Promise((r) => setTimeout(r, 1_000));
        try {
          const res = await fetch('/health');
          const body = (await res.json()) as { status?: string };
          if (body.status === 'ok') return void location.assign('/login');
        } catch {
          // The server is changing over: try again.
        }
      }
    };
    void wait();
    return () => {
      stop = true;
    };
  }, [diagnosis?.ready]);
  const [f, setF] = useState({
    server: '',
    port: '1433',
    database: '',
    schema: 'survey',
    ownerUser: 'survey_owner',
    appUser: 'survey_rw',
    readonlyUser: 'survey_ro',
    usersByDba: false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const make = useMutation({
    mutationFn: () =>
      api<Plan>('/setup/scripts', {
        method: 'POST',
        body: { ...f, port: Number(f.port) || 1433 },
      }),
  });
  const plan = make.data;
  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-10">
      <main className="flex flex-col gap-6">
        <p className="flex items-center gap-3 text-2xl">
          <LogoMark className="h-9 w-9" />
          <LogoName />
        </p>
        <h1 className="text-2xl font-bold">{t('setup.title')}</h1>
        {status.isError ? (
          <Card>
            <p className="mb-3">{t('setup.alreadyDone')}</p>
            <Link to="/login" className="text-indigo-ink-700 underline">
              {t('setup.signIn')}
            </Link>
          </Card>
        ) : status.data ? (
          <>
            <p className="max-w-prose text-slate-800">
              {t(status.data.mode === 'not-ready' ? 'setup.notReady' : 'setup.intro')}
            </p>
            {status.data.mode === 'not-ready' ? (
              <Card>
                <h2 className="mb-3 text-lg font-semibold">{t('setup.progress')}</h2>
                {diagnosis?.ready ? (
                  <p role="status" className="font-medium text-emerald-ink-800">
                    {t('setup.ready')}
                  </p>
                ) : (
                  <ol className="flex flex-col gap-3" data-testid="setup-steps">
                    {(diagnosis?.steps ?? []).map((s) => (
                      <li
                        key={s.id}
                        data-step={s.id}
                        data-state={s.state}
                        className="flex flex-col"
                      >
                        <span className="font-medium">
                          {t(`setup.steps.${s.id}`)}: {t(`setup.state.${s.state}`)}
                        </span>
                        {s.state === 'pending' && s.reason ? (
                          <span className="text-sm text-slate-700">
                            {t(`setup.reasons.${s.reason}`)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-4">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={recheck.isPending}
                    onClick={() => recheck.mutate()}
                  >
                    {recheck.isPending ? t('setup.checking') : t('setup.checkAgain')}
                  </Button>
                </div>
              </Card>
            ) : null}
            <Card>
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  make.mutate();
                }}
              >
                <h2 className="text-lg font-semibold">{t('setup.form')}</h2>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <Field
                      id="setup-server"
                      label={t('setup.server')}
                      value={f.server}
                      required
                      autoComplete="off"
                      placeholder="sql.example.org"
                      onChange={set('server')}
                    />
                    <Hint>{t('setup.serverHint')}</Hint>
                  </div>
                  <Field
                    id="setup-port"
                    label={t('setup.port')}
                    value={f.port}
                    inputMode="numeric"
                    onChange={set('port')}
                  />
                </div>
                <Field
                  id="setup-database"
                  label={t('setup.database')}
                  value={f.database}
                  required
                  autoComplete="off"
                  onChange={set('database')}
                />
                <div className="flex flex-col gap-1">
                  <Field
                    id="setup-schema"
                    label={t('setup.schema')}
                    value={f.schema}
                    required
                    autoComplete="off"
                    onChange={set('schema')}
                  />
                  <Hint>{t('setup.schemaHint')}</Hint>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    id="setup-owner"
                    label={t('setup.ownerUser')}
                    value={f.ownerUser}
                    required
                    autoComplete="off"
                    onChange={set('ownerUser')}
                  />
                  <Field
                    id="setup-app"
                    label={t('setup.appUser')}
                    value={f.appUser}
                    required
                    autoComplete="off"
                    onChange={set('appUser')}
                  />
                  <Field
                    id="setup-ro"
                    label={t('setup.readonlyUser')}
                    value={f.readonlyUser}
                    autoComplete="off"
                    onChange={set('readonlyUser')}
                  />
                </div>
                <CheckField
                  label={t('setup.usersByDba')}
                  checked={f.usersByDba}
                  onChange={(v) => setF({ ...f, usersByDba: v })}
                />
                {make.isError ? (
                  <ErrorText>
                    {t('setup.error')}{' '}
                    {(
                      (make.error as { body?: { issues?: { path: string; message: string }[] } })
                        .body?.issues ?? []
                    )
                      .map((i) => `${i.path}: ${i.message}`)
                      .join(' · ')}
                  </ErrorText>
                ) : null}
                <div>
                  <Button type="submit" disabled={make.isPending}>
                    {make.isPending ? t('setup.generating') : t('setup.generate')}
                  </Button>
                </div>
              </form>
            </Card>
            {plan ? (
              <section aria-labelledby="setup-results" className="flex flex-col gap-6">
                <h2 id="setup-results" className="text-xl font-semibold">
                  {t('setup.results')}
                </h2>
                <Card>
                  <h3 className="mb-1 text-lg font-semibold">{t('setup.step1')}</h3>
                  <p className="mb-3 text-sm text-slate-700">{t('setup.step1Help')}</p>
                  <Script id="script-tables" text={plan.tables} file="1-tables.sql" />
                </Card>
                <Card>
                  <h3 className="mb-1 text-lg font-semibold">{t('setup.step2')}</h3>
                  <p className="mb-1 text-sm text-slate-700">{t('setup.step2Help')}</p>
                  <p className="mb-3 text-sm text-slate-700">
                    {plan.passwordVariables.length
                      ? t('setup.step2Vars', { vars: plan.passwordVariables.join(', ') })
                      : t('setup.step2Dba', { schema: f.schema })}
                  </p>
                  <Script id="script-users" text={plan.users} file="2-users.sql" />
                </Card>
                {plan.migrations ? (
                  <Card>
                    <h3 className="mb-1 text-lg font-semibold">{t('setup.step3')}</h3>
                    <p className="mb-1 text-sm text-slate-700">{t('setup.step3Help')}</p>
                    <p className="mb-3 text-sm text-slate-700">
                      {plan.pendingMigrations.join(', ')}
                    </p>
                    <Script id="script-migrations" text={plan.migrations} file="3-migrations.sql" />
                  </Card>
                ) : null}
                <Card>
                  <h3 className="mb-1 text-lg font-semibold">{t('setup.settingsTitle')}</h3>
                  <p className="mb-3 text-sm text-slate-700">{t('setup.settingsHelp')}</p>
                  <Script
                    id="script-settings"
                    text={plan.settings.map((s) => `${s.name}=${s.value}`).join('\n')}
                    file="settings.env"
                  />
                </Card>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
