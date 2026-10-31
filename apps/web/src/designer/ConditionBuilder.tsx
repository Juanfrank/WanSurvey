import {
  BUILDER_FUNCTIONS,
  describeCondition,
  emptyGroup,
  evaluate,
  FUNCTIONS,
  fromTree,
  NAMESPACES,
  opArity,
  toTree,
  truthy,
  tryParse,
  typecheck,
  type BuilderFunction,
  type CondGroup,
  type CondItem,
  type CondRow,
  type ConditionOp,
  type Literal,
  type Operand,
  type Value,
} from '@wansurvey/logic';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useTypeVars } from './context.js';
import { controlCls, FieldError, Hint, inputCls, smallBtn } from './fields.js';
import { readNames, testScope, testValue } from './testScope.js';
import type { VarOption } from './vars.js';

const TESTS: ConditionOp[] = ['answered', 'notAnswered', 'isDK', 'isRF'];
const COMPARE: ConditionOp[] = ['==', '!=', '<', '<=', '>', '>='];

/** What kind of value an operand produces, for choosing operators and value pickers. */
type Shape = 'codes' | 'multi' | 'number' | 'date' | 'text' | 'unknown';

function shapeOf(o: Operand, byName: Map<string, VarOption>): Shape {
  if (o.kind === 'value') return typeof o.value === 'number' ? 'number' : 'text';
  if (o.kind === 'call') return o.name === 'today' ? 'date' : 'number';
  const v = byName.get(o.name);
  if (!v) return 'unknown';
  if (v.questionType === 'multi' || v.questionType === 'ranking') return 'multi';
  if (v.codes) return 'codes';
  if (v.questionType === 'date' || v.questionType === 'datetime') return 'date';
  if (v.numeric) return 'number';
  return 'text';
}

function opsFor(left: Operand, shape: Shape): ConditionOp[] {
  const tests = left.kind === 'var' ? TESTS : [];
  switch (shape) {
    case 'multi':
      return ['includes', ...tests];
    case 'codes':
      return ['==', '!=', 'in', 'notIn', ...tests];
    case 'number':
    case 'date':
      return [...COMPARE, 'between', ...tests];
    case 'text':
      return ['==', '!=', 'in', 'notIn', ...tests];
    default:
      return [...COMPARE, 'in', 'notIn', 'between', 'includes', ...tests];
  }
}

/** Typed text → literal: numbers stay numbers. */
export function toLiteral(s: string): Literal {
  const t = s.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
}

/** Variables that an expression refers to but that do not exist. */
export function unknownNames(src: string, known: ReadonlySet<string>): string[] {
  const parsed = tryParse(src);
  if (!parsed.ok) return [];
  return readNames(parsed.node).filter((n) => !known.has(n) && !n.includes('.') && n !== 'code');
}

const newRow = (variables: VarOption[]): CondRow => ({
  type: 'row',
  left: { kind: 'var', name: variables[0]?.name ?? '' },
  op: '==',
  right: [{ kind: 'value', value: '' }],
});

/** Paths address items inside the tree: [] is the root group, [1, 0] its 2nd item's 1st item. */
type Path = number[];

function updateAt(g: CondGroup, path: Path, fn: (i: CondItem) => CondItem | null): CondGroup {
  if (path.length === 0) return fn(g) as CondGroup;
  const [head, ...rest] = path;
  const items = g.items.flatMap((item, i) => {
    if (i !== head) return [item];
    if (rest.length === 0) {
      const r = fn(item);
      return r ? [r] : [];
    }
    return [updateAt(item as CondGroup, rest, fn)];
  });
  return { ...g, items };
}

/**
 * Edits a condition as nested groups of conditions ("Age is at least 18", joined by all/any,
 * optionally negated) or as expression text. Both produce the same expression. Shows the
 * condition in plain language and lets the designer try it against sample answers.
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
  const typeVars = useTypeVars();
  // The tree is built from the first value only; later edits come from this component.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once
  const initial = useMemo(() => toTree(value ?? ''), []);
  const [mode, setMode] = useState<'rows' | 'expr'>(initial ? 'rows' : 'expr');
  const [tree, setTree] = useState<CondGroup>(initial ?? emptyGroup());
  const [text, setText] = useState(value ?? '');
  const emitted = useRef(value ?? '');

  // Outside changes (undo, rename): re-read the expression.
  useEffect(() => {
    if ((value ?? '') === emitted.current) return;
    emitted.current = value ?? '';
    setText(value ?? '');
    const r = toTree(value ?? '');
    if (r) setTree(r);
    else setMode('expr');
  }, [value]);

  const emit = (src: string) => {
    emitted.current = src;
    onChange(src.trim() ? src : undefined);
  };
  const updateTree = (next: CondGroup) => {
    setTree(next);
    const src = fromTree(next);
    setText(src);
    emit(src);
  };
  const byName = useMemo(() => new Map(variables.map((v) => [v.name, v])), [variables]);
  const known = useMemo(() => new Set(variables.map((v) => v.name)), [variables]);

  const parsed = text.trim() ? tryParse(text) : null;
  const syntaxError = parsed && !parsed.ok ? parsed.error : null;
  const unknown = parsed?.ok ? unknownNames(text, known) : [];
  const typeIssues =
    parsed?.ok && typeVars && !unknown.length
      ? typecheck(parsed.node, { vars: typeVars, rosterChain: [] }).issues.filter(
          (i) => i.code === 'type_mismatch' || i.code === 'arity',
        )
      : [];
  const fitsRows = toTree(text) !== null;

  const label2 = (name: string, code: string | number | Value) => {
    const c = byName.get(name)?.codes?.find((x) => String(x.code) === String(code));
    return c?.label || null;
  };
  const summary = parsed?.ok
    ? describeCondition(parsed.node, {
        ref: (n) => n,
        label: (n, c) => label2(n, c),
        t: (k, v) => t(k, { ...v, ns: 'renderer' }),
      })
    : null;

  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium text-slate-700">{label}</legend>
      {hint ? <Hint>{hint}</Hint> : null}
      <p
        className="rounded bg-slate-50 px-2 py-1 text-sm text-slate-800"
        data-testid="condition-summary"
      >
        <span className="text-slate-500">{t('designer.cond.readsAs')} </span>
        {!text.trim() ? t('designer.cond.none') : (summary ?? '…')}
      </p>
      {mode === 'rows' ? (
        <>
          <GroupEditor
            group={tree}
            path={[]}
            prefix=""
            root
            variables={variables}
            byName={byName}
            onChange={(path, fn) => updateTree(updateAt(tree, path, fn))}
          />
          <div>
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
          <div>
            <button
              type="button"
              className={smallBtn}
              disabled={!fitsRows || !!syntaxError}
              onClick={() => {
                const r = toTree(text);
                if (r) {
                  setTree(r);
                  setMode('rows');
                }
              }}
            >
              {t('designer.cond.asRows')}
            </button>
            {!fitsRows && !syntaxError ? (
              <span className="ml-2 text-xs text-slate-600">{t('designer.cond.tooComplex')}</span>
            ) : null}
          </div>
        </>
      )}
      <FieldError>
        {syntaxError
          ? t('designer.cond.syntax', {
              message: syntaxError.message,
              at: syntaxError.span.start + 1,
            })
          : unknown.length
            ? t('designer.cond.unknown', { names: unknown.join(', ') })
            : typeIssues.length
              ? typeIssues.map((i) => i.message).join(' · ')
              : null}
      </FieldError>
      {parsed?.ok ? <TryIt node={parsed.node} byName={byName} labelOf={label2} /> : null}
    </fieldset>
  );
}

function GroupEditor({
  group,
  path,
  prefix,
  root,
  variables,
  byName,
  onChange,
}: {
  group: CondGroup;
  path: Path;
  /** Numbering prefix for labels, e.g. "2." inside the second item. */
  prefix: string;
  root?: boolean;
  variables: VarOption[];
  byName: Map<string, VarOption>;
  onChange(path: Path, fn: (i: CondItem) => CondItem | null): void;
}) {
  const { t } = useTranslation();
  const setGroup = (patch: Partial<CondGroup>) =>
    onChange(path, (g) => ({ ...(g as CondGroup), ...patch }));
  const add = (item: CondItem) => setGroup({ items: [...group.items, item] });
  const name = prefix ? t('designer.cond.groupN', { n: prefix.replace(/\.$/, '') }) : '';

  const body = (
    <>
      {group.items.length > 1 || group.negate ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <span>{t('designer.cond.match')}</span>
            <select
              className={`${controlCls} w-auto`}
              aria-label={root ? t('designer.cond.match') : `${name}: ${t('designer.cond.match')}`}
              value={`${group.negate ? 'not-' : ''}${group.join}`}
              onChange={(e) => {
                const v = e.target.value;
                setGroup({
                  join: v.endsWith('any') ? 'any' : 'all',
                  negate: v.startsWith('not-') || undefined,
                });
              }}
            >
              <option value="all">{t('designer.cond.all')}</option>
              <option value="any">{t('designer.cond.any')}</option>
              <option value="not-any">{t('designer.cond.noneOf')}</option>
              <option value="not-all">{t('designer.cond.notAll')}</option>
            </select>
          </label>
        </div>
      ) : null}
      {group.items.length === 0 && root ? (
        <p className="text-sm text-slate-600">{t('designer.cond.none')}</p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {group.items.map((item, i) => {
          const n = `${prefix}${i + 1}`;
          return (
            <li
              key={i}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault();
                  e.stopPropagation();
                  const to = i + (e.key === 'ArrowUp' ? -1 : 1);
                  if (to < 0 || to >= group.items.length) return;
                  const items = [...group.items];
                  const [x] = items.splice(i, 1);
                  items.splice(to, 0, x!);
                  setGroup({ items });
                }
              }}
            >
              {item.type === 'group' ? (
                <GroupEditor
                  group={item}
                  path={[...path, i]}
                  prefix={`${n}.`}
                  variables={variables}
                  byName={byName}
                  onChange={onChange}
                />
              ) : (
                <RowEditor
                  n={n}
                  row={item}
                  variables={variables}
                  byName={byName}
                  onChange={(r) => onChange([...path, i], () => r)}
                  onRemove={() => onChange([...path, i], () => null)}
                />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={smallBtn} onClick={() => add(newRow(variables))}>
          {root ? t('designer.cond.add') : t('designer.cond.addIn', { group: name })}
        </button>
        <button
          type="button"
          className={smallBtn}
          onClick={() =>
            add({
              type: 'group',
              join: group.join === 'all' ? 'any' : 'all',
              items: [newRow(variables)],
            })
          }
        >
          {root ? t('designer.cond.addGroup') : t('designer.cond.addGroupIn', { group: name })}
        </button>
        {!root ? (
          <button type="button" className={smallBtn} onClick={() => onChange(path, () => null)}>
            {t('designer.cond.removeGroup', { group: name })}
          </button>
        ) : null}
      </div>
    </>
  );

  if (root) return <div className="flex flex-col gap-2">{body}</div>;
  return (
    <div
      role="group"
      aria-label={name}
      className="flex flex-col gap-2 rounded-md border-l-4 border-indigo-200 bg-indigo-50/40 py-2 pl-3 pr-2"
      data-testid="condition-group"
    >
      {body}
    </div>
  );
}

function RowEditor({
  n,
  row,
  variables,
  byName,
  onChange,
  onRemove,
}: {
  n: string;
  row: CondRow;
  variables: VarOption[];
  byName: Map<string, VarOption>;
  onChange(r: CondRow): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const shape = shapeOf(row.left, byName);
  const ops = opsFor(row.left, shape);
  const arity = opArity(row.op);
  const leftVar = row.left.kind === 'var' ? byName.get(row.left.name) : undefined;
  const lbl = (key: string) => t(key, { n });

  const setLeft = (left: Operand) => {
    const s = shapeOf(left, byName);
    const allowed = opsFor(left, s);
    const op = allowed.includes(row.op) ? row.op : allowed[0]!;
    onChange({ ...row, left, op, right: rightFor(op, row.right) });
  };
  const rightFor = (op: ConditionOp, current: Operand[]): Operand[] => {
    const a = opArity(op);
    const blank: Operand = { kind: 'value', value: '' };
    if (a === 'none') return [];
    if (a === 'one') return [current[0] ?? blank];
    if (a === 'range') return [current[0] ?? blank, current[1] ?? blank];
    return current.filter((o) => o.kind === 'value' && o.value !== '');
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="condition-row">
      <OperandEditor
        label={lbl('designer.cond.variable')}
        operand={row.left}
        variables={variables}
        byName={byName}
        allowValue={false}
        onChange={setLeft}
      />
      <select
        className={`${controlCls} w-auto`}
        aria-label={lbl('designer.cond.operator')}
        value={row.op}
        onChange={(e) => {
          const op = e.target.value as ConditionOp;
          onChange({ ...row, op, right: rightFor(op, row.right) });
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`designer.op.${op}`)}
          </option>
        ))}
      </select>
      {arity === 'one' ? (
        <OperandEditor
          label={lbl('designer.cond.value')}
          operand={row.right[0] ?? { kind: 'value', value: '' }}
          variables={variables}
          byName={byName}
          shape={shape}
          codes={leftVar?.codes}
          allowValue
          onChange={(o) => onChange({ ...row, right: [o] })}
        />
      ) : null}
      {arity === 'range' ? (
        <>
          <OperandEditor
            label={lbl('designer.cond.low')}
            operand={row.right[0] ?? { kind: 'value', value: '' }}
            variables={variables}
            byName={byName}
            shape={shape}
            allowValue
            onChange={(o) =>
              onChange({ ...row, right: [o, row.right[1] ?? { kind: 'value', value: '' }] })
            }
          />
          <span className="text-sm">{t('designer.cond.and')}</span>
          <OperandEditor
            label={lbl('designer.cond.high')}
            operand={row.right[1] ?? { kind: 'value', value: '' }}
            variables={variables}
            byName={byName}
            shape={shape}
            allowValue
            onChange={(o) =>
              onChange({ ...row, right: [row.right[0] ?? { kind: 'value', value: '' }, o] })
            }
          />
        </>
      ) : null}
      {arity === 'list' ? (
        leftVar?.codes ? (
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <legend className="sr-only">{lbl('designer.cond.values')}</legend>
            {leftVar.codes.map((c) => {
              const on = row.right.some(
                (o) => o.kind === 'value' && String(o.value) === String(c.code),
              );
              return (
                <label key={String(c.code)} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      onChange({
                        ...row,
                        right: on
                          ? row.right.filter(
                              (o) => !(o.kind === 'value' && String(o.value) === String(c.code)),
                            )
                          : [...row.right, { kind: 'value', value: c.code }],
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
            aria-label={lbl('designer.cond.values')}
            placeholder="1, 2, 3"
            defaultValue={row.right.map((o) => (o.kind === 'value' ? o.value : '')).join(', ')}
            onChange={(e) =>
              onChange({
                ...row,
                right: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => ({ kind: 'value' as const, value: toLiteral(s) })),
              })
            }
          />
        )
      ) : null}
      <button
        type="button"
        className={smallBtn}
        aria-label={lbl('designer.cond.remove')}
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * One side of a condition: a typed value (code list, number, date or text), another variable,
 * or a function such as age(DOB) or today().
 */
function OperandEditor({
  label,
  operand,
  variables,
  byName,
  allowValue,
  shape = 'unknown',
  codes,
  onChange,
  depth = 0,
}: {
  label: string;
  operand: Operand;
  variables: VarOption[];
  byName: Map<string, VarOption>;
  allowValue: boolean;
  shape?: Shape;
  codes?: VarOption['codes'];
  onChange(o: Operand): void;
  depth?: number;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const kinds: Operand['kind'][] = allowValue ? ['value', 'var', 'call'] : ['var', 'call'];
  const kindSelect =
    depth === 0 ? (
      <select
        className={`${controlCls} w-auto text-xs`}
        aria-label={t('designer.cond.kindOf', { what: label })}
        value={operand.kind}
        onChange={(e) => {
          const k = e.target.value as Operand['kind'];
          onChange(
            k === 'value'
              ? { kind: 'value', value: '' }
              : k === 'var'
                ? { kind: 'var', name: '' }
                : {
                    kind: 'call',
                    name: shape === 'date' ? 'today' : 'age',
                    args: shape === 'date' ? [] : [{ kind: 'var', name: '' }],
                  },
          );
        }}
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {t(`designer.cond.kind.${k}`)}
          </option>
        ))}
      </select>
    ) : null;

  let editor: ReactNode;
  if (operand.kind === 'var') {
    editor = (
      <>
        <input
          type="text"
          list={listId}
          className={`${controlCls} w-36 font-mono`}
          aria-label={label}
          value={operand.name}
          onChange={(e) => onChange({ kind: 'var', name: e.target.value })}
        />
        <datalist id={listId}>
          {variables.map((v) => (
            <option key={v.name} value={v.name}>
              {v.text}
            </option>
          ))}
        </datalist>
      </>
    );
  } else if (operand.kind === 'call') {
    const def = FUNCTIONS[operand.name];
    const argCount = def ? (def.maxArgs ?? def.minArgs) : 1;
    editor = (
      <span className="flex flex-wrap items-center gap-1">
        <select
          className={`${controlCls} w-auto font-mono`}
          aria-label={t('designer.cond.function', { what: label })}
          value={operand.name}
          onChange={(e) => {
            const name = e.target.value as BuilderFunction;
            const d = FUNCTIONS[name];
            const count = d ? d.minArgs : 0;
            onChange({
              kind: 'call',
              name,
              args: Array.from(
                { length: count },
                (_, i) => operand.args[i] ?? { kind: 'var', name: '' },
              ),
            });
          }}
        >
          {BUILDER_FUNCTIONS.map((f) => (
            <option key={f} value={f}>
              {f}()
            </option>
          ))}
        </select>
        {argCount > 0 ? <span aria-hidden>(</span> : null}
        {operand.args.map((a, i) => (
          <OperandEditor
            key={i}
            label={t('designer.cond.argument', { n: i + 1, what: label })}
            operand={a}
            variables={variables}
            byName={byName}
            allowValue
            depth={depth + 1}
            onChange={(o) =>
              onChange({ ...operand, args: operand.args.map((x, j) => (j === i ? o : x)) })
            }
          />
        ))}
        {def && operand.args.length < argCount ? (
          <button
            type="button"
            className={smallBtn}
            aria-label={t('designer.cond.addArgument', { what: label })}
            onClick={() =>
              onChange({ ...operand, args: [...operand.args, { kind: 'value', value: '' }] })
            }
          >
            +
          </button>
        ) : null}
        {argCount > 0 ? <span aria-hidden>)</span> : null}
      </span>
    );
  } else {
    const v = operand.value;
    const set = (s: string) => onChange({ kind: 'value', value: s === '' ? '' : toLiteral(s) });
    if (codes && shape === 'codes') {
      editor = (
        <select
          className={`${controlCls} w-auto`}
          aria-label={label}
          value={v === '' ? '' : String(v)}
          onChange={(e) => set(e.target.value)}
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
      );
    } else if (shape === 'date') {
      editor = (
        <input
          type="date"
          className={`${controlCls} w-auto`}
          aria-label={label}
          value={typeof v === 'string' ? v : ''}
          onChange={(e) => onChange({ kind: 'value', value: e.target.value })}
        />
      );
    } else {
      editor = (
        <input
          type="text"
          className={`${controlCls} ${depth ? 'w-16' : 'w-24'}`}
          aria-label={label}
          inputMode={shape === 'number' ? 'decimal' : 'text'}
          value={String(v)}
          onChange={(e) => set(e.target.value)}
        />
      );
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {kindSelect}
      {editor}
    </span>
  );
}

/** Sample answers for every variable a condition reads, and whether it is true for them. */
function TryIt({
  node,
  byName,
  labelOf,
}: {
  node: Parameters<typeof readNames>[0];
  byName: Map<string, VarOption>;
  labelOf(name: string, code: Value): string | null;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const names = readNames(node);
  if (!names.length) return null;
  const result = truthy(evaluate(node, testScope(values, labelOf)));
  const missing = names.some((n) => {
    const v = testValue(values[n]);
    return v === null || (Array.isArray(v) && v.length === 0);
  });
  const ns = new Set<string>(NAMESPACES);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-slate-700">{t('designer.cond.tryIt')}</summary>
      <div className="mt-2 flex flex-col gap-2 rounded-md bg-slate-50 p-2">
        <div className="flex flex-wrap gap-3">
          {names.map((name) => {
            const v = byName.get(name);
            const raw = values[name];
            const set = (x: string | string[]) => setValues((s) => ({ ...s, [name]: x }));
            const label = t('designer.cond.testValue', { name });
            const isNs = name.includes('.') && ns.has(name.split('.')[0]!);
            let input: ReactNode;
            if (v?.codes && (v.questionType === 'multi' || v.questionType === 'ranking')) {
              const sel = Array.isArray(raw) ? raw : [];
              input = (
                <fieldset className="flex flex-wrap gap-2">
                  <legend className="sr-only">{label}</legend>
                  {v.codes.map((c) => (
                    <label key={String(c.code)} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={sel.includes(String(c.code))}
                        onChange={(e) =>
                          set(
                            e.target.checked
                              ? [...sel, String(c.code)]
                              : sel.filter((x) => x !== String(c.code)),
                          )
                        }
                      />
                      {c.code}
                    </label>
                  ))}
                </fieldset>
              );
            } else if (v?.codes) {
              input = (
                <select
                  className={`${controlCls} w-auto`}
                  aria-label={label}
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(e) => set(e.target.value)}
                >
                  <option value="">{t('designer.cond.unanswered')}</option>
                  {v.codes.map((c) => (
                    <option key={String(c.code)} value={String(c.code)}>
                      {c.code} · {c.label}
                    </option>
                  ))}
                  <option value="$DK">{t('designer.op.isDK')}</option>
                  <option value="$RF">{t('designer.op.isRF')}</option>
                </select>
              );
            } else {
              const date = v?.questionType === 'date' || v?.questionType === 'datetime';
              input = (
                <input
                  type={date ? 'date' : 'text'}
                  className={`${controlCls} w-28`}
                  aria-label={label}
                  inputMode={v?.numeric ? 'decimal' : undefined}
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(e) => set(e.target.value)}
                />
              );
            }
            return (
              <div key={name} className="flex flex-col gap-0.5">
                <span className="font-mono text-xs text-slate-600">
                  {name}
                  {isNs ? '' : v ? '' : ' ?'}
                </span>
                {input}
              </div>
            );
          })}
        </div>
        <p role="status" data-testid="try-result" data-result={result}>
          {t('designer.cond.result')}{' '}
          <strong className={result ? 'text-emerald-ink-800' : 'text-red-ink-800'}>
            {result ? t('designer.cond.true') : t('designer.cond.false')}
          </strong>
          {!result && missing ? (
            <span className="text-slate-600"> — {t('designer.cond.missingNote')}</span>
          ) : null}
        </p>
      </div>
    </details>
  );
}
