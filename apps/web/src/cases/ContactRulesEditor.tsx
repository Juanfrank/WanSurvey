import { CONTACT_CHANNELS, type ContactRules } from '@wansurvey/schema';
import { useTranslation } from 'react-i18next';
import { controlCls } from '../designer/fields.js';

/** The project's rules for contacting people again (ADR 0002): exclusion window and permanence. */
export function ContactRulesEditor({
  value,
  onChange,
}: {
  value: ContactRules;
  onChange(v: ContactRules): void;
}) {
  const { t } = useTranslation();
  const days = (raw: string) => (raw.trim() === '' ? null : Math.max(1, Number(raw) || 1));
  return (
    <fieldset className="flex flex-col gap-3" data-testid="contact-rules">
      <legend className="mb-1 font-medium">{t('cases.contactRules.title')}</legend>
      <p className="max-w-prose text-slate-600">{t('cases.contactRules.help')}</p>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span>{t('cases.contactRules.exclusionDays')}</span>
          <input
            type="number"
            min={1}
            max={3650}
            className={`${controlCls} w-32`}
            placeholder={t('cases.contactRules.exclusionOff')}
            value={value.exclusion.days ?? ''}
            onChange={(e) =>
              onChange({ ...value, exclusion: { ...value.exclusion, days: days(e.target.value) } })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('cases.contactRules.noContactDays')}</span>
          <input
            type="number"
            min={1}
            max={36500}
            className={`${controlCls} w-32`}
            placeholder={t('cases.contactRules.permanent')}
            value={value.noContact.defaultDays ?? ''}
            onChange={(e) =>
              onChange({ ...value, noContact: { defaultDays: days(e.target.value) } })
            }
          />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-4" disabled={value.exclusion.days === null}>
        <legend className="mb-1">{t('cases.contactRules.exclusionChannels')}</legend>
        {CONTACT_CHANNELS.map((c) => (
          <label key={c} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.exclusion.channels.includes(c)}
              onChange={(e) =>
                onChange({
                  ...value,
                  exclusion: {
                    ...value.exclusion,
                    channels: e.target.checked
                      ? [...value.exclusion.channels, c]
                      : value.exclusion.channels.filter((x) => x !== c),
                  },
                })
              }
            />
            {c}
          </label>
        ))}
      </fieldset>
    </fieldset>
  );
}
