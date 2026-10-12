import { NAMESPACES, type Node } from './ast.js';
import { printExpr } from './print.js';

/**
 * How conditions are phrased. The caller supplies references, labels and the translated
 * phrases (keys `paper.*`: is, isNot, compare, oneOf, notOneOf, between, includes, answered,
 * notAnswered, and, or, not, caseField, isDK, isRF).
 */
export interface DescribeContext {
  /** How a variable is referred to, e.g. "Q5" or "Age (Q5)". */
  ref(name: string): string;
  /** Label of a code for a coded variable, or null. */
  label(name: string, code: string | number): string | null;
  /** Translator for the `paper.*` phrases. */
  t(key: string, vars: Record<string, string>): string;
}

const NS = new Set<string>(NAMESPACES);
const OPS: Record<string, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' };
const FLIPPED: Record<string, string> = { '<': '>', '≤': '≥', '>': '<', '≥': '≤' };

function refOf(n: Node, ctx: DescribeContext): { text: string; name: string | null } | null {
  if (n.type === 'var' && !NS.has(n.name)) return { text: ctx.ref(n.name), name: n.name };
  if (n.type === 'member' && n.object.type === 'var' && NS.has(n.object.name)) {
    return {
      text:
        n.object.name === 'case'
          ? ctx.t('paper.caseField', { name: n.property })
          : `${n.object.name}.${n.property}`,
      name: null,
    };
  }
  // Function calls (age(DOB), count(Q4, 1)) read as their source form.
  if (n.type === 'call') return { text: printExpr(n), name: null };
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

/** The other side of a comparison: a literal (with its label) or another variable. */
function sideText(name: string | null, n: Node, ctx: DescribeContext): string | null {
  const lit = literal(n);
  if (lit !== null) return valueText(name, lit, ctx);
  return refOf(n, ctx)?.text ?? null;
}

const isJunction = (n: Node, op?: string) =>
  n.type === 'binary' && (n.op === 'and' || n.op === 'or') && (!op || n.op !== op);

/**
 * Turns a condition into plain language, e.g. `Q4 == 2` → `Q4 is “No” (2)`. Mixed and/or are
 * bracketed so the meaning is unambiguous. Anything it cannot phrase falls back to the expression.
 */
export function describeCondition(n: Node, ctx: DescribeContext): string {
  switch (n.type) {
    case 'binary': {
      if (n.op === 'and' || n.op === 'or') {
        const part = (x: Node) => {
          const s = describeCondition(x, ctx);
          return isJunction(x, n.op) ? `(${s})` : s;
        };
        return ctx.t(`paper.${n.op}`, { a: part(n.left), b: part(n.right) });
      }
      const swap = refOf(n.left, ctx) === null;
      const refNode = swap ? n.right : n.left;
      const otherNode = swap ? n.left : n.right;
      const ref = refOf(refNode, ctx);
      if (ref && otherNode.type === 'null' && (n.op === '==' || n.op === '!=')) {
        return ctx.t(n.op === '==' ? 'paper.notAnswered' : 'paper.answered', { q: ref.text });
      }
      const other = ref ? sideText(ref.name, otherNode, ctx) : null;
      if (!ref || other === null) break;
      if (n.op === '==' || n.op === '!=') {
        return ctx.t(n.op === '==' ? 'paper.is' : 'paper.isNot', { q: ref.text, value: other });
      }
      const op = OPS[n.op];
      if (!op) break;
      return ctx.t('paper.compare', { q: ref.text, op: swap ? FLIPPED[op]! : op, value: other });
    }
    case 'in': {
      const ref = refOf(n.value, ctx);
      if (!ref) break;
      const values = n.list.map((x) => sideText(ref.name, x, ctx));
      if (values.some((v) => v === null)) break;
      return ctx.t(n.negated ? 'paper.notOneOf' : 'paper.oneOf', {
        q: ref.text,
        values: values.join(', '),
      });
    }
    case 'between': {
      const ref = refOf(n.value, ctx);
      const lo = ref ? sideText(null, n.low, ctx) : null;
      const hi = ref ? sideText(null, n.high, ctx) : null;
      if (!ref || lo === null || hi === null) break;
      return ctx.t('paper.between', { q: ref.text, low: lo, high: hi });
    }
    case 'unary':
      if (n.op === 'not') {
        if (n.arg.type === 'call' && n.arg.name === 'answered' && n.arg.args[0]) {
          const ref = refOf(n.arg.args[0], ctx);
          if (ref) return ctx.t('paper.notAnswered', { q: ref.text });
        }
        return ctx.t('paper.not', { a: describeCondition(n.arg, ctx) });
      }
      break;
    case 'call': {
      const ref = n.args[0] ? refOf(n.args[0], ctx) : null;
      if (n.name === 'answered' && ref) return ctx.t('paper.answered', { q: ref.text });
      if ((n.name === 'isDK' || n.name === 'isRefused') && ref) {
        return ctx.t(n.name === 'isDK' ? 'paper.isDK' : 'paper.isRF', { q: ref.text });
      }
      if (n.name === 'contains' && ref && n.args[1]) {
        const v = sideText(ref.name, n.args[1], ctx);
        if (v !== null) return ctx.t('paper.includes', { q: ref.text, value: v });
      }
      break;
    }
    default:
      break;
  }
  return printExpr(n);
}
