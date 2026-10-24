import { type PlanCheck } from '@wansurvey/logic';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { controlCls } from '../designer/fields.js';
import { Card } from '../routes/ui.js';

export const sevCls: Record<PlanCheck['severity'], string> = {
  error: 'border-red-200 bg-red-50 text-red-ink-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-ink-900',
  info: 'border-sky-200 bg-sky-50 text-sky-ink-900',
};
export const sevIcon: Record<PlanCheck['severity'], string> = {
  error: '✕',
  warning: '!',
  info: 'i',
};

export function Layer({
  title,
  help,
  children,
  testId,
}: {
  title: string;
  help: string;
  children: ReactNode;
  testId: string;
}) {
  const id = useId();
  return (
    <Card>
      <section aria-labelledby={id} className="flex flex-col gap-4" data-testid={testId}>
        <div>
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-sm text-slate-600">{help}</p>
        </div>
        {children}
      </section>
    </Card>
  );
}

/**
 * An (i) next to a term: on hover, focus or tap it explains the term and the usual standard
 * (`cases.sampling.tips.<id>`). The explanation is the button's description for screen readers.
 */
export function InfoTip({ id, term }: { id: string; term: string }) {
  const { t } = useTranslation();
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const std = t(`cases.sampling.tips.${id}.std`, { defaultValue: '' });
  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-slate-400 font-serif text-[10px] font-bold italic leading-none text-slate-600 hover:border-indigo-600 hover:text-indigo-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        aria-label={t('cases.sampling.tip.label', { term })}
        aria-describedby={tipId}
        aria-expanded={open}
        data-tip={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        i
      </button>
      <span
        role="tooltip"
        id={tipId}
        hidden={!open}
        className="absolute left-1/2 top-full z-30 mt-1.5 w-72 max-w-[80vw] -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-3 text-left text-xs font-normal not-italic leading-relaxed text-slate-700 shadow-lg"
      >
        <span className="block">{t(`cases.sampling.tips.${id}.text`)}</span>
        {std ? (
          <span className="mt-1.5 block">
            <strong className="font-semibold text-slate-900">
              {t('cases.sampling.tip.standard')}
            </strong>{' '}
            {std}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** A choice among cards (radio group), each with a short explanation. */
export function Choice<T extends string>({
  legend,
  tip,
  value,
  options,
  onChange,
  disabled,
  columns = 2,
}: {
  legend: string;
  tip?: string;
  value: T;
  options: { value: T; label: string; hint?: string; tip?: string }[];
  onChange(v: T): void;
  disabled?: boolean;
  columns?: number;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-slate-700">
        {legend}
        {tip ? <InfoTip id={tip} term={legend} /> : null}
      </legend>
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(${columns > 2 ? 12 : 16}rem, 1fr))`,
        }}
      >
        {options.map((o) => (
          <div key={o.value} className="relative">
            <label className="flex h-full cursor-pointer gap-2 rounded-lg border border-slate-200 bg-white p-3 pr-7 text-sm has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50">
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                {o.hint ? <span className="block text-xs text-slate-600">{o.hint}</span> : null}
              </span>
            </label>
            {o.tip ? (
              <span className="absolute right-2 top-2.5">
                <InfoTip id={o.tip} term={o.label} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function YesNo({
  label,
  tip,
  value,
  onChange,
  disabled,
}: {
  label: string;
  tip?: string;
  value: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const name = useId();
  return (
    <fieldset disabled={disabled} className="flex flex-wrap items-center gap-3 text-sm">
      <legend className="mb-1 w-full font-medium text-slate-700">
        {label}
        {tip ? <InfoTip id={tip} term={label} /> : null}
      </legend>
      {[true, false].map((v) => (
        <label key={String(v)} className="flex items-center gap-1.5">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {v ? t('cases.sampling.yes') : t('cases.sampling.no')}
        </label>
      ))}
    </fieldset>
  );
}

export function Num({
  label,
  tip,
  value,
  onChange,
  step = 'any',
  min,
  max,
  percent,
  disabled,
}: {
  label: string;
  tip?: string;
  value: number | null;
  onChange(v: number | null): void;
  step?: string;
  min?: number;
  max?: number;
  /** Shown and typed as a percentage (0.05 ↔ 5). */
  percent?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const shown =
    value === null ? '' : percent ? String(Math.round(value * 10000) / 100) : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center">
        <label htmlFor={id} className="font-medium text-slate-700">
          {label}
        </label>
        {tip ? <InfoTip id={tip} term={label} /> : null}
      </span>
      <span className="relative flex items-center">
        <input
          id={id}
          className={`${controlCls} w-full tabular-nums ${percent ? 'pr-7' : ''}`}
          inputMode="decimal"
          value={text}
          disabled={disabled}
          step={step}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value.replace(',', '.'));
            if (e.target.value.trim() === '') onChange(null);
            else if (Number.isFinite(n)) onChange(percent ? n / 100 : n);
          }}
        />
        {percent ? (
          <span aria-hidden className="pointer-events-none absolute right-2.5 text-slate-500">
            %
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function VarSelect({
  label,
  tip,
  value,
  fields,
  onChange,
  disabled,
}: {
  label: string;
  tip?: string;
  value: string;
  fields: string[];
  onChange(v: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center">
        <label htmlFor={id} className="font-medium text-slate-700">
          {label}
        </label>
        {tip ? <InfoTip id={tip} term={label} /> : null}
      </span>
      <select
        id={id}
        className={`${controlCls} w-auto`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('cases.sampling.none')}</option>
        {fields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </div>
  );
}
