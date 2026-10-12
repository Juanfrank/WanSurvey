import { NAMESPACES, type Node } from './ast.js';
import { opArity, type ConditionOp, type Literal } from './conditionModel.js';
import { tryParse } from './parser.js';
import { printExpr } from './print.js';

/** Functions the visual builder offers as operands, e.g. `age(DOB) >= 18`, `count(Q4, 1) > 0`. */
export const BUILDER_FUNCTIONS = [
  'today',
  'age',
  'count',
  'length',
  'sum',
  'min',
  'max',
  'datediff',
  'round',
  'abs',
  'rosterCount',
] as const;
export type BuilderFunction = (typeof BUILDER_FUNCTIONS)[number];

/** One side of a comparison: a typed value, a variable (or `case.x`), or a function call. */
export type Operand =
  | { kind: 'value'; value: Literal }
  | { kind: 'var'; name: string }
  | { kind: 'call'; name: BuilderFunction; args: Operand[] };

export interface CondRow {
  type: 'row';
  left: Operand;
  op: ConditionOp;
  /** One operand for comparisons, a list for in/not in, two for between, none for tests. */
  right: Operand[];
}

export interface CondGroup {
  type: 'group';
  join: 'all' | 'any';
  /** "None of these" / "not all of these". */
  negate?: boolean;
  items: CondItem[];
}

export type CondItem = CondRow | CondGroup;

const NS = new Set<string>(NAMESPACES);
const FUNCS = new Set<string>(BUILDER_FUNCTIONS);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const FLIP: Record<string, ConditionOp> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

export const emptyGroup = (): CondGroup => ({ type: 'group', join: 'all', items: [] });

function operandOf(n: Node): Operand | null {
  switch (n.type) {
    case 'num':
      return { kind: 'value', value: n.value };
    case 'str':
      return { kind: 'value', value: n.value };
    case 'unary':
      return n.op === '-' && n.arg.type === 'num' ? { kind: 'value', value: -n.arg.value } : null;
    case 'var':
      return NS.has(n.name) ? null : { kind: 'var', name: n.name };
    case 'member':
      return n.object.type === 'var' && NS.has(n.object.name)
        ? { kind: 'var', name: `${n.object.name}.${n.property}` }
        : null;
    case 'call': {
      if (!FUNCS.has(n.name)) return null;
      const args = n.args.map(operandOf);
      return args.some((a) => a === null)
        ? null
        : { kind: 'call', name: n.name as BuilderFunction, args: args as Operand[] };
    }
    default:
      return null;
  }
}

const isRef = (o: Operand) => o.kind === 'var';

function rowOf(n: Node): CondRow | null {
  switch (n.type) {
    case 'binary': {
      if (!COMPARE.has(n.op)) return null;
      const l = operandOf(n.left);
      const r = operandOf(n.right);
      if (!l || !r) return null;
      // `18 <= AGE` reads as `AGE >= 18`.
      if (l.kind === 'value' && r.kind !== 'value') {
        return { type: 'row', left: r, op: FLIP[n.op] ?? (n.op as ConditionOp), right: [l] };
      }
      return { type: 'row', left: l, op: n.op as ConditionOp, right: [r] };
    }
    case 'in': {
      const left = operandOf(n.value);
      const right = n.list.map(operandOf);
      if (!left || right.some((x) => x === null)) return null;
      return { type: 'row', left, op: n.negated ? 'notIn' : 'in', right: right as Operand[] };
    }
    case 'between': {
      const left = operandOf(n.value);
      const lo = operandOf(n.low);
      const hi = operandOf(n.high);
      if (!left || !lo || !hi) return null;
      return { type: 'row', left, op: 'between', right: [lo, hi] };
    }
    case 'call': {
      const left = n.args[0] ? operandOf(n.args[0]) : null;
      if (!left || !isRef(left)) return null;
      if (n.args.length === 1) {
        const op = ({ answered: 'answered', isDK: 'isDK', isRefused: 'isRF' } as const)[
          n.name as 'answered' | 'isDK' | 'isRefused'
        ];
        return op ? { type: 'row', left, op, right: [] } : null;
      }
      if (n.name === 'contains' && n.args.length === 2) {
        const v = operandOf(n.args[1]!);
        return v ? { type: 'row', left, op: 'includes', right: [v] } : null;
      }
      return null;
    }
    default:
      return null;
  }
}

function itemOf(n: Node): CondItem | null {
  if (n.type === 'binary' && (n.op === 'and' || n.op === 'or')) {
    const join = n.op === 'and' ? 'all' : 'any';
    const leaves: Node[] = [];
    const flatten = (x: Node) => {
      if (x.type === 'binary' && x.op === n.op) {
        flatten(x.left);
        flatten(x.right);
      } else leaves.push(x);
    };
    flatten(n);
    const items = leaves.map(itemOf);
    return items.some((i) => i === null)
      ? null
      : { type: 'group', join, items: items as CondItem[] };
  }
  if (n.type === 'unary' && n.op === 'not') {
    if (n.arg.type === 'call' && n.arg.name === 'answered') {
      const r = rowOf(n.arg);
      return r ? { ...r, op: 'notAnswered' } : null;
    }
    const inner = itemOf(n.arg);
    if (!inner) return null;
    if (inner.type === 'group' && !inner.negate) return { ...inner, negate: true };
    return { type: 'group', join: 'all', negate: true, items: [inner] };
  }
  return rowOf(n);
}

/**
 * The builder's tree for an expression, or null when it uses something the builder cannot
 * show (arithmetic, other functions, literals as conditions...). The top level is always a group.
 */
export function toTree(src: string): CondGroup | null {
  if (!src.trim()) return emptyGroup();
  const parsed = tryParse(src);
  if (!parsed.ok) return null;
  const item = itemOf(parsed.node);
  if (!item) return null;
  return item.type === 'group' ? item : { type: 'group', join: 'all', items: [item] };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const span = { start: 0, end: 0 };

function operandNode(o: Operand): Node {
  switch (o.kind) {
    case 'value':
      if (typeof o.value === 'string') return { type: 'str', value: o.value, span };
      return o.value < 0
        ? { type: 'unary', op: '-', arg: { type: 'num', value: -o.value, span }, span }
        : { type: 'num', value: o.value, span };
    case 'var': {
      const dot = o.name.indexOf('.');
      if (dot < 0) return { type: 'var', name: o.name, span };
      return {
        type: 'member',
        object: { type: 'var', name: o.name.slice(0, dot), span },
        property: o.name.slice(dot + 1),
        span,
      };
    }
    case 'call':
      return { type: 'call', name: o.name, args: o.args.map(operandNode), span };
  }
}

export function operandComplete(o: Operand | undefined): boolean {
  if (!o) return false;
  if (o.kind === 'value') return o.value !== '' && !(typeof o.value === 'number' && isNaN(o.value));
  if (o.kind === 'var') return o.name.trim() !== '';
  return o.args.every(operandComplete);
}

/** True when a row has everything its operator needs. */
export function condRowComplete(r: CondRow): boolean {
  if (!operandComplete(r.left)) return false;
  switch (opArity(r.op)) {
    case 'none':
      return r.left.kind === 'var';
    case 'one':
      return operandComplete(r.right[0]);
    case 'range':
      return operandComplete(r.right[0]) && operandComplete(r.right[1]);
    case 'list':
      return r.right.length > 0 && r.right.every(operandComplete);
  }
}

function rowNode(r: CondRow): Node {
  const l = operandNode(r.left);
  const call = (name: string, args: Node[]): Node => ({ type: 'call', name, args, span });
  const rs = r.right.map(operandNode);
  switch (r.op) {
    case 'in':
    case 'notIn':
      return { type: 'in', value: l, list: rs, negated: r.op === 'notIn', span };
    case 'between':
      return { type: 'between', value: l, low: rs[0]!, high: rs[1]!, span };
    case 'answered':
      return call('answered', [l]);
    case 'notAnswered':
      return { type: 'unary', op: 'not', arg: call('answered', [l]), span };
    case 'includes':
      return call('contains', [l, rs[0]!]);
    case 'isDK':
      return call('isDK', [l]);
    case 'isRF':
      return call('isRefused', [l]);
    default:
      return { type: 'binary', op: r.op, left: l, right: rs[0]!, span };
  }
}

function itemNode(i: CondItem): Node | null {
  if (i.type === 'row') return condRowComplete(i) ? rowNode(i) : null;
  const nodes = i.items.map(itemNode).filter((n): n is Node => n !== null);
  if (nodes.length === 0) return null;
  const op = i.join === 'any' ? 'or' : 'and';
  const joined = nodes
    .slice(1)
    .reduce<Node>((acc, n) => ({ type: 'binary', op, left: acc, right: n, span }), nodes[0]!);
  return i.negate ? { type: 'unary', op: 'not', arg: joined, span } : joined;
}

/** Expression text for a builder tree; incomplete rows and empty groups are left out. */
export function fromTree(g: CondGroup): string {
  const n = itemNode(g);
  return n ? printExpr(n) : '';
}

/** Variable names (and `case.x` fields) a tree reads, in order of appearance. */
export function treeVariables(g: CondGroup): string[] {
  const out: string[] = [];
  const op = (o: Operand) => {
    if (o.kind === 'var' && !out.includes(o.name)) out.push(o.name);
    if (o.kind === 'call') o.args.forEach(op);
  };
  const walk = (i: CondItem) => {
    if (i.type === 'group') i.items.forEach(walk);
    else {
      op(i.left);
      i.right.forEach(op);
    }
  };
  walk(g);
  return out;
}
