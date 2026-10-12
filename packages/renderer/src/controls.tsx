import type { RenderedOption } from '@wansurvey/logic';
import type { AnswerValue, Question } from '@wansurvey/schema';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RENDERER_NS } from './i18n.js';
import { pick } from './text.js';

/** Shared props of every answer control. */
export interface ControlProps {
  question: Question;
  options: RenderedOption[];
  value: AnswerValue;
  onChange(value: AnswerValue): void;
  /** The visible question heading; choice controls render it as the fieldset legend. */
  heading: ReactNode;
  /** id of the element describing errors/help, for aria-describedby. */
  describedBy?: string;
  /** Interviewer modes show option codes (they can be typed). */
  showCodes: boolean;
  /** Respondent mode on touch devices: larger targets. */
  touch: boolean;
  displayAs?: string;
  lang: string;
}

const isSpecialValue = (v: AnswerValue) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && '$special' in v;

const optionBox = (touch: boolean) =>
  [
    'flex items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left',
    'has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500',
    touch ? 'min-h-12 py-2 text-base' : 'min-h-10 py-1.5',
    'cursor-pointer hover:border-slate-400',
  ].join(' ');

const inputCls =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-[invalid=true]:border-red-600';

function Code({ code, show }: { code: string | number; show: boolean }) {
  if (!show) return null;
  return (
    <span className="min-w-8 rounded bg-slate-100 px-1.5 py-0.5 text-center font-mono text-sm text-slate-700">
      {code}
    </span>
  );
}

function Fieldset({
  heading,
  children,
  describedBy,
}: {
  heading: ReactNode;
  children: ReactNode;
  describedBy?: string;
}) {
  return (
    <fieldset aria-describedby={describedBy} className="min-w-0">
      <legend className="mb-3 w-full">{heading}</legend>
      {children}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

export function SingleChoice(p: ControlProps) {
  const { t } = useTranslation(RENDERER_NS);
  const name = useId();
  const selectId = useId();
  const selected = isSpecialValue(p.value) ? null : p.value;
  if (p.displayAs === 'dropdown') {
    return (
      <div>
        <label htmlFor={selectId} className="mb-3 block">
          {p.heading}
        </label>
        <select
          id={selectId}
          className={inputCls}
          aria-describedby={p.describedBy}
          value={selected === null || selected === undefined ? '' : String(selected)}
          onChange={(e) => {
            const o = p.options.find((x) => String(x.code) === e.target.value);
            p.onChange(o ? o.code : null);
          }}
        >
          <option value="">{t('question.selectPlaceholder')}</option>
          {p.options.map((o) => (
            <option key={String(o.code)} value={String(o.code)}>
              {p.showCodes ? `${o.code} · ` : ''}
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const buttons = p.displayAs === 'buttons';
  return (
    <Fieldset heading={p.heading} describedBy={p.describedBy}>
      <div className={buttons ? 'grid grid-cols-1 gap-2 sm:grid-cols-2' : 'flex flex-col gap-2'}>
        {p.options.map((o) => (
          <label key={String(o.code)} className={optionBox(p.touch || buttons)}>
            <input
              type="radio"
              name={name}
              className={buttons ? 'sr-only' : 'size-4 accent-indigo-600'}
              value={String(o.code)}
              checked={selected !== null && String(selected) === String(o.code)}
              onChange={() => p.onChange(o.code)}
              data-code={String(o.code)}
            />
            <Code code={o.code} show={p.showCodes} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </Fieldset>
  );
}

export function MultiChoice(p: ControlProps) {
  const selected = Array.isArray(p.value) ? (p.value as (string | number)[]) : [];
  const has = (c: string | number) => selected.some((s) => String(s) === String(c));
  const toggle = (o: RenderedOption) => {
    if (has(o.code)) return p.onChange(selected.filter((s) => String(s) !== String(o.code)));
    // Exclusive options ("None of these") replace the selection, and vice versa.
    if (o.exclusive) return p.onChange([o.code]);
    const exclusive = new Set(p.options.filter((x) => x.exclusive).map((x) => String(x.code)));
    return p.onChange([...selected.filter((s) => !exclusive.has(String(s))), o.code]);
  };
  return (
    <Fieldset heading={p.heading} describedBy={p.describedBy}>
      <div className="flex flex-col gap-2">
        {p.options.map((o) => (
          <label key={String(o.code)} className={optionBox(p.touch)}>
            <input
              type="checkbox"
              className="size-4 accent-indigo-600"
              checked={has(o.code)}
              onChange={() => toggle(o)}
              data-code={String(o.code)}
            />
            <Code code={o.code} show={p.showCodes} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </Fieldset>
  );
}

export function NumericInput(p: ControlProps & { onInvalid(msg: string | null): void }) {
  const { t } = useTranslation(RENDERER_NS);
  const id = useId();
  const external = typeof p.value === 'number' ? String(p.value) : '';
  const [text, setText] = useState(external);
  useEffect(() => setText(external), [external]);
  const unit = p.question.unit;
  return (
    <div>
      <label htmlFor={id} className="mb-3 block">
        {p.heading}
      </label>
      <div className="flex max-w-xs items-center gap-2">
        <input
          id={id}
          className={inputCls}
          inputMode={p.question.decimals ? 'decimal' : 'numeric'}
          autoComplete="off"
          aria-describedby={p.describedBy}
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            const normalised = raw.trim().replace(',', '.');
            if (normalised === '') {
              p.onInvalid(null);
              p.onChange(null);
            } else if (/^-?\d+(\.\d+)?$/.test(normalised)) {
              p.onInvalid(null);
              p.onChange(Number(normalised));
            } else {
              p.onInvalid(t('validation.not_number'));
            }
          }}
        />
        {unit ? <span className="text-slate-600">{pick(unit, p.lang)}</span> : null}
      </div>
    </div>
  );
}

export function TextInput(p: ControlProps) {
  const id = useId();
  const value = typeof p.value === 'string' ? p.value : '';
  const long = (p.question.maxLength ?? 0) > 120;
  const common = {
    id,
    className: inputCls,
    'aria-describedby': p.describedBy,
    maxLength: p.question.maxLength,
    value,
  };
  return (
    <div>
      <label htmlFor={id} className="mb-3 block">
        {p.heading}
      </label>
      {long ? (
        <textarea {...common} rows={4} onChange={(e) => p.onChange(e.target.value)} />
      ) : (
        <input {...common} autoComplete="off" onChange={(e) => p.onChange(e.target.value)} />
      )}
    </div>
  );
}

export function DateTimeInput(p: ControlProps) {
  const id = useId();
  const type = p.question.type === 'datetime' ? 'datetime-local' : p.question.type;
  const value =
    typeof p.value === 'string' ? p.value.slice(0, type === 'datetime-local' ? 16 : undefined) : '';
  return (
    <div>
      <label htmlFor={id} className="mb-3 block">
        {p.heading}
      </label>
      <input
        id={id}
        type={type}
        className={`${inputCls} max-w-xs`}
        aria-describedby={p.describedBy}
        value={value}
        onChange={(e) => p.onChange(e.target.value === '' ? null : e.target.value)}
      />
    </div>
  );
}

export function Scale(p: ControlProps) {
  const { t } = useTranslation(RENDERER_NS);
  const id = useId();
  const scale = p.question.scale!;
  const minLabel = pick(scale.minLabel, p.lang);
  const maxLabel = pick(scale.maxLabel, p.lang);
  const value = typeof p.value === 'number' ? p.value : null;
  if (scale.style === 'slider') {
    return (
      <div>
        <label htmlFor={id} className="mb-3 block">
          {p.heading}
        </label>
        <input
          id={id}
          type="range"
          className="w-full max-w-md accent-indigo-600"
          min={scale.min}
          max={scale.max}
          step={scale.step ?? 1}
          value={value ?? scale.min}
          aria-valuetext={value === null ? t('question.notSet') : String(value)}
          aria-describedby={p.describedBy}
          onChange={(e) => p.onChange(Number(e.target.value))}
        />
        <p className="mt-1 text-sm text-slate-600" aria-hidden="true">
          {value === null ? t('question.notSet') : t('question.sliderValue', { value })}
        </p>
      </div>
    );
  }
  const points: number[] = [];
  for (let n = scale.min; n <= scale.max; n += scale.step ?? 1) points.push(n);
  const name = `${id}-scale`;
  return (
    <Fieldset heading={p.heading} describedBy={p.describedBy}>
      <div className="flex flex-wrap gap-1.5" data-scale={scale.style}>
        {points.map((n) => (
          <label
            key={n}
            className={`flex ${p.touch ? 'size-12' : 'size-10'} cursor-pointer items-center justify-center rounded-md border border-slate-300 bg-white font-medium has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-600 has-[:checked]:text-white has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500`}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === n}
              onChange={() => p.onChange(n)}
              data-code={String(n)}
              aria-label={
                n === scale.min && minLabel
                  ? `${n} – ${minLabel}`
                  : n === scale.max && maxLabel
                    ? `${n} – ${maxLabel}`
                    : String(n)
              }
            />
            {n}
          </label>
        ))}
      </div>
      {minLabel || maxLabel ? (
        <div className="mt-1 flex justify-between gap-4 text-sm text-slate-600" aria-hidden="true">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      ) : null}
    </Fieldset>
  );
}

export function Grid(p: ControlProps) {
  const rows = p.question.rows ?? [];
  const value =
    typeof p.value === 'object' &&
    p.value !== null &&
    !Array.isArray(p.value) &&
    !isSpecialValue(p.value)
      ? (p.value as Record<string, string | number>)
      : {};
  const set = (row: string | number, code: string | number) =>
    p.onChange({ ...value, [String(row)]: code });
  return (
    <Fieldset heading={p.heading} describedBy={p.describedBy}>
      <div className="flex flex-col divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {rows.map((r) => (
          <fieldset
            key={String(r.code)}
            className="grid gap-2 p-3 sm:grid-cols-[minmax(8rem,1fr)_3fr] sm:items-center"
          >
            <legend className="sr-only">{pick(r.label, p.lang)}</legend>
            <span aria-hidden="true" className="font-medium">
              {pick(r.label, p.lang)}
            </span>
            <div className="flex flex-wrap gap-2">
              {p.options.map((o) => (
                <label
                  key={String(o.code)}
                  className={`${optionBox(p.touch)} flex-1 justify-center`}
                >
                  <input
                    type="radio"
                    name={`${p.question.name}-${String(r.code)}`}
                    className="size-4 accent-indigo-600"
                    checked={String(value[String(r.code)]) === String(o.code)}
                    onChange={() => set(r.code, o.code)}
                    data-code={String(o.code)}
                  />
                  <Code code={o.code} show={p.showCodes} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Fieldset>
  );
}

export function Ranking(p: ControlProps) {
  const { t } = useTranslation(RENDERER_NS);
  const answered = Array.isArray(p.value) ? (p.value as (string | number)[]) : null;
  const order = answered
    ? answered
        .map((c) => p.options.find((o) => String(o.code) === String(c)))
        .filter((o): o is RenderedOption => !!o)
    : p.options;
  const move = (i: number, d: -1 | 1) => {
    const next = order.map((o) => o.code);
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    p.onChange(next);
  };
  return (
    <Fieldset heading={p.heading} describedBy={p.describedBy}>
      <ol className="flex flex-col gap-2">
        {order.map((o, i) => (
          <li
            key={String(o.code)}
            className="flex items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <span className="w-16 text-sm text-slate-600">{t('question.rank', { n: i + 1 })}</span>
            <Code code={o.code} show={p.showCodes} />
            <span className="flex-1">{o.label}</span>
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
              aria-label={t('question.moveUp', { label: o.label })}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
              aria-label={t('question.moveDown', { label: o.label })}
              disabled={i === order.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      {!answered ? (
        <button
          type="button"
          className="mt-3 rounded-md border border-indigo-600 px-3 py-1.5 text-indigo-700"
          onClick={() => p.onChange(order.map((o) => o.code))}
        >
          {t('question.keepOrder')}
        </button>
      ) : null}
    </Fieldset>
  );
}
