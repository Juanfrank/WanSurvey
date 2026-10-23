import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CawiTheme } from '@wansurvey/schema';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, upload } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Shell } from '../respondent/RespondentPage.js';
import { contrast } from '../respondent/theme.js';
import { ProjectLogo } from '../routes/ProjectLogo.js';
import { Button, ErrorText } from '../routes/ui.js';

const FONTS = ['sans', 'system', 'serif'] as const;
const CORNERS = ['rounded', 'square', 'pill'] as const;
const PLACES = ['left', 'center', 'hidden'] as const;

/**
 * The project's logo (shown in the app and on its web surveys) and the look of the web survey:
 * colours, type, corners and where the logo goes, with a preview as respondents see it.
 */
export function BrandingSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<CawiTheme>(project.settings.cawi.theme);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setTheme(project.settings.cawi.theme), [project.settings.cawi.theme]);
  const done = (p: Project, note: string) => {
    qc.setQueryData(['project', project.id], p);
    void qc.invalidateQueries({ queryKey: ['projects'] });
    setError(null);
    setMessage(note);
  };
  const fail = (e: unknown) => {
    setMessage('');
    setError(localiseError(t, e));
  };
  const sendLogo = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('file', f);
      return upload<Project>(`/projects/${project.id}/logo`, form, 'PUT');
    },
    onSuccess: (p) => done(p, t('cases.look.logoSaved')),
    onError: fail,
  });
  const removeLogo = useMutation({
    mutationFn: () => api<Project>(`/projects/${project.id}/logo`, { method: 'DELETE' }),
    onSuccess: (p) => done(p, t('cases.look.logoRemoved')),
    onError: fail,
  });
  const save = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: { settings: { cawi: { ...project.settings.cawi, theme } } },
      }),
    onSuccess: (p) => done(p, t('cases.look.saved')),
    onError: fail,
  });
  const set = (patch: Partial<CawiTheme>) => setTheme({ ...theme, ...patch });
  const readable =
    contrast(theme.primary, '#ffffff') >= 4.5 || contrast(theme.primary, '#0b1530') >= 4.5;
  const logoUrl = project.logoUpdatedAt
    ? `/api/v1/projects/${project.id}/logo?v=${Date.parse(project.logoUpdatedAt)}`
    : null;

  return (
    <div className="flex flex-col gap-6 text-sm">
      <section aria-labelledby="look-logo" className="flex flex-col gap-2">
        <h3 id="look-logo" className="text-base font-semibold">
          {t('cases.look.logo')}
        </h3>
        <p className="text-slate-600">{t('cases.look.logoHelp')}</p>
        <div className="flex flex-wrap items-center gap-3">
          {project.logoUpdatedAt ? (
            <span className="rounded-md border border-slate-200 bg-white p-2">
              <ProjectLogo project={project} className="h-12 w-auto max-w-[12rem]" />
            </span>
          ) : (
            <span className="text-slate-600">{t('cases.look.noLogo')}</span>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            aria-label={t('cases.look.choose')}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) sendLogo.mutate(f);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={sendLogo.isPending}
            onClick={() => file.current?.click()}
          >
            {project.logoUpdatedAt ? t('cases.look.replace') : t('cases.look.upload')}
          </Button>
          {project.logoUpdatedAt ? (
            <button
              type="button"
              className={smallBtn}
              disabled={removeLogo.isPending}
              onClick={() => {
                if (window.confirm(t('cases.look.confirmRemove'))) removeLogo.mutate();
              }}
            >
              {t('cases.look.remove')}
            </button>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="look-theme" className="flex flex-col gap-3">
        <h3 id="look-theme" className="text-base font-semibold">
          {t('cases.look.theme')}
        </h3>
        <p className="text-slate-600">{t('cases.look.themeHelp')}</p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cases.look.primary')}</span>
            <span className="flex items-center gap-2">
              <input
                type="color"
                className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white"
                value={theme.primary}
                onChange={(e) => set({ primary: e.target.value })}
              />
              <code className="text-xs">{theme.primary}</code>
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cases.look.background')}</span>
            <span className="flex items-center gap-2">
              <input
                type="color"
                className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white"
                value={theme.background}
                onChange={(e) => set({ background: e.target.value })}
              />
              <code className="text-xs">{theme.background}</code>
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cases.look.font')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={theme.font}
              onChange={(e) => set({ font: e.target.value as CawiTheme['font'] })}
            >
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {t(`cases.look.fonts.${f}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cases.look.corners')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={theme.corners}
              onChange={(e) => set({ corners: e.target.value as CawiTheme['corners'] })}
            >
              {CORNERS.map((c) => (
                <option key={c} value={c}>
                  {t(`cases.look.cornerKinds.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('cases.look.logoPlace')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={theme.logo}
              onChange={(e) => set({ logo: e.target.value as CawiTheme['logo'] })}
            >
              {PLACES.map((p) => (
                <option key={p} value={p}>
                  {t(`cases.look.places.${p}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!readable ? (
          <p className="text-amber-ink-800" role="status">
            {t('cases.look.lowContrast')}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('cases.look.save')}
          </Button>
          <button
            type="button"
            className={smallBtn}
            onClick={() =>
              setTheme({
                primary: '#0050dd',
                background: '#f8fafc',
                font: 'sans',
                corners: 'rounded',
                logo: 'left',
              })
            }
          >
            {t('cases.look.reset')}
          </button>
        </div>
      </section>
      <p role="status" aria-live="polite" className="text-emerald-ink-800 empty:hidden">
        {message}
      </p>
      <ErrorText>{error}</ErrorText>

      <section aria-labelledby="look-preview" className="flex flex-col gap-2">
        <h3 id="look-preview" className="text-base font-semibold">
          {t('cases.look.preview')}
        </h3>
        <div
          className="overflow-hidden rounded-lg border border-slate-200"
          data-testid="look-preview"
        >
          <Shell embedded title={project.name} branding={{ theme, logo: logoUrl }}>
            <div className="flex flex-col gap-3">
              <p className="font-semibold">{t('cases.look.sampleQuestion')}</p>
              {[t('cases.look.sampleYes'), t('cases.look.sampleNo')].map((o, i) => (
                <span
                  key={o}
                  className={`flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 ${
                    i === 0
                      ? 'border-indigo-600 bg-indigo-50 font-medium text-indigo-ink-800'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-4 rounded-full border-2 ${i === 0 ? 'border-indigo-600 bg-indigo-600' : 'border-slate-400'}`}
                  />
                  {o}
                </span>
              ))}
              <span className="self-start rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-on-fill">
                {t('cases.look.sampleNext')}
              </span>
            </div>
          </Shell>
        </div>
      </section>
    </div>
  );
}
