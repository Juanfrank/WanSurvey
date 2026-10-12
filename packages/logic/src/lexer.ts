import type { Span } from './ast.js';

export type TokenType = 'num' | 'str' | 'ident' | 'keyword' | 'op' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  span: Span;
}

export class LogicSyntaxError extends Error {
  constructor(
    message: string,
    public readonly span: Span,
  ) {
    super(message);
    this.name = 'LogicSyntaxError';
  }
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'between', 'true', 'false', 'null']);
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||', '<>']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '^', '%', '<', '>', '!', '=']);
const PUNCT = new Set(['(', ')', ',', '.', '[', ']']);

/** Aliases accepted for power users coming from other tools; normalised to canonical operators. */
const ALIASES: Record<string, string> = {
  '&&': 'and',
  '||': 'or',
  '!': 'not',
  '<>': '!=',
  '=': '==',
};

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      if ((src[i] === 'e' || src[i] === 'E') && /[0-9+-]/.test(src[i + 1] ?? '')) {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      tokens.push({ type: 'num', value: src.slice(start, i), span: { start, end: i } });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      const word = src.slice(start, i);
      const lower = word.toLowerCase();
      tokens.push({
        type: KEYWORDS.has(lower) ? 'keyword' : 'ident',
        value: KEYWORDS.has(lower) ? lower : word,
        span: { start, end: i },
      });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          value += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new LogicSyntaxError('Unterminated string', { start, end: i });
      i++;
      tokens.push({ type: 'str', value, span: { start, end: i } });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      i += 2;
      const v = ALIASES[two] ?? two;
      tokens.push({
        type: v === 'and' || v === 'or' ? 'keyword' : 'op',
        value: v,
        span: { start, end: i },
      });
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      i++;
      const v = ALIASES[ch] ?? ch;
      tokens.push({ type: v === 'not' ? 'keyword' : 'op', value: v, span: { start, end: i } });
      continue;
    }
    if (PUNCT.has(ch)) {
      i++;
      tokens.push({ type: 'punct', value: ch, span: { start, end: i } });
      continue;
    }
    throw new LogicSyntaxError(`Unexpected character '${ch}'`, { start, end: start + 1 });
  }
  tokens.push({ type: 'eof', value: '', span: { start: src.length, end: src.length } });
  return tokens;
}
