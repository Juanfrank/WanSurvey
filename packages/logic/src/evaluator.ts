import { NAMESPACES, type Namespace, type Node } from './ast.js';
import { FUNCTIONS } from './functions.js';
import {
  own,
  compareValues,
  finite,
  fromUnknown,
  isAnswered,
  isMissing,
  looseEquals,
  toNumber,
  truthy,
  type Value,
} from './values.js';

/**
 * What an expression can see. The engine provides an implementation backed by the live
 * interview; tests and the server use the same interface, so evaluation is identical everywhere.
 */
export interface Scope {
  /** Value of a question/computed/roster variable visible from here; undefined if unknown. */
  get(name: string): Value | undefined;
  /** Sample data, interviewer profile, project settings, respondent fields. */
  namespace(ns: Namespace): Record<string, unknown> | undefined;
  /** 1-based index of the innermost roster row, or null outside rosters. */
  rowIndex(): number | null;
  /** Child scope for row `row` (1-based) of roster `rosterName`, used by any()/all(). */
  rowScope(rosterName: string, row: number): Scope | null;
  /** Label of `code` for variable `name` in the active language. */
  label(name: string, code: Value): string | null;
  readonly mode: string | null;
  /** Today's date as ISO `YYYY-MM-DD`, injected so evaluation is deterministic. */
  readonly today: string;
}

const NS = new Set<string>(NAMESPACES);

/** Evaluates an AST. Never throws: anything that cannot be computed yields null. */
export function evaluate(node: Node, scope: Scope): Value {
  try {
    return evalNode(node, scope);
  } catch {
    return null;
  }
}

/** Evaluates a condition: true only when the expression is truthy (null → false). */
export function evaluateCondition(node: Node, scope: Scope): boolean {
  return truthy(evaluate(node, scope));
}

export function evalNode(node: Node, scope: Scope): Value {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'str':
      return node.value;
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'var':
      return resolveVar(node.name, scope);
    case 'member':
      return evalMember(node, scope);
    case 'index': {
      const obj = evalNode(node.object, scope);
      const idx = evalNode(node.index, scope);
      return indexValue(obj, idx);
    }
    case 'call': {
      const fn = own(FUNCTIONS, node.name);
      if (!fn) return null;
      if (
        node.args.length < fn.minArgs ||
        (fn.maxArgs !== undefined && node.args.length > fn.maxArgs)
      )
        return null;
      return fn.impl(node.args, scope, evalNode);
    }
    case 'unary': {
      if (node.op === 'not') return !truthy(evalNode(node.arg, scope));
      const n = toNumber(evalNode(node.arg, scope));
      return n === null ? null : -n;
    }
    case 'binary':
      return evalBinary(node, scope);
    case 'in': {
      const v = evalNode(node.value, scope);
      if (isMissing(v)) return false;
      const list = node.list.map((n) => evalNode(n, scope));
      const values = Array.isArray(v) ? v : [v];
      const hit = values.some((x) => list.some((l) => looseEquals(x, l)));
      return node.negated ? !hit : hit;
    }
    case 'between': {
      const v = evalNode(node.value, scope);
      const lo = evalNode(node.low, scope);
      const hi = evalNode(node.high, scope);
      if (isMissing(v) || isMissing(lo) || isMissing(hi)) return false;
      const a = compareValues(v, lo);
      const b = compareValues(v, hi);
      return a !== null && b !== null && a >= 0 && b <= 0;
    }
  }
}

function resolveVar(name: string, scope: Scope): Value {
  const v = scope.get(name);
  if (v !== undefined) return v;
  if (name === 'mode') return scope.mode;
  if (name === 'index') return scope.rowIndex();
  if (NS.has(name)) return fromUnknown(scope.namespace(name as Namespace) ?? null);
  return null;
}

function evalMember(node: Extract<Node, { type: 'member' }>, scope: Scope): Value {
  if (
    node.object.type === 'var' &&
    NS.has(node.object.name) &&
    scope.get(node.object.name) === undefined
  ) {
    const ns = scope.namespace(node.object.name as Namespace);
    return ns ? fromUnknown(own(ns, node.property)) : null;
  }
  const obj = evalNode(node.object, scope);
  return memberValue(obj, node.property);
}

/** `rows.FIELD` projects a roster column; `obj.FIELD` reads a field. */
export function memberValue(obj: Value, prop: string): Value {
  if (Array.isArray(obj)) {
    return obj.map((row) =>
      row !== null && typeof row === 'object' && !Array.isArray(row)
        ? (own(row as Record<string, Value>, prop) ?? null)
        : null,
    );
  }
  if (obj !== null && typeof obj === 'object')
    return own(obj as Record<string, Value>, prop) ?? null;
  return null;
}

/** Arrays are 1-based (`HH[1]` is the first member); objects are indexed by key. */
export function indexValue(obj: Value, idx: Value): Value {
  if (Array.isArray(obj)) {
    const n = toNumber(idx);
    if (n === null || !Number.isInteger(n) || n < 1) return null;
    return obj[n - 1] ?? null;
  }
  if (
    obj !== null &&
    typeof obj === 'object' &&
    (typeof idx === 'string' || typeof idx === 'number')
  ) {
    return own(obj as Record<string, Value>, String(idx)) ?? null;
  }
  return null;
}

function evalBinary(node: Extract<Node, { type: 'binary' }>, scope: Scope): Value {
  const { op } = node;
  if (op === 'and')
    return truthy(evalNode(node.left, scope)) && truthy(evalNode(node.right, scope));
  if (op === 'or') return truthy(evalNode(node.left, scope)) || truthy(evalNode(node.right, scope));

  // Explicit null checks: `Q == null` / `Q != null` test whether Q is unanswered.
  if ((op === '==' || op === '!=') && (node.left.type === 'null' || node.right.type === 'null')) {
    const other = node.left.type === 'null' ? node.right : node.left;
    const unanswered = !isAnswered(evalNode(other, scope));
    return op === '==' ? unanswered : !unanswered;
  }

  const l = evalNode(node.left, scope);
  const r = evalNode(node.right, scope);

  switch (op) {
    case '==':
    case '!=': {
      // Null semantics: any comparison involving an unanswered or special value is false.
      if (isMissing(l) || isMissing(r)) return false;
      const eq = looseEquals(l, r);
      return op === '==' ? eq : !eq;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (isMissing(l) || isMissing(r)) return false;
      const c = compareValues(l, r);
      if (c === null) return false;
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
    case '+':
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      return arith(l, r, (a, b) => a + b);
    case '-':
      return arith(l, r, (a, b) => a - b);
    case '*':
      return arith(l, r, (a, b) => a * b);
    case '/':
      return arith(l, r, (a, b) => (b === 0 ? NaN : a / b));
    case '%':
      return arith(l, r, (a, b) => (b === 0 ? NaN : a % b));
    case '^':
      return arith(l, r, (a, b) => a ** b);
  }
}

function arith(l: Value, r: Value, f: (a: number, b: number) => number): Value {
  const a = numeric(l);
  const b = numeric(r);
  if (a === null || b === null) return null;
  return finite(f(a, b));
}

/** Numbers and numeric strings (sample data imported from CSV) take part in arithmetic. */
function numeric(v: Value): number | null {
  return typeof v === 'boolean' ? null : toNumber(v);
}
