import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorText } from '../routes/ui.js';

/** The longest interview a paper form may report, in minutes. */
export const MAX_FORM_MINUTES = 600;

/** Today on this device, as a date input holds it (YYYY-MM-DD). */
const localToday = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * What is wrong with the date and duration written on a form, if anything: the interview
 * cannot be later than today, and lasts a whole number of minutes, from 1 to 600. Both are
 * optional.
 */
export function paperMetaProblems(
  date: string,
  minutes: string,
  today = localToday(),
): { date?: 'invalid' | 'future'; minutes?: 'range' } {
  const out: { date?: 'invalid' | 'future'; minutes?: 'range' } = {};
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    const day = new Date(Date.UTC(y!, m! - 1, d!));
    // Round-trip: 2026-02-30 is not a day, though some parsers roll it over to March.
    const real =
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      day.getUTCFullYear() === y &&
      day.getUTCMonth() === m! - 1 &&
      day.getUTCDate() === d;
    if (!real) out.date = 'invalid';
    else if (date > today) out.date = 'future';
  }
  if (minutes.trim()) {
    const m = Number(minutes);
    if (!Number.isInteger(m) || m < 1 || m > MAX_FORM_MINUTES) out.minutes = 'range';
  }
  return out;
}

/** The date and duration written on the paper form, recorded as paradata (P4). */
export function PaperMeta({
  second,
  onSave,
}: {
  second: boolean;
  onSave(meta: { date: string | null; minutes: number | null }): void;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [minutes, setMinutes] = useState('');
  const [problems, setProblems] = useState<ReturnType<typeof paperMetaProblems>>({});
  // Each valid value is kept; a wrong one is shown, and left out, until it is corrected.
  const save = () => {
    const p = paperMetaProblems(date, minutes);
    setProblems(p);
    onSave({
      date: date && !p.date ? date : null,
      minutes: minutes.trim() && !p.minutes ? Number(minutes) : null,
    });
  };
  return (
    <section
      aria-label={t('papi.meta.title')}
      className="flex flex-col gap-1 text-sm"
      data-testid="paper-meta"
    >
      {/* One line under the case's status: label and field side by side, the rule after. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {second ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-ink-900">
            {t('papi.meta.second')}
          </span>
        ) : null}
        <label className="flex items-center gap-2">
          <span>{t('papi.meta.date')}</span>
          <input
            type="date"
            max={localToday()}
            className="rounded-md border border-slate-300 bg-white px-2 py-0.5"
            aria-invalid={problems.date ? true : undefined}
            aria-describedby="paper-meta-hint"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onBlur={save}
          />
        </label>
        <label className="flex items-center gap-2">
          <span>{t('papi.meta.minutes')}</span>
          <input
            type="number"
            min={1}
            max={MAX_FORM_MINUTES}
            step={1}
            className="w-20 rounded-md border border-slate-300 bg-white px-2 py-0.5"
            aria-invalid={problems.minutes ? true : undefined}
            aria-describedby="paper-meta-hint"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onBlur={save}
          />
        </label>
        <p id="paper-meta-hint" className="text-xs text-slate-600">
          {t('papi.meta.hint', { max: MAX_FORM_MINUTES })}
        </p>
      </div>
      <ErrorText>
        {[
          problems.date ? t(`papi.meta.errors.${problems.date}`) : null,
          problems.minutes ? t('papi.meta.errors.range', { max: MAX_FORM_MINUTES }) : null,
        ]
          .filter(Boolean)
          .join(' ')}
      </ErrorText>
    </section>
  );
}
