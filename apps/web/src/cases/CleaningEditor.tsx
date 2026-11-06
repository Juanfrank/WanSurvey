import type { CleaningRule, CleaningSettings } from '@wansurvey/schema';
import { useTranslation } from 'react-i18next';
import { controlCls, smallBtn } from '../designer/fields.js';

/**
 * How a list is cleaned as it is loaded: the text columns tidied, the saved rules that leave
 * rows out (an expression over the columns of the file, with `matches()` for patterns), and the
 * fields that tell the same person twice in a file.
 */
export function CleaningEditor({
  value,
  fields,
  onChange,
}: {
  value: CleaningSettings;
  /** The project's sample fields, offered for the duplicate check (with phone and e-mail). */
  fields: string[];
  onChange(v: CleaningSettings): void;
}) {
  const { t } = useTranslation();
  const setRule = (i: number, patch: Partial<CleaningRule>) =>
    onChange({
      ...value,
      rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    });
  const dupes = new Set(value.duplicateFields);
  const choices = [...new Set([...fields, 'phone', 'email', ...value.duplicateFields])];
  return (
    <div className="flex flex-col gap-6" data-testid="cleaning-settings">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('cases.cleaning.normalizeTitle')}</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.normalize.spaces}
            onChange={(e) =>
              onChange({ ...value, normalize: { ...value.normalize, spaces: e.target.checked } })
            }
          />
          {t('cases.cleaning.spaces')}
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.normalize.symbols}
            onChange={(e) =>
              onChange({ ...value, normalize: { ...value.normalize, symbols: e.target.checked } })
            }
          />
          {t('cases.cleaning.symbols')}
        </label>
        <p className="max-w-prose text-slate-600">{t('cases.cleaning.phoneNote')}</p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('cases.cleaning.rulesTitle')}</legend>
        <p className="max-w-prose text-slate-600">{t('cases.cleaning.rulesHelp')}</p>
        <ul className="flex flex-col gap-3">
          {value.rules.map((r, i) => (
            <li key={r.id} className="flex flex-col gap-1 rounded-md border border-slate-200 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => setRule(i, { enabled: e.target.checked })}
                  />
                  <span className="sr-only">{t('cases.cleaning.enabled')}</span>
                </label>
                <input
                  className={`${controlCls} w-64`}
                  value={r.name}
                  maxLength={100}
                  aria-label={t('cases.cleaning.name', { n: i + 1 })}
                  onChange={(e) => setRule(i, { name: e.target.value })}
                />
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() =>
                    onChange({ ...value, rules: value.rules.filter((_, j) => j !== i) })
                  }
                >
                  {t('cases.cleaning.remove')}
                </button>
              </div>
              <input
                className={`${controlCls} font-mono`}
                value={r.expression}
                maxLength={500}
                placeholder={t('cases.cleaning.expressionExample')}
                aria-label={t('cases.cleaning.expression', { n: i + 1 })}
                onChange={(e) => setRule(i, { expression: e.target.value })}
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${smallBtn} self-start`}
          disabled={value.rules.length >= 50}
          onClick={() =>
            onChange({
              ...value,
              rules: [
                ...value.rules,
                {
                  id: `r${Date.now().toString(36)}`,
                  name: t('cases.cleaning.newRule'),
                  expression: 'case.age < 18',
                  enabled: true,
                },
              ],
            })
          }
        >
          {t('cases.cleaning.add')}
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('cases.cleaning.duplicatesTitle')}</legend>
        <p className="max-w-prose text-slate-600">{t('cases.cleaning.duplicatesHelp')}</p>
        <div className="flex flex-wrap gap-3">
          {choices.map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={dupes.has(f)}
                disabled={!dupes.has(f) && dupes.size >= 5}
                onChange={(e) =>
                  onChange({
                    ...value,
                    duplicateFields: e.target.checked
                      ? [...value.duplicateFields, f]
                      : value.duplicateFields.filter((x) => x !== f),
                  })
                }
              />
              {f}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <span>{t('cases.cleaning.action')}</span>
          <select
            className={controlCls}
            value={value.duplicateAction}
            onChange={(e) =>
              onChange({ ...value, duplicateAction: e.target.value as 'warn' | 'exclude' })
            }
          >
            <option value="warn">{t('cases.cleaning.warn')}</option>
            <option value="exclude">{t('cases.cleaning.exclude')}</option>
          </select>
        </label>
      </fieldset>
    </div>
  );
}
