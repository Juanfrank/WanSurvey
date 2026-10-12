import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssignmentMode, ProjectSettings } from '@wansurvey/schema';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
import { controlCls } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';

/** Per-project switches: automatic personal data for interviewers, and the assignment mode. */
export function SettingsTab({ project }: { project: Project }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<ProjectSettings>(project.settings);
  const [message, setMessage] = useState('');
  useEffect(() => setForm(project.settings), [project.settings]);
  const save = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: { settings: form } }),
    onSuccess: async (p) => {
      qc.setQueryData(['project', project.id], p);
      await qc.invalidateQueries({ queryKey: ['cases', project.id] });
      setMessage(t('cases.settings.saved'));
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  const modes: AssignmentMode[] = ['assigned', 'pool'];

  return (
    <form
      className="flex max-w-2xl flex-col gap-5 text-sm"
      aria-labelledby="settings-title"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage('');
        save.mutate();
      }}
    >
      <h2 id="settings-title" className="text-lg font-semibold">
        {t('cases.settings.title')}
      </h2>
      <div className="flex flex-col gap-1">
        <label className="flex items-start gap-2 font-medium">
          <input
            type="checkbox"
            className="mt-0.5"
            aria-describedby="settings-reveal-help"
            checked={form.revealToInterviewers}
            onChange={(e) => setForm({ ...form, revealToInterviewers: e.target.checked })}
          />
          {t('cases.settings.reveal')}
        </label>
        <p id="settings-reveal-help" className="ml-6 text-slate-600">
          {t('cases.settings.revealHelp')}
        </p>
      </div>
      <fieldset className="flex flex-col gap-1.5" aria-describedby="settings-mode-help">
        <legend className="mb-1 font-medium">{t('cases.settings.mode')}</legend>
        {modes.map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input
              type="radio"
              name="assignment-mode"
              className="mt-0.5"
              value={m}
              checked={form.assignmentMode === m}
              onChange={() => setForm({ ...form, assignmentMode: m })}
            />
            {t(`cases.settings.${m}`)}
          </label>
        ))}
        <p id="settings-mode-help" className="ml-6 text-slate-600">
          {t('cases.settings.poolHelp')}
        </p>
      </fieldset>
      <fieldset className="flex flex-col gap-3" data-testid="cati-settings">
        <legend className="mb-1 font-medium">{t('cati.settings.title')}</legend>
        <div className="flex flex-wrap gap-4">
          {(['from', 'to'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1">
              <span>
                {k === 'from' ? t('cati.settings.hoursFrom') : t('cati.settings.hoursTo')}
              </span>
              <input
                type="time"
                className={`${controlCls} w-auto`}
                aria-describedby="settings-hours-help"
                value={form.cati.callingHours[k]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    cati: {
                      ...form.cati,
                      callingHours: { ...form.cati.callingHours, [k]: e.target.value },
                    },
                  })
                }
              />
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span>{t('cati.settings.maxAttempts')}</span>
            <input
              type="number"
              min={1}
              max={50}
              className={`${controlCls} w-24`}
              value={form.cati.maxAttempts}
              onChange={(e) =>
                setForm({ ...form, cati: { ...form.cati, maxAttempts: Number(e.target.value) } })
              }
            />
          </label>
        </div>
        <p id="settings-hours-help" className="text-slate-600">
          {t('cati.settings.hoursHelp')}
        </p>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1">{t('cati.settings.retry')}</legend>
          {(['no_answer', 'busy', 'voicemail'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1">
              <span>{t(`cati.settings.${k}`)}</span>
              <input
                type="number"
                min={1}
                max={10080}
                className={`${controlCls} w-24`}
                value={form.cati.retryMinutes[k]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    cati: {
                      ...form.cati,
                      retryMinutes: { ...form.cati.retryMinutes, [k]: Number(e.target.value) },
                    },
                  })
                }
              />
            </label>
          ))}
        </fieldset>
      </fieldset>
      <fieldset className="flex flex-col gap-2" data-testid="capi-settings">
        <legend className="mb-1 font-medium">{t('cases.settings.capiTitle')}</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.capi.gps === 'start_end'}
            onChange={(e) =>
              setForm({
                ...form,
                capi: { ...form.capi, gps: e.target.checked ? 'start_end' : 'off' },
              })
            }
          />
          {t('cases.settings.gps')}
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('cases.settings.gpsNotice')}</span>
          <textarea
            className={`${controlCls} min-h-[3rem]`}
            value={form.capi.gpsNotice}
            maxLength={1000}
            onChange={(e) =>
              setForm({ ...form, capi: { ...form.capi, gpsNotice: e.target.value } })
            }
          />
        </label>
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {t('cases.settings.save')}
        </Button>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </div>
    </form>
  );
}
