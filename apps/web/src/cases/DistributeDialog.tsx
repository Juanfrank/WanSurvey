import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { CheckField, NumberField, SelectField } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button, ErrorText } from '../routes/ui.js';
import type { Assignee } from './hooks.js';

const METHODS = ['even', 'capacity', 'performance', 'fair'] as const;
type Method = (typeof METHODS)[number];

interface ShareRow {
  userId: string;
  weight: number;
  share: number;
  source: 'even' | 'manual' | 'goal' | 'team_goal' | 'no_goal' | 'output';
  held: number;
  receive: number;
  limit: number | null;
}
interface Preview {
  rows: ShareRow[];
  free: number;
  skipped: number;
  count: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Hands the selected cases (or every free one) out at random among the people chosen: evenly,
 * in proportion to capacity (goals or weights), to recent productivity, or fairly (even, moved
 * a little by productivity). A preview shows what each person would get before anything moves.
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
  const [method, setMethod] = useState<Method>('even');
  const [manual, setManual] = useState<Record<string, number> | null>(null);
  const [days, setDays] = useState<number | undefined>(14);
  const [cap, setCap] = useState<number | undefined>(undefined);
  const body = {
    userIds: people.filter((p) => chosen.has(p.userId)).map((p) => p.userId),
    balance,
    method,
    ...(method === 'capacity' && manual
      ? { weights: Object.fromEntries([...chosen].map((id) => [id, manual[id] ?? 1])) }
      : {}),
    ...((method === 'performance' || method === 'fair') && days && days >= 7 && days <= 90
      ? { days }
      : {}),
    ...(cap && cap >= 1 ? { cap } : {}),
    ...(caseIds.length ? { caseIds } : {}),
    ...(questionnaireId ? { questionnaireId } : {}),
  };
  const preview = useQuery({
    queryKey: ['distribute-preview', projectId, body],
    queryFn: () =>
      api<Preview>(`/projects/${projectId}/cases/distribute/preview`, {
        method: 'POST',
        body,
      }),
    enabled: chosen.size > 0,
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: () =>
      api<{ changed: number; perPerson: Record<string, number>; free: number }>(
        `/projects/${projectId}/cases/distribute`,
        { method: 'POST', body },
      ),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
      await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
      onDone(
        t('cases.distribute.done', { count: r.changed, people: chosen.size }) +
          (r.free ? ` ${t('cases.distribute.leftFree', { count: r.free })}` : ''),
      );
    },
  });
  const all = chosen.size === people.length;
  const nameOf = new Map(people.map((p) => [p.userId, p.name]));
  const rows = chosen.size ? (preview.data?.rows ?? []) : [];
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
        <SelectField
          label={t('cases.distribute.method')}
          value={method}
          options={METHODS.map((m) => ({ value: m, label: t(`cases.distribute.methods.${m}`) }))}
          onChange={(m) => {
            setMethod(m);
            setManual(null);
          }}
          hint={t(`cases.distribute.methodHints.${method}`)}
        />
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
        {method === 'capacity' ? (
          <CheckField
            label={t('cases.distribute.manual')}
            hint={t('cases.distribute.manualHint')}
            checked={manual !== null}
            onChange={(on) =>
              setManual(
                on
                  ? Object.fromEntries(rows.map((r) => [r.userId, Math.round(r.weight * 10) / 10]))
                  : null,
              )
            }
          />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {method === 'performance' || method === 'fair' ? (
            <NumberField
              label={t('cases.distribute.days')}
              hint={t('cases.distribute.daysHint')}
              integer
              value={days}
              onChange={setDays}
            />
          ) : null}
          <NumberField
            label={t('cases.distribute.cap')}
            hint={t('cases.distribute.capHint')}
            integer
            value={cap}
            onChange={setCap}
          />
        </div>
        <CheckField
          label={t('cases.distribute.balance')}
          hint={t('cases.distribute.balanceHint')}
          checked={balance}
          onChange={setBalance}
        />
        {rows.length ? (
          <div className="overflow-x-auto" data-testid="distribute-preview">
            <table className="w-full min-w-[28rem] text-left">
              <caption className="mb-1 text-left font-medium">
                {t('cases.distribute.preview')}
              </caption>
              <thead className="text-xs text-slate-600">
                <tr>
                  <th scope="col" className="py-1 pr-3">
                    {t('cases.distribute.person')}
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    {t('cases.distribute.weight')}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    {t('cases.distribute.held')}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    {t('cases.distribute.receive')}
                  </th>
                  <th scope="col" className="py-1 text-right">
                    {t('cases.distribute.limit')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.userId} data-person={nameOf.get(r.userId)}>
                    <td className="py-1.5 pr-3">{nameOf.get(r.userId)}</td>
                    <td className="py-1.5 pr-3">
                      {method === 'capacity' && manual ? (
                        <input
                          type="number"
                          min={0}
                          step="any"
                          aria-label={t('cases.distribute.weightOf', {
                            name: nameOf.get(r.userId),
                          })}
                          className="w-20 rounded-md border border-slate-300 px-2 py-0.5"
                          value={manual[r.userId] ?? 1}
                          onChange={(e) =>
                            setManual({
                              ...manual,
                              [r.userId]: Math.max(0, Number(e.target.value)),
                            })
                          }
                        />
                      ) : (
                        <span className="tabular-nums">{pct(r.share)}</span>
                      )}
                      {r.source !== 'even' && r.source !== 'manual' ? (
                        <span className="ml-2 text-xs text-slate-600">
                          {' '}
                          {t(`cases.distribute.sources.${r.source}`, {
                            value: Math.round(r.weight * 10) / 10,
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.held}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                      {r.receive}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{r.limit ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.data?.free ? (
              <p className="mt-2 text-amber-ink-800" role="status">
                {t('cases.distribute.leftFree', { count: preview.data.free })}
              </p>
            ) : null}
          </div>
        ) : null}
        {preview.isError ? <ErrorText>{localiseError(t, preview.error)}</ErrorText> : null}
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
