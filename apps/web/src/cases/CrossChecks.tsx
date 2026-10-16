import type { CrossCheck } from '@wansurvey/schema/sampling';
import { useTranslation } from 'react-i18next';
import { controlCls, smallBtn } from '../designer/fields.js';

const CONTACTS = ['phone', 'email'] as const;
const RESULTS = ['COMPLETE', 'PARTIAL', 'REFUSAL'] as const;

/**
 * The plan's cross-case checks: a unit is not eligible when the same person (all the chosen
 * fields equal) had one of the results within the last days, in this project or in any
 * project of the organisation. Checked when the sample is loaded or selected.
 */
export function CrossChecks({
  value,
  fields,
  onChange,
}: {
  value: CrossCheck[];
  fields: string[];
  onChange(next: CrossCheck[]): void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<CrossCheck>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggle = <T extends string>(list: T[], x: T, on: boolean) =>
    on ? [...new Set([...list, x])] : list.filter((y) => y !== x);
  const choices = [...fields, ...CONTACTS];

  return (
    <fieldset className="flex flex-col gap-3 text-sm" data-testid="cross-checks">
      <legend className="mb-1 font-medium text-slate-700">{t('cases.sampling.cross.title')}</legend>
      <p className="text-xs text-slate-600">{t('cases.sampling.cross.help')}</p>
      {value.map((r, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3"
          data-cross-check={i + 1}
        >
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
            <legend className="mb-1 font-medium">
              {t('cases.sampling.cross.fields', { n: i + 1 })}
            </legend>
            {choices.map((f) => (
              <label key={f} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={r.fields.includes(f)}
                  onChange={(e) => update(i, { fields: toggle(r.fields, f, e.target.checked) })}
                />
                {CONTACTS.includes(f as (typeof CONTACTS)[number])
                  ? t(`cases.sampling.cross.contact.${f}`)
                  : f}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('cases.sampling.cross.within', { n: i + 1 })}</span>
              <input
                type="number"
                min={1}
                max={36500}
                className={`${controlCls} w-28`}
                value={r.withinDays}
                onChange={(e) =>
                  update(i, { withinDays: Math.max(1, Math.round(Number(e.target.value) || 1)) })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('cases.sampling.cross.scope', { n: i + 1 })}</span>
              <select
                className={`${controlCls} w-auto`}
                value={r.scope}
                onChange={(e) => update(i, { scope: e.target.value as CrossCheck['scope'] })}
              >
                <option value="project">{t('cases.sampling.cross.scopes.project')}</option>
                <option value="organisation">
                  {t('cases.sampling.cross.scopes.organisation')}
                </option>
              </select>
            </label>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
              <legend className="mb-1 font-medium">
                {t('cases.sampling.cross.results', { n: i + 1 })}
              </legend>
              {RESULTS.map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={r.results.includes(d)}
                    onChange={(e) => {
                      const next = toggle(r.results, d, e.target.checked);
                      if (next.length) update(i, { results: next });
                    }}
                  />
                  {t(`analysis.dispositionLabels.${d}`)}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className={smallBtn}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              {t('cases.sampling.cross.remove', { n: i + 1 })}
            </button>
          </div>
          <p className="text-xs text-slate-600" data-testid="cross-check-summary">
            {r.fields.length
              ? t('cases.sampling.cross.summary', {
                  fields: r.fields
                    .map((f) =>
                      CONTACTS.includes(f as (typeof CONTACTS)[number])
                        ? t(`cases.sampling.cross.contact.${f}`)
                        : f,
                    )
                    .join(' + '),
                  days: r.withinDays,
                  where: t(`cases.sampling.cross.scopes.${r.scope}`).toLowerCase(),
                })
              : t('cases.sampling.cross.pickFields')}
          </p>
        </div>
      ))}
      <div>
        <button
          type="button"
          className={smallBtn}
          onClick={() =>
            onChange([
              ...value,
              { fields: [], scope: 'project', withinDays: 180, results: ['COMPLETE'] },
            ])
          }
        >
          {t('cases.sampling.cross.add')}
        </button>
      </div>
    </fieldset>
  );
}
