import { FUNCTIONS } from '@wansurvey/logic';
import type { VarOption } from './vars.js';

export type SuggestionKind =
  'question' | 'computed' | 'roster' | 'case' | 'context' | 'function' | 'keyword';

/** One entry of the drop-down offered while an expression is typed. */
export interface Suggestion {
  /** What is shown and matched. */
  label: string;
  /** What replaces the word being typed. */
  insert: string;
  kind: SuggestionKind;
  /** A line of help: the question's text, what a function does. */
  detail?: string;
  /** Characters to move the cursor back after inserting (into the brackets of a function). */
  back?: number;
}

const KEYWORDS = ['and', 'or', 'not', 'in', 'between', 'true', 'false', 'null'];
const CONTEXT = [
  'mode',
  'index',
  'interviewer.firstName',
  'interviewer.name',
  'respondent.firstName',
  'respondent.name',
];

/**
 * Everything an expression may mention: the questionnaire's variables, the sample fields as
 * `case.x`, the context names, the functions of the language and its keywords.
 * `extra` adds names that exist only in some places (`code` in an option filter).
 */
export function expressionSuggestions(
  variables: VarOption[],
  extra: string[] = [],
  opts: { functions?: boolean } = {},
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const v of variables)
    out.push({
      label: v.name,
      insert: v.name,
      kind: v.kind,
      ...(v.text ? { detail: v.text } : {}),
    });
  for (const n of extra) out.push({ label: n, insert: n, kind: 'context' });
  for (const n of CONTEXT) out.push({ label: n, insert: n, kind: 'context' });
  if (opts.functions !== false)
    for (const [name, def] of Object.entries(FUNCTIONS))
      out.push({ label: name, insert: `${name}()`, kind: 'function', detail: def.doc, back: 1 });
  for (const k of KEYWORDS) out.push({ label: k, insert: k, kind: 'keyword' });
  return out;
}

/** The sample fields of a file as `case.x`, with the functions and keywords, for rules at load. */
export function fieldSuggestions(fields: string[]): Suggestion[] {
  return [
    ...fields.map((f) => ({ label: `case.${f}`, insert: `case.${f}`, kind: 'case' as const })),
    ...expressionSuggestions([], [], {}).filter(
      (s) => s.kind === 'function' || s.kind === 'keyword',
    ),
  ];
}

export interface Token {
  start: number;
  end: number;
  text: string;
}

/** Whether the position falls inside a quoted text, where nothing is suggested. */
function inString(text: string, at: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < at; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
  }
  return quote !== null;
}

/**
 * The word being typed at the cursor (letters, digits, `_` and `.`), or null inside a text or
 * when the word would start with a digit (a number).
 */
export function tokenAt(text: string, caret: number): Token | null {
  if (inString(text, caret)) return null;
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1]!)) start--;
  const word = text.slice(start, caret);
  if (/^[0-9.]/.test(word)) return null;
  return { start, end: caret, text: word };
}

/** The entries that fit what was typed: those that start with it first, then those that hold it. */
export function rank(items: Suggestion[], typed: string, limit = 8): Suggestion[] {
  const t = typed.toLowerCase();
  if (!t) return items.slice(0, limit);
  const starts: Suggestion[] = [];
  const holds: Suggestion[] = [];
  for (const s of items) {
    const l = s.label.toLowerCase();
    if (l === t) continue;
    if (l.startsWith(t)) starts.push(s);
    else if (l.includes(t) || l.split('.').some((p) => p.startsWith(t))) holds.push(s);
  }
  return [...starts, ...holds].slice(0, limit);
}

/** The text and cursor after taking a suggestion in place of the word being typed. */
export function applySuggestion(
  text: string,
  token: Token,
  s: Suggestion,
): { text: string; caret: number } {
  const next = text.slice(0, token.start) + s.insert + text.slice(token.end);
  return { text: next, caret: token.start + s.insert.length - (s.back ?? 0) };
}
