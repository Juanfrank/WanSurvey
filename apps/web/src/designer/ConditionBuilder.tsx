import {
  fromRows,
  NAMESPACES,
  opArity,
  toRows,
  tryParse,
  type ConditionOp,
  type ConditionRow,
  type ConditionRows,
  type Literal,
} from '@wansurvey/logic';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { controlCls, FieldError, Hint, inputCls, smallBtn } from './fields.js';
import type { VarOption } from './vars.js';

const OPS_FOR = (v: VarOption | undefined): ConditionOp[] => {
  const common: ConditionOp[] = ['answered', 'notAnswered', 'isDK', 'isRF'];
  if (!v) return ['==', '!=', '<', '<=', '>', '>=', 'in', 'notIn', 'between', ...common];
  if (v.questionType === 'multi' || v.questionType === 'ranking') return ['includes', ...common];
  if (v.codes) return ['==', '!=', 'in', 'notIn', ...common];
  if (v.numeric) return ['==', '!=', '<', '<=', '>', '>=', 'between', ...common];
  return ['==', '!=', 'in', 'notIn', ...common];
};

/** Typed text → literal: numbers stay numbers. */
export function toLiteral(s: string): Literal {
  const t = s.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
}

/** Variables that an expression refers to but that do not exist. */
export function unknownNames(src: string, known: ReadonlySet<string>): string[] {
  const parsed = tryParse(src);
  if (!parsed.ok) return [];
  const out = new Set<string>();
  const ns = new Set<string>([...NAMESPACES, 'mode', 'index', 'code']);
  const walk = (n: unknown, inMemberObject = false): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type: string; name?: string; [k: string]: unknown };
    if (node.type === 'var' && node.name && !ns.has(node.name) && !known.has(node.name)) {
      out.add(node.name);
    }
    if (node.type === 'member') {
      walk(node.object, true);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'span') continue;
      if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === 'object') walk(v, inMemberObject);
    }
  };
  walk(parsed.node);
  return [...out];
}

/**
 * Edits a condition as rows ("Q5 is at least 18", joined by all/any) or, when it does not fit
 * the rows or the designer prefers, as expression text. Both forms produce the same expression.
 */
export function ConditionBuilder({
  label,
  value,
  onChange,
  variables,
  hint,
}: {
  label: string;
  value: string | undefined;
  onChange(v: string | undefined): void;
  variables: VarOption[];
  hint?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const initial = useMemo(() => (value ? toRows(value) : { join: 'all' as const, rows: [] }), []);
  const [mode, setMode] = useState<'rows' | 'expr'>(initial ? 'rows' : 'expr');
  const [rows, setRows] = useState<ConditionRows>(initial ?? { join: 'all', rows: [] });
  const [text, setText] = useState(value ?? '');
  const emitted = useRef(value ?? '');

  // Outside changes (undo, rename): re-read the expression.
  useEffect(() => {
    if ((value ?? '') === emitted.current) return;
    emitted.current = value ?? '';
    setText(value ?? '');
    const r = value ? toRows(value) : { join: 'all' as const, rows: [] };
    if (r) setRows(r);
    else setMode('expr');
  }, [value]);

  const emit = (src: string) => {
    emitted.current = src;
    onChange(src.trim() ? src : undefined);
  };
  const updateRows = (next: ConditionRows) => {
    setRows(next);
    const src = fromRows(next);
    setText(src);
    emit(src);
  };
  const byName = useMemo(() => new Map(variables.map((v) => [v.name, v])), [variables]);
  const known = useMemo(() => new Set(variables.map((v) => v.name)), [variables]);

  const parsed = text.trim() ? tryParse(text) : null;
  const syntaxError = parsed && !parsed.ok ? parsed.error : null;
  const unknown = parsed?.ok ? unknownNames(text, known) : [];
  const fitsRows = !text.trim() || toRows(text) !== null;

  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium text-slate-700">{label}</legend>
      {hint ? <Hint>{hint}</Hint> : null}
      {mode === 'rows' ? (
        <>
          {rows.rows.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span>{t('designer.cond.match')}</span>
              <select
                className={`${controlCls} w-auto`}
                value={rows.join}
                onChange={(e) => updateRows({ ...rows, join: e.target.value as 'all' | 'any' })}
              >
                <option value="all">{t('designer.cond.all')}</option>
                <option value="any">{t('designer.cond.any')}</option>
              </select>
            </label>
          ) : null}
          {rows.rows.length === 0 ? (
            <p className="text-sm text-slate-600">{t('designer.cond.none')}</p>
          ) : null}
          <ol className="flex flex-col gap-2">
            {rows.rows.map((row, i) => (
              <RowEditor
                key={i}
                index={i}
                row={row}
                variables={variables}
                variable={byName.get(row.left)}
                onChange={(r) =>
                  updateRows({ ...rows, rows: rows.rows.map((x, j) => (j === i ? r : x)) })
                }
                onRemove={() => updateRows({ ...rows, rows: rows.rows.filter((_, j) => j !== i) })}
              />
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={smallBtn}
              onClick={() =>
                setRows({
                  ...rows,
                  rows: [...rows.rows, { left: variables[0]?.name ?? '', op: '==', values: [] }],
                })
              }
            >
              {t('designer.cond.add')}
            </button>
            <button type="button" className={smallBtn} onClick={() => setMode('expr')}>
              {t('designer.cond.asExpression')}
            </button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor={`${id}-expr`} className="sr-only">
            {label}
          </label>
          <textarea
            id={`${id}-expr`}
            rows={2}
            spellCheck={false}
            className={`${inputCls} font-mono`}
            value={text}
            aria-invalid={syntaxError ? true : undefined}
            aria-describedby={`${id}-help`}
            onChange={(e) => {
              setText(e.target.value);
              emit(e.target.value);
            }}
          />
          <Hint id={`${id}-help`}>{t('designer.cond.exprHelp')}</Hint>
          <FieldError>
            {syntaxError
              ? t('designer.cond.syntax', {
                  message: syntaxError.message,
                  at: syntaxError.span.start + 1,
                })
              : unknown.length
                ? t('designer.cond.unknown', { names: unknown.join(', ') })
                : null}
          </FieldError>
          <div>
            <button
              type="button"
              className={smallBtn}
              disabled={!fitsRows || !!syntaxError}
              onClick={() => {
                const r = text.trim() ? toRows(text) : { join: 'all' as const, rows: [] };
                if (r) {
                  setRows(r);
                  setMode('rows');
                }
              }}
            >
              {t('designer.cond.asRows')}
            </button>
            {!fitsRows ? (
              <span className="ml-2 text-xs text-slate-600">{t('designer.cond.tooComplex')}</span>
            ) : null}
          </div>
        </>
      )}
    </fieldset>
  );
}

function RowEditor({
  index,
  row,
  variables,
  variable,
  onChange,
  onRemove,
}: {
  index: number;
  row: ConditionRow;
  variables: VarOption[];
  variable: VarOption | undefined;
  onChange(r: ConditionRow): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const ops = OPS_FOR(variable);
  const arity = opArity(row.op);
  const codes = variable?.codes;
  const n = index + 1;

  const valueInput = (i: number, labelKey: string) =>
    codes && row.op !== 'between' ? (
      <select
        className={`${controlCls} w-auto`}
        aria-label={t(labelKey, { n })}
        value={row.values[i] === undefined ? '' : String(row.values[i])}
        onChange={(e) => {
          const values = [...row.values];
          values[i] = toLiteral(e.target.value);
          onChange({ ...row, values });
        }}
      >
        <option value="" disabled>
          {t('designer.cond.pick')}
        </option>
        {codes.map((c) => (
          <option key={String(c.code)} value={String(c.code)}>
            {c.code} · {c.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        type="text"
        className={`${controlCls} w-24`}
        aria-label={t(labelKey, { n })}
        inputMode={variable?.numeric ? 'decimal' : 'text'}
        value={row.values[i] === undefined ? '' : String(row.values[i])}
        onChange={(e) => {
          const values = [...row.values];
          if (e.target.value === '') values.splice(i, 1);
          else values[i] = toLiteral(e.target.value);
          onChange({ ...row, values });
        }}
      />
    );

  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="condition-row">
      <input
        type="text"
        list={`${id}-vars`}
        className={`${controlCls} w-36 font-mono`}
        aria-label={t('designer.cond.variable', { n })}
        value={row.left}
        onChange={(e) => {
          const next = variables.find((v) => v.name === e.target.value);
          const allowed = OPS_FOR(next);
          onChange({
            left: e.target.value,
            op: allowed.includes(row.op) ? row.op : allowed[0]!,
            values: [],
          });
        }}
      />
      <datalist id={`${id}-vars`}>
        {variables.map((v) => (
          <option key={v.name} value={v.name}>
            {v.text}
          </option>
        ))}
      </datalist>
      <select
        className={`${controlCls} w-auto`}
        aria-label={t('designer.cond.operator', { n })}
        value={row.op}
        onChange={(e) => {
          const op = e.target.value as ConditionOp;
          onChange({ ...row, op, values: opArity(op) === 'none' ? [] : row.values });
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`designer.op.${op}`)}
          </option>
        ))}
      </select>
      {arity === 'one' ? valueInput(0, 'designer.cond.value') : null}
      {arity === 'range' ? (
        <>
          {valueInput(0, 'designer.cond.low')}
          <span className="text-sm">{t('designer.cond.and')}</span>
          {valueInput(1, 'designer.cond.high')}
        </>
      ) : null}
      {arity === 'list' ? (
        codes ? (
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <legend className="sr-only">{t('designer.cond.values', { n })}</legend>
            {codes.map((c) => {
              const on = row.values.some((v) => String(v) === String(c.code));
              return (
                <label key={String(c.code)} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      onChange({
                        ...row,
                        values: on
                          ? row.values.filter((v) => String(v) !== String(c.code))
                          : [...row.values, c.code],
                      })
                    }
                  />
                  {c.code} · {c.label}
                </label>
              );
            })}
          </fieldset>
        ) : (
          <input
            type="text"
            className={`${controlCls} w-40`}
            aria-label={t('designer.cond.values', { n })}
            placeholder="1, 2, 3"
            defaultValue={row.values.join(', ')}
            onChange={(e) =>
              onChange({
                ...row,
                values: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map(toLiteral),
              })
            }
          />
        )
      ) : null}
      <button
        type="button"
        className={smallBtn}
        aria-label={t('designer.cond.remove', { n })}
        onClick={onRemove}
      >
        ✕
      </button>
    </li>
  );
}
