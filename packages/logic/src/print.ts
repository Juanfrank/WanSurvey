import type { Node } from './ast.js';

/*
 * Binding strength of each node, matching the parser's precedence (lowest first):
 *   or 1 · and 2 · not 3 · comparison / in / between 4 · + - 5 · * / % 6 · unary - 7 · ^ 8 · postfix 9
 */
const BINARY_LEVEL: Record<string, number> = {
  or: 1,
  and: 2,
  '==': 4,
  '!=': 4,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 8,
};

function level(n: Node): number {
  switch (n.type) {
    case 'binary':
      return BINARY_LEVEL[n.op]!;
    case 'unary':
      return n.op === 'not' ? 3 : 7;
    case 'in':
    case 'between':
      return 4;
    case 'num':
      return n.value < 0 || Object.is(n.value, -0) ? 7 : 10;
    default:
      return 10;
  }
}

function str(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

/** Prints `n`, wrapped in brackets when it binds more loosely than `min`. */
function at(n: Node, min: number): string {
  const s = printExpr(n);
  return level(n) < min ? `(${s})` : s;
}

/**
 * Source form of an expression. Brackets are added only where precedence needs them, so
 * `parse(printExpr(ast))` gives back the same tree. Used by the visual logic builder and the
 * paper form.
 */
export function printExpr(n: Node): string {
  switch (n.type) {
    case 'num':
      return String(n.value);
    case 'str':
      return str(n.value);
    case 'bool':
      return String(n.value);
    case 'null':
      return 'null';
    case 'var':
      return n.name;
    case 'member':
      return `${at(n.object, 9)}.${n.property}`;
    case 'index':
      return `${at(n.object, 9)}[${printExpr(n.index)}]`;
    case 'call':
      return `${n.name}(${n.args.map(printExpr).join(', ')})`;
    case 'unary':
      return n.op === 'not' ? `not ${at(n.arg, 3)}` : `-${at(n.arg, 7)}`;
    case 'binary': {
      const l = BINARY_LEVEL[n.op]!;
      if (l === 4) return `${at(n.left, 5)} ${n.op} ${at(n.right, 5)}`;
      // ^ is right-associative and its base is a postfix expression.
      if (n.op === '^') return `${at(n.left, 9)} ^ ${at(n.right, 7)}`;
      return `${at(n.left, l)} ${n.op} ${at(n.right, l + 1)}`;
    }
    case 'in':
      return `${at(n.value, 5)} ${n.negated ? 'not in' : 'in'} (${n.list.map((x) => at(x, 5)).join(', ')})`;
    case 'between':
      return `${at(n.value, 5)} between ${at(n.low, 5)} and ${at(n.high, 5)}`;
  }
}
