import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import type { SampleField } from '../designer/vars.js';
import { localiseError } from '../i18n-messages.js';

/**
 * Readable names for the sample variables (first_name → “First name”), shown in the case list
 * and the case detail with the code under them. Folded away until needed.
 */
export function FieldLabels({ projectId, fields }: { projectId: string; fields: SampleField[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const changed = fields.filter(
        (f) => draft[f.name] !== undefined && draft[f.name]!.trim() !== (f.label ?? ''),
      );
      for (const f of changed)
        await api(`/projects/${projectId}/sample-fields/${encodeURIComponent(f.name)}`, {
          method: 'PUT',
          body: { label: draft[f.name]!.trim() || null },
        });
      return changed.length;
    },
    onSuccess: (n) => {
      setDraft({});
      setNote(t('cases.labels.saved', { count: n }));
    },
    onError: (e) => setNote(localiseError(t, e)),
    // Also after a failure part-way: the names saved before it show.
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
      await qc.invalidateQueries({ queryKey: ['sample-fields', projectId] });
    },
  });
  return (
    <details className="text-sm" data-testid="field-labels">
      <summary className="cursor-pointer font-medium">{t('cases.labels.title')}</summary>
      <form
        className="mt-2 flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-xs text-slate-600">{t('cases.labels.help')}</p>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 sm:max-w-lg">
          {fields.map((f) => (
            <div key={f.name} className="contents">
              <span className="font-mono text-slate-700">{f.name}</span>
              <input
                aria-label={t('cases.labels.of', { name: f.name })}
                className={controlCls}
                maxLength={200}
                value={draft[f.name] ?? f.label ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
              />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="submit" className={smallBtn} disabled={save.isPending}>
            {t('cases.labels.save')}
          </button>
          <p role="status" aria-live="polite" className="text-slate-700">
            {note}
          </p>
        </div>
      </form>
    </details>
  );
}
