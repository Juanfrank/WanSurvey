import { NAMESPACES, type Node } from './ast.js';
import { tryParse } from './parser.js';
import { printExpr } from './print.js';

export type Literal = string | number;

/** Operators the visual builder offers. */
export const CONDITION_OPS = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'notIn',
  'between',
  'answered',
  'notAnswered',
  'includes',
  'isDK',
  'isRF',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** How many values an operator takes: one, a list, a low/high pair, or none. */
export function opArity(op: ConditionOp): 'one' | 'list' | 'range' | 'none' {
  switch (op) {
    case 'in':
    case 'notIn':
      return 'list';
    case 'between':
      return 'range';
    case 'answered':
    case 'notAnswered':
    case 'isDK':
    case 'isRF':
      return 'none';
    default:
      return 'one';
  }
}

export interface ConditionRow {
  /** A variable (`Q5`) or a namespaced field (`case.region`). */
  left: string;
  op: ConditionOp;
  values: Literal[];
}

export interface ConditionRows {
  join: 'all' | 'any';
  rows: ConditionRow[];
}

const NS = new Set<string>(NAMESPACES);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const FLIP: Record<string, ConditionOp> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

function operand(n: Node): string | null {
  if (n.type === 'var' && !NS.has(n.name)) return n.name;
  if (n.type === 'member' && n.object.type === 'var' && NS.has(n.object.name)) {
    return `${n.object.name}.${n.property}`;
  }
  return null;
}

function literal(n: Node): Literal | null {
  if (n.type === 'num') return n.value;
  if (n.type === 'str') return n.value;
  if (n.type === 'unary' && n.op === '-' && n.arg.type === 'num') return -n.arg.value;
  return null;
}

function rowOf(n: Node): ConditionRow | null {
  switch (n.type) {
    case 'binary': {
      if (!COMPARE.has(n.op)) return null;
      let left = operand(n.left);
      let value = literal(n.right);
      let op = n.op as ConditionOp;
      if (left === null) {
        // `18 <= Q5` reads as `Q5 >= 18`.
        left = operand(n.right);
        value = literal(n.left);
        op = FLIP[n.op] ?? op;
      }
      if (left === null || value === null) return null;
      return { left, op, values: [value] };
    }
    case 'in': {
      const left = operand(n.value);
      const values = n.list.map(literal);
      if (left === null || values.some((v) => v === null)) return null;
      return { left, op: n.negated ? 'notIn' : 'in', values: values as Literal[] };
    }
    case 'between': {
      const left = operand(n.value);
      const lo = literal(n.low);
      const hi = literal(n.high);
      if (left === null || lo === null || hi === null) return null;
      return { left, op: 'between', values: [lo, hi] };
    }
    case 'call': {
      const left = n.args[0] ? operand(n.args[0]) : null;
      if (left === null) return null;
      if (n.args.length === 1) {
        const op = ({ answered: 'answered', isDK: 'isDK', isRefused: 'isRF' } as const)[
          n.name as 'answered' | 'isDK' | 'isRefused'
        ];
        return op ? { left, op, values: [] } : null;
      }
      if (n.name === 'contains' && n.args.length === 2) {
        const v = literal(n.args[1]!);
        return v === null ? null : { left, op: 'includes', values: [v] };
      }
      return null;
    }
    case 'unary':
      if (n.op === 'not' && n.arg.type === 'call' && n.arg.name === 'answered') {
        const r = rowOf(n.arg);
        return r ? { ...r, op: 'notAnswered' } : null;
      }
      return null;
    default:
      return null;
  }
}

function flatten(n: Node, op: 'and' | 'or', out: Node[]): void {
  if (n.type === 'binary' && n.op === op) {
    flatten(n.left, op, out);
    flatten(n.right, op, out);
  } else out.push(n);
}

/**
 * Builder rows for an expression, or null when it does not fit the builder (nested and/or,
 * arithmetic, functions other than answered/contains/isDK/isRefused...). The UI then shows the
 * expression editor instead.
 */
export function toRows(src: string): ConditionRows | null {
  const parsed = tryParse(src);
  if (!parsed.ok) return null;
  const node = parsed.node;
  const join = node.type === 'binary' && node.op === 'or' ? 'any' : 'all';
  const leaves: Node[] = [];
  flatten(node, join === 'any' ? 'or' : 'and', leaves);
  const rows: ConditionRow[] = [];
  for (const leaf of leaves) {
    const row = rowOf(leaf);
    if (!row) return null;
    rows.push(row);
  }
  return { join, rows };
}

const span = { start: 0, end: 0 };

function lit(v: Literal): Node {
  if (typeof v === 'string') return { type: 'str', value: v, span };
  if (v < 0) return { type: 'unary', op: '-', arg: { type: 'num', value: -v, span }, span };
  return { type: 'num', value: v, span };
}

function ref(left: string): Node {
  const dot = left.indexOf('.');
  if (dot < 0) return { type: 'var', name: left, span };
  return {
    type: 'member',
    object: { type: 'var', name: left.slice(0, dot), span },
    property: left.slice(dot + 1),
    span,
  };
}

function rowNode(r: ConditionRow): Node {
  const l = ref(r.left);
  const call = (name: string, args: Node[]): Node => ({ type: 'call', name, args, span });
  switch (r.op) {
    case 'in':
    case 'notIn':
      return { type: 'in', value: l, list: r.values.map(lit), negated: r.op === 'notIn', span };
    case 'between':
      return { type: 'between', value: l, low: lit(r.values[0]!), high: lit(r.values[1]!), span };
    case 'answered':
      return call('answered', [l]);
    case 'notAnswered':
      return { type: 'unary', op: 'not', arg: call('answered', [l]), span };
    case 'includes':
      return call('contains', [l, lit(r.values[0]!)]);
    case 'isDK':
      return call('isDK', [l]);
    case 'isRF':
      return call('isRefused', [l]);
    default:
      return { type: 'binary', op: r.op, left: l, right: lit(r.values[0]!), span };
  }
}

/** True when every row has the values its operator needs. */
export function rowComplete(r: ConditionRow): boolean {
  if (!r.left) return false;
  switch (opArity(r.op)) {
    case 'none':
      return true;
    case 'one':
      return r.values.length >= 1;
    case 'range':
      return r.values.length >= 2;
    case 'list':
      return r.values.length >= 1;
  }
}

/** Expression text for builder rows; empty string when there are no complete rows. */
export function fromRows(c: ConditionRows): string {
  const nodes = c.rows.filter(rowComplete).map(rowNode);
  if (nodes.length === 0) return '';
  const op = c.join === 'any' ? 'or' : 'and';
  const tree = nodes
    .slice(1)
    .reduce<Node>((acc, n) => ({ type: 'binary', op, left: acc, right: n, span }), nodes[0]!);
  return printExpr(tree);
}
