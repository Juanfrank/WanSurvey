import type { EarlyExitSettings } from '@wansurvey/schema';
import { useTranslation } from 'react-i18next';
import { controlCls, smallBtn } from '../designer/fields.js';

/**
 * The reasons an interview can be closed early with (telephone calls interrupted), in Spanish and
 * English, and whether one is required. The codes stay when the wording changes.
 */
export function ExitReasonsEditor({
  value,
  onChange,
}: {
  value: EarlyExitSettings;
  onChange(v: EarlyExitSettings): void;
}) {
  const { t } = useTranslation();
  const set = (i: number, lang: 'es' | 'en', text: string) =>
    onChange({
      ...value,
      reasons: value.reasons.map((r, j) =>
        j === i ? { ...r, label: { ...r.label, [lang]: text } } : r,
      ),
    });
  return (
    <fieldset className="flex flex-col gap-3" data-testid="exit-reasons">
      <legend className="mb-1 font-medium">{t('cases.exitReasons.title')}</legend>
      <p className="max-w-prose text-slate-600">{t('cases.exitReasons.help')}</p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.required}
          onChange={(e) => onChange({ ...value, required: e.target.checked })}
        />
        {t('cases.exitReasons.required')}
      </label>
      <ul className="flex flex-col gap-2">
        {value.reasons.map((r, i) => (
          <li key={r.code} className="flex flex-wrap items-end gap-2">
            {(['es', 'en'] as const).map((lang) => (
              <label key={lang} className="flex flex-col gap-1">
                <span className="text-xs text-slate-600">{lang.toUpperCase()}</span>
                <input
                  className={`${controlCls} w-56`}
                  maxLength={120}
                  value={r.label[lang] ?? ''}
                  aria-label={t('cases.exitReasons.label', { n: i + 1, lang: lang.toUpperCase() })}
                  onChange={(e) => set(i, lang, e.target.value)}
                />
              </label>
            ))}
            <button
              type="button"
              className={smallBtn}
              onClick={() =>
                onChange({ ...value, reasons: value.reasons.filter((_, j) => j !== i) })
              }
            >
              {t('cases.exitReasons.remove')}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={`${smallBtn} self-start`}
        disabled={value.reasons.length >= 30}
        onClick={() =>
          onChange({
            ...value,
            reasons: [
              ...value.reasons,
              {
                code: `r_${Date.now().toString(36)}`,
                label: { es: 'Nuevo motivo', en: 'New reason' },
              },
            ],
          })
        }
      >
        {t('cases.exitReasons.add')}
      </button>
    </fieldset>
  );
}
