import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssignmentMode, ProjectSettings } from '@wansurvey/schema';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
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
