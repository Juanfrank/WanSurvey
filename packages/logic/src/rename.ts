import { NAMESPACES } from './ast.js';
import { tokenize } from './lexer.js';
import { splitFilters } from './piping.js';
import { own } from './values.js';

const NS = new Set<string>(NAMESPACES);

/**
 * Renames variable references in an expression, token by token: `A1`, `HH.AGE`, `HH[1].AGE`
 * and `roster.HH[i].AGE` follow; strings, function names and sample fields (`case.A1`) do not.
 * Text that does not tokenize is returned unchanged.
 */
export function renameInExpression(src: string, renames: Record<string, string>): string {
  let tokens;
  try {
    tokens = tokenize(src);
  } catch {
    return src;
  }
  let out = '';
  let last = 0;
  // Inside `case.x.y`: the fields belong to the sample, not to the questionnaire.
  let inNamespace = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const prev = tokens[i - 1];
    const afterDot = prev?.type === 'punct' && prev.value === '.';
    if (t.type === 'punct' && t.value === '.') continue;
    if (t.type !== 'ident') {
      inNamespace = false;
      continue;
    }
    if (!afterDot) inNamespace = NS.has(t.value);
    if (inNamespace) continue;
    const next = tokens[i + 1];
    if (next?.type === 'punct' && next.value === '(') continue;
    const to = own(renames, t.value);
    if (to === undefined) continue;
    out += src.slice(last, t.span.start) + to;
    last = t.span.end;
  }
  return out + src.slice(last);
}

/** Renames variable references inside a text's pipes: `{{A1}}`, `{{A1 | label}}`, `{{#if A1}}`. */
export function renameInTemplate(src: string, renames: Record<string, string>): string {
  if (!src.includes('{{')) return src;
  return src.replace(/\{\{([^}]*)\}\}/g, (m, inner: string) => {
    if (inner.trim() === 'else' || inner.trim() === '/if') return m;
    const cond = /^(\s*#if\b)([\s\S]*)$/.exec(inner);
    if (cond) return `{{${cond[1]}${renameInExpression(cond[2]!, renames)}}}`;
    const [expr, ...filters] = splitFilters(inner);
    return `{{${[renameInExpression(expr!, renames), ...filters].join('|')}}}`;
  });
}
