import type { LocalizedText } from '@wansurvey/schema';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Input look without a width, for inline controls. */
export const controlCls =
  'min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-[invalid=true]:border-red-600';
export const inputCls = `w-full ${controlCls}`;
export const smallBtn =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-50 disabled:opacity-50';

export function Group({
  title,
  children,
  className = '',
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={`flex min-w-0 flex-col gap-3 ${className}`}>
      <legend className="mb-1 text-sm font-semibold text-slate-800">{title}</legend>
      {children}
    </fieldset>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700">
      {children}
    </label>
  );
}

export function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-slate-600">
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-xs text-red-800">
      {children}
    </p>
  );
}

export function TextField({
  label,
  value,
  onChange,
  onCommit,
  mono,
  placeholder,
  hint,
  error,
  multiline,
  id: givenId,
  inputMode,
}: {
  label: ReactNode;
  value: string | undefined;
  onChange?(v: string): void;
  /** Called on blur/Enter instead of on every key (for renames). */
  onCommit?(v: string): void;
  mono?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  multiline?: boolean;
  id?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
}) {
  const auto = useId();
  const id = givenId ?? auto;
  const [local, setLocal] = useState(value ?? '');
  useEffect(() => setLocal(value ?? ''), [value]);
  const described = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ');
  const props = {
    id,
    className: `${inputCls} ${mono ? 'font-mono' : ''}`,
    value: onCommit ? local : (value ?? ''),
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described || undefined,
    onChange: (e: { target: { value: string } }) =>
      onCommit ? setLocal(e.target.value) : onChange?.(e.target.value),
    onBlur: () => {
      if (onCommit && local !== (value ?? '')) onCommit(local);
    },
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <textarea rows={3} {...props} />
      ) : (
        <input
          type="text"
          inputMode={inputMode}
          {...props}
          onKeyDown={(e) => {
            if (onCommit && e.key === 'Enter') {
              e.preventDefault();
              if (local !== (value ?? '')) onCommit(local);
            }
          }}
        />
      )}
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
      <FieldError id={`${id}-err`}>{error}</FieldError>
    </div>
  );
}

/** A number input that allows clearing (undefined) and keeps partial typing like "-" or "1.". */
export function NumberField({
  label,
  value,
  onChange,
  integer,
  hint,
}: {
  label: ReactNode;
  value: number | undefined;
  onChange(v: number | undefined): void;
  integer?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (value !== Number(text) || text === '') setText(value === undefined ? '' : String(value));
  }, [value]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        className={inputCls}
        value={text}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(e.target.value);
          if (v === '') onChange(undefined);
          else if (/^-?\d+(\.\d+)?$/.test(v)) {
            const n = Number(v);
            onChange(integer ? Math.trunc(n) : n);
          }
        }}
      />
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange(v: boolean): void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center gap-2 text-sm" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="h-4 w-4"
          checked={checked}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  id: givenId,
}: {
  label: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(v: T): void;
  hint?: ReactNode;
  id?: string;
}) {
  const auto = useId();
  const id = givenId ?? auto;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={inputCls}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

/** One input per questionnaire language. Empty languages are dropped unless `keepEmpty`. */
export function LocalizedField({
  label,
  value,
  languages,
  onChange,
  multiline,
  placeholder,
  keepEmpty = true,
  hint,
}: {
  label: ReactNode;
  value: LocalizedText | undefined;
  languages: string[];
  onChange(v: LocalizedText | undefined): void;
  multiline?: boolean;
  /** Per-language placeholder, e.g. the inherited base text. */
  placeholder?: LocalizedText;
  keepEmpty?: boolean;
  hint?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const set = (lang: string, text: string) => {
    const next: LocalizedText = { ...(value ?? {}) };
    if (text === '' && !keepEmpty) delete next[lang];
    else next[lang] = text;
    onChange(Object.keys(next).length ? next : undefined);
  };
  const missing = keepEmpty ? languages.filter((l) => !(value?.[l] ?? '').trim()) : [];
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1"
      aria-describedby={hint ? `${id}-hint` : undefined}
    >
      <legend className="text-sm font-medium text-slate-700">{label}</legend>
      <div className={`grid gap-2 ${languages.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {languages.map((lang) => {
          const props = {
            id: `${id}-${lang}`,
            className: inputCls,
            value: value?.[lang] ?? '',
            placeholder: placeholder?.[lang],
            'aria-label': `${typeof label === 'string' ? label : ''} (${lang})`,
            onChange: (e: { target: { value: string } }) => set(lang, e.target.value),
          };
          return (
            <div key={lang} className="flex min-w-0 items-start gap-1.5">
              <span
                className="mt-1.5 w-7 shrink-0 font-mono text-xs uppercase text-slate-500"
                aria-hidden
              >
                {lang}
              </span>
              {multiline ? <textarea rows={2} {...props} /> : <input type="text" {...props} />}
            </div>
          );
        })}
      </div>
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
      {missing.length && missing.length < languages.length ? (
        <Hint>{t('designer.missingTranslation', { langs: missing.join(', ') })}</Hint>
      ) : null}
    </fieldset>
  );
}

/** Drops undefined/empty fields so the saved JSON stays clean. */
export function clean<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0 && k !== 'items' && k !== 'options') continue;
    out[k] = v;
  }
  return out as T;
}
