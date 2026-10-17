import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { CheckField } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button, ErrorText } from '../routes/ui.js';
import type { Assignee } from './hooks.js';

/**
 * Hands the selected cases (or every free one) out at random and evenly among the people
 * chosen; optionally counting what each already holds so the totals come out even.
 */
export function DistributeDialog({
  projectId,
  questionnaireId,
  caseIds,
  people,
  onClose,
  onDone,
}: {
  projectId: string;
  questionnaireId: string | null;
  caseIds: string[];
  people: Assignee[];
  onClose(): void;
  onDone(message: string): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [balance, setBalance] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      api<{ changed: number; perPerson: Record<string, number> }>(
        `/projects/${projectId}/cases/distribute`,
        {
          method: 'POST',
          body: {
            userIds: [...chosen],
            balance,
            ...(caseIds.length ? { caseIds } : {}),
            ...(questionnaireId ? { questionnaireId } : {}),
          },
        },
      ),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
      await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
      onDone(t('cases.distribute.done', { count: r.changed, people: chosen.size }));
    },
  });
  const all = chosen.size === people.length;
  return (
    <Dialog title={t('cases.distribute.title')} onClose={onClose}>
      <form
        className="flex flex-col gap-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen.size) run.mutate();
        }}
      >
        <p className="text-slate-600">
          {caseIds.length
            ? t('cases.distribute.selected', { count: caseIds.length })
            : t('cases.distribute.free')}{' '}
          {t('cases.distribute.how')}
        </p>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('cases.distribute.people')}</legend>
          <label className="flex items-center gap-2 border-b border-slate-200 pb-1">
            <input
              type="checkbox"
              checked={all}
              onChange={() => setChosen(all ? new Set() : new Set(people.map((p) => p.userId)))}
            />
            {t('cases.distribute.everyone')}
          </label>
          <div className="grid max-h-60 gap-1 overflow-auto sm:grid-cols-2">
            {people.map((p) => (
              <label key={p.userId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={chosen.has(p.userId)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(p.userId);
                    else next.delete(p.userId);
                    setChosen(next);
                  }}
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
        <CheckField
          label={t('cases.distribute.balance')}
          hint={t('cases.distribute.balanceHint')}
          checked={balance}
          onChange={setBalance}
        />
        {run.isError ? <ErrorText>{localiseError(t, run.error)}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('cases.distribute.cancel')}
          </Button>
          <Button type="submit" disabled={!chosen.size || run.isPending}>
            {t('cases.distribute.run')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
