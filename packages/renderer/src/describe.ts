import { NAMESPACES, type Node } from '@wansurvey/logic';

export interface DescribeContext {
  /** How a variable is referred to on paper, e.g. "Q5" (or the variable name). */
  ref(name: string): string;
  /** Label of a code for a coded variable, or null. */
  label(name: string, code: string | number): string | null;
  /** Translator for the `paper.*` phrases. */
  t(key: string, vars: Record<string, string>): string;
}

const NS = new Set<string>(NAMESPACES);
const OPS: Record<string, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' };

/** Compact source form of an expression, used when a condition has no plain-language form. */
export function printExpr(n: Node): string {
  switch (n.type) {
    case 'num':
      return String(n.value);
    case 'str':
      return JSON.stringify(n.value);
    case 'bool':
      return String(n.value);
    case 'null':
      return 'null';
    case 'var':
      return n.name;
    case 'member':
      return `${printExpr(n.object)}.${n.property}`;
    case 'index':
      return `${printExpr(n.object)}[${printExpr(n.index)}]`;
    case 'call':
      return `${n.name}(${n.args.map(printExpr).join(', ')})`;
    case 'unary':
      return n.op === 'not' ? `not ${printExpr(n.arg)}` : `-${printExpr(n.arg)}`;
    case 'binary':
      return `${printExpr(n.left)} ${n.op} ${printExpr(n.right)}`;
    case 'in':
      return `${printExpr(n.value)} ${n.negated ? 'not in' : 'in'} (${n.list.map(printExpr).join(', ')})`;
    case 'between':
      return `${printExpr(n.value)} between ${printExpr(n.low)} and ${printExpr(n.high)}`;
  }
}

function refOf(n: Node, ctx: DescribeContext): { text: string; name: string | null } | null {
  if (n.type === 'var' && !NS.has(n.name)) return { text: ctx.ref(n.name), name: n.name };
  if (n.type === 'member' && n.object.type === 'var' && n.object.name === 'case') {
    return { text: ctx.t('paper.caseField', { name: n.property }), name: null };
  }
  return null;
}

function literal(n: Node): string | number | null {
  if (n.type === 'num') return n.value;
  if (n.type === 'str') return n.value;
  if (n.type === 'unary' && n.op === '-' && n.arg.type === 'num') return -n.arg.value;
  return null;
}

function valueText(name: string | null, v: string | number, ctx: DescribeContext): string {
  const label = name ? ctx.label(name, v) : null;
  return label ? `“${label}” (${v})` : String(v);
}

/**
 * Turns a skip or display condition into a paper instruction, e.g. `Q4 == 2` → `Q4 is “No” (2)`.
 * Anything it cannot phrase falls back to the expression itself.
 */
export function describeCondition(n: Node, ctx: DescribeContext): string {
  switch (n.type) {
    case 'binary': {
      if (n.op === 'and' || n.op === 'or') {
        return ctx.t(`paper.${n.op}`, {
          a: describeCondition(n.left, ctx),
          b: describeCondition(n.right, ctx),
        });
      }
      const swap = refOf(n.left, ctx) === null;
      const refNode = swap ? n.right : n.left;
      const litNode = swap ? n.left : n.right;
      const ref = refOf(refNode, ctx);
      if (ref && litNode.type === 'null' && (n.op === '==' || n.op === '!=')) {
        return ctx.t(n.op === '==' ? 'paper.notAnswered' : 'paper.answered', { q: ref.text });
      }
      const lit = literal(litNode);
      if (!ref || lit === null) break;
      if (n.op === '==' || n.op === '!=') {
        return ctx.t(n.op === '==' ? 'paper.is' : 'paper.isNot', {
          q: ref.text,
          value: valueText(ref.name, lit, ctx),
        });
      }
      const op = OPS[n.op];
      if (!op) break;
      // `5 < Q` reads as `Q > 5`.
      const flipped: Record<string, string> = { '<': '>', '≤': '≥', '>': '<', '≥': '≤' };
      return ctx.t('paper.compare', {
        q: ref.text,
        op: swap ? flipped[op]! : op,
        value: String(lit),
      });
    }
    case 'in': {
      const ref = refOf(n.value, ctx);
      const lits = n.list.map(literal);
      if (!ref || lits.some((l) => l === null)) break;
      return ctx.t(n.negated ? 'paper.notOneOf' : 'paper.oneOf', {
        q: ref.text,
        values: lits.map((l) => valueText(ref.name, l!, ctx)).join(', '),
      });
    }
    case 'between': {
      const ref = refOf(n.value, ctx);
      const lo = literal(n.low);
      const hi = literal(n.high);
      if (!ref || lo === null || hi === null) break;
      return ctx.t('paper.between', { q: ref.text, low: String(lo), high: String(hi) });
    }
    case 'unary':
      if (n.op === 'not') return ctx.t('paper.not', { a: describeCondition(n.arg, ctx) });
      break;
    case 'call': {
      const ref = n.args[0] ? refOf(n.args[0], ctx) : null;
      if (n.name === 'answered' && ref) return ctx.t('paper.answered', { q: ref.text });
      if (n.name === 'contains' && ref && n.args[1]) {
        const lit = literal(n.args[1]);
        if (lit !== null)
          return ctx.t('paper.includes', { q: ref.text, value: valueText(ref.name, lit, ctx) });
      }
      break;
    }
    default:
      break;
  }
  return printExpr(n);
}
