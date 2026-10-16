import type { RenderedOption } from '@wansurvey/logic';
import type { AnswerValue, Question } from '@wansurvey/schema';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RENDERER_NS } from './i18n.js';
import { scaleColor } from './scaleColors.js';
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
              // A second click on the chosen option clears it (radios cannot be unticked otherwise).
              onClick={() => {
                if (selected !== null && String(selected) === String(o.code)) p.onChange(null);
              }}
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
    // Enter stays in the text; the runner moves on with Ctrl+Enter.
    'data-text-answer': '',
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
  const [typed, setTyped] = useState(value === null ? '' : String(value));
  useEffect(() => setTyped(value === null ? '' : String(value)), [value]);
  if (scale.style === 'slider') {
    const step = scale.step ?? 1;
    return (
      <div>
        <label htmlFor={id} className="mb-3 block">
          {p.heading}
        </label>
        <div className="flex max-w-xl items-center gap-3">
          <span className="shrink-0 text-sm tabular-nums text-slate-600" aria-hidden="true">
            {scale.min}
          </span>
          <input
            id={id}
            type="range"
            className="w-full accent-indigo-600"
            min={scale.min}
            max={scale.max}
            step={step}
            value={value ?? scale.min}
            aria-valuetext={value === null ? t('question.notSet') : String(value)}
            aria-describedby={p.describedBy}
            onChange={(e) => p.onChange(Number(e.target.value))}
          />
          <span className="shrink-0 text-sm tabular-nums text-slate-600" aria-hidden="true">
            {scale.max}
          </span>
        </div>
        {minLabel || maxLabel ? (
          <div
            className="mt-1 flex max-w-xl justify-between gap-4 text-sm text-slate-600"
            aria-hidden="true"
          >
            <span>{minLabel}</span>
            <span>{maxLabel}</span>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${id}-typed`} className="text-slate-700">
            {t('question.sliderType', { min: scale.min, max: scale.max })}
          </label>
          <input
            id={`${id}-typed`}
            className={`${inputCls} w-24`}
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            aria-describedby={p.describedBy}
            onChange={(e) => {
              setTyped(e.target.value);
              const n = Number(e.target.value.trim().replace(',', '.'));
              if (e.target.value.trim() === '') p.onChange(null);
              else if (Number.isFinite(n) && n >= scale.min && n <= scale.max) p.onChange(n);
            }}
          />
          <span className="text-slate-600" aria-live="polite">
            {value === null ? t('question.notSet') : t('question.sliderValue', { value })}
          </span>
        </div>
      </div>
    );
  }
  const points: number[] = [];
  for (let n = scale.min; n <= scale.max; n += scale.step ?? 1) points.push(n);
  const name = `${id}-scale`;
  return (
    <Fieldset heading={p.heading} describedBy={p.describedBy}>
      {/* One equal column per point across the whole width, so the ends line up with their labels. */}
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
        data-scale={scale.style}
        data-palette={scale.palette}
      >
        {points.map((n) => {
          const c = scaleColor(scale.palette, n, scale.min, scale.max);
          const on = value === n;
          return (
            <label
              key={n}
              className={`flex ${p.touch ? 'h-12' : 'h-10'} min-w-0 cursor-pointer items-center justify-center rounded-md border font-medium tabular-nums has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${
                c
                  ? on
                    ? 'text-white ring-2 ring-offset-1 ring-slate-900'
                    : ''
                  : 'border-slate-300 bg-white has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-600 has-[:checked]:text-on-fill'
              }`}
              style={c ? { background: on ? c.fill : c.tint, borderColor: c.border } : undefined}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={on}
                onChange={() => p.onChange(n)}
                onClick={() => {
                  if (on) p.onChange(null);
                }}
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
          );
        })}
      </div>
      {minLabel || maxLabel ? (
        <div className="mt-1 flex justify-between gap-4 text-sm text-slate-600" aria-hidden="true">
          <span>{minLabel}</span>
          <span className="text-right">{maxLabel}</span>
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
  const clearRow = (row: string | number) => {
    const { [String(row)]: _gone, ...rest } = value;
    p.onChange(Object.keys(rest).length ? rest : null);
  };
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
                    onClick={() => {
                      if (String(value[String(r.code)]) === String(o.code)) clearRow(r.code);
                    }}
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
          className="mt-3 rounded-md border border-indigo-600 px-3 py-1.5 text-indigo-ink-700"
          onClick={() => p.onChange(order.map((o) => o.code))}
        >
          {t('question.keepOrder')}
        </button>
      ) : null}
    </Fieldset>
  );
}
