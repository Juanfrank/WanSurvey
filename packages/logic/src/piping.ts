import type { Node } from './ast.js';
import { evaluate, type Scope } from './evaluator.js';
import { referencedVariable } from './functions.js';
import { LogicSyntaxError } from './lexer.js';
import { parse } from './parser.js';
import { isAnswered, isSpecial, parseIsoDate, truthy, type Value } from './values.js';

/**
 * Text piping ("fills"):
 *   {{Q3_NAME}}  {{case.city}}  {{interviewer.firstName}}  {{respondent.firstName}}
 *   {{today | date:"long"}}  {{Q7 | label}}  {{roster.HH_MEMBERS[i].NAME}}
 *   {{#if Q2 == 1}}your husband{{else}}your wife{{/if}}
 */
export interface PipeFilter {
  name: string;
  arg?: string;
}

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'expr'; src: string; expr: Node; filters: PipeFilter[] }
  | { type: 'if'; src: string; cond: Node; then: Segment[]; else: Segment[] };

export const PIPE_FILTERS = ['label', 'date', 'default'] as const;
export const DATE_STYLES = ['full', 'long', 'medium', 'short', 'iso'] as const;
type DateStyle = (typeof DATE_STYLES)[number];

export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

const cache = new Map<string, Segment[]>();

/** Parses a template (memoised). Throws TemplateError on malformed pipes. */
export function parseTemplate(src: string): Segment[] {
  const hit = cache.get(src);
  if (hit) return hit;
  const segments = new TemplateParser(src).parse();
  if (cache.size > 5000) cache.clear();
  cache.set(src, segments);
  return segments;
}

export function hasPipes(src: string): boolean {
  return src.includes('{{');
}

class TemplateParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): Segment[] {
    const { segments, stop } = this.parseUntil(new Set());
    if (stop) throw new TemplateError(`Unexpected {{${stop.tag}}}`, stop.offset);
    return segments;
  }

  private parseUntil(stops: Set<string>): {
    segments: Segment[];
    stop?: { tag: string; offset: number };
  } {
    const segments: Segment[] = [];
    while (this.pos < this.src.length) {
      const open = this.src.indexOf('{{', this.pos);
      if (open === -1) {
        segments.push({ type: 'text', value: this.src.slice(this.pos) });
        this.pos = this.src.length;
        break;
      }
      if (open > this.pos) segments.push({ type: 'text', value: this.src.slice(this.pos, open) });
      const close = this.src.indexOf('}}', open + 2);
      if (close === -1) throw new TemplateError("Unclosed '{{'", open);
      const inner = this.src.slice(open + 2, close).trim();
      this.pos = close + 2;
      if (inner === 'else' || inner === '/if') {
        if (!stops.has(inner)) throw new TemplateError(`Unexpected {{${inner}}}`, open);
        return { segments, stop: { tag: inner, offset: open } };
      }
      if (inner.startsWith('#if')) {
        const condSrc = inner.slice(3).trim();
        if (!condSrc) throw new TemplateError('{{#if}} needs a condition', open);
        const cond = this.parseExpr(condSrc, open);
        const thenPart = this.parseUntil(new Set(['else', '/if']));
        let elsePart: Segment[] = [];
        if (!thenPart.stop) throw new TemplateError('{{#if}} is missing {{/if}}', open);
        if (thenPart.stop.tag === 'else') {
          const e = this.parseUntil(new Set(['/if']));
          if (!e.stop) throw new TemplateError('{{#if}} is missing {{/if}}', open);
          elsePart = e.segments;
        }
        segments.push({ type: 'if', src: condSrc, cond, then: thenPart.segments, else: elsePart });
        continue;
      }
      if (!inner) throw new TemplateError('Empty pipe {{}}', open);
      const parts = splitFilters(inner);
      const exprSrc = parts[0]!.trim();
      const filters = parts.slice(1).map((f) => parseFilter(f.trim(), open));
      segments.push({ type: 'expr', src: exprSrc, expr: this.parseExpr(exprSrc, open), filters });
    }
    return { segments };
  }

  private parseExpr(src: string, offset: number): Node {
    try {
      return rewritePipeAst(parse(src));
    } catch (e) {
      if (e instanceof LogicSyntaxError)
        throw new TemplateError(`${e.message} in {{${src}}}`, offset);
      throw e;
    }
  }
}

/** Splits `expr | filter:"arg" | filter2` on single pipes outside quotes. */
export function splitFilters(s: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '|' && s[i + 1] !== '|' && s[i - 1] !== '|') {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function parseFilter(s: string, offset: number): PipeFilter {
  const m = /^([A-Za-z]+)\s*(?::\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+)))?$/.exec(s);
  if (!m) throw new TemplateError(`Malformed filter '${s}'`, offset);
  const name = m[1]!;
  if (!(PIPE_FILTERS as readonly string[]).includes(name))
    throw new TemplateError(`Unknown filter '${name}'`, offset);
  const arg = m[2] ?? m[3] ?? m[4];
  return arg === undefined ? { name } : { name, arg };
}

/**
 * Pipe-only sugar: `roster.R[i].X` → `R[index].X`, bare `i` → `index`, bare `today` → `today()`.
 */
function rewritePipeAst(node: Node): Node {
  switch (node.type) {
    case 'var':
      if (node.name === 'i') return { type: 'var', name: 'index', span: node.span };
      if (node.name === 'today') return { type: 'call', name: 'today', args: [], span: node.span };
      return node;
    case 'member':
      if (node.object.type === 'var' && node.object.name === 'roster') {
        return { type: 'var', name: node.property, span: node.span };
      }
      return { ...node, object: rewritePipeAst(node.object) };
    case 'index':
      return { ...node, object: rewritePipeAst(node.object), index: rewritePipeAst(node.index) };
    case 'call':
      return { ...node, args: node.args.map(rewritePipeAst) };
    case 'unary':
      return { ...node, arg: rewritePipeAst(node.arg) };
    case 'binary':
      return { ...node, left: rewritePipeAst(node.left), right: rewritePipeAst(node.right) };
    case 'in':
      return { ...node, value: rewritePipeAst(node.value), list: node.list.map(rewritePipeAst) };
    case 'between':
      return {
        ...node,
        value: rewritePipeAst(node.value),
        low: rewritePipeAst(node.low),
        high: rewritePipeAst(node.high),
      };
    default:
      return node;
  }
}

/** Filters whose argument the renderer cannot use (e.g. `date:"weird"`), for static analysis. */
export function templateFilterProblems(segments: Segment[]): string[] {
  const out: string[] = [];
  const visit = (segs: Segment[]) => {
    for (const s of segs) {
      if (s.type === 'if') {
        visit(s.then);
        visit(s.else);
      } else if (s.type === 'expr') {
        for (const f of s.filters) {
          if (
            f.name === 'date' &&
            f.arg !== undefined &&
            !(DATE_STYLES as readonly string[]).includes(f.arg)
          )
            out.push(`Unknown date style '${f.arg}' in {{${s.src}}}`);
        }
      }
    }
  };
  visit(segments);
  return out;
}

/** Every expression AST in a template, for static analysis. */
export function templateExpressions(segments: Segment[]): { src: string; node: Node }[] {
  const out: { src: string; node: Node }[] = [];
  const visit = (segs: Segment[]) => {
    for (const s of segs) {
      if (s.type === 'expr') out.push({ src: s.src, node: s.expr });
      else if (s.type === 'if') {
        out.push({ src: s.src, node: s.cond });
        visit(s.then);
        visit(s.else);
      }
    }
  };
  visit(segments);
  return out;
}

export interface RenderOptions {
  lang: string;
  /** Text for an unresolved pipe. Default: `[expr]`, visible so designers notice it. */
  placeholder?: (src: string) => string;
  /** Label for DK / Refused / NA values. */
  specialLabel?: (kind: string) => string;
}

export function renderTemplate(src: string, scope: Scope, opts: RenderOptions): string {
  if (!hasPipes(src)) return src;
  let segments: Segment[];
  try {
    segments = parseTemplate(src);
  } catch {
    return src;
  }
  return renderSegments(segments, scope, opts);
}

function renderSegments(segments: Segment[], scope: Scope, opts: RenderOptions): string {
  let out = '';
  for (const s of segments) {
    if (s.type === 'text') out += s.value;
    else if (s.type === 'if')
      out += renderSegments(truthy(evaluate(s.cond, scope)) ? s.then : s.else, scope, opts);
    else {
      const text = renderExpr(s, scope, opts);
      out += text ?? (opts.placeholder ? opts.placeholder(s.src) : `[${s.src}]`);
    }
  }
  return out;
}

function renderExpr(
  seg: Extract<Segment, { type: 'expr' }>,
  scope: Scope,
  opts: RenderOptions,
): string | null {
  let value: Value = evaluate(seg.expr, scope);
  // `| default:"su ciudad"` stands in for a value that is missing.
  const fallback = seg.filters.find((f) => f.name === 'default')?.arg;
  if (!isAnswered(value)) return fallback ?? null;
  let text: string | null = null;
  for (const f of seg.filters) {
    if (f.name === 'label') {
      const name = referencedVariable(seg.expr);
      if (!name || isSpecial(value)) continue;
      const codes = Array.isArray(value) ? value : [value];
      text = codes.map((c) => scope.label(name, c) ?? String(c)).join(', ');
    } else if (f.name === 'date') {
      const ms = parseIsoDate(value);
      if (ms === null) return null;
      const style = (f.arg ?? 'medium') as DateStyle;
      // An unknown style or language shows the value unformatted rather than breaking the text.
      try {
        text =
          style === 'iso'
            ? new Date(ms).toISOString().slice(0, 10)
            : new Intl.DateTimeFormat(opts.lang, { dateStyle: style, timeZone: 'UTC' }).format(
                new Date(ms),
              );
      } catch {
        text = formatValue(value, opts);
      }
      value = text;
    }
  }
  if (text !== null) return text;
  return formatValue(value, opts);
}

export function formatValue(value: Value, opts: RenderOptions): string {
  if (isSpecial(value))
    return opts.specialLabel ? opts.specialLabel(value.$special) : value.$special;
  if (Array.isArray(value)) return value.map((v) => formatValue(v, opts)).join(', ');
  if (value !== null && typeof value === 'object') return '';
  return String(value);
}
