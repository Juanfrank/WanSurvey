import type { Node } from './ast.js';
import { tryParse } from './parser.js';
import { hasPipes, parseTemplate, templateExpressions } from './piping.js';

/** The sample columns behind `respondent.*` (see `respondentFromCase`). */
const RESPONDENT_FIELDS: Record<string, string[]> = {
  firstName: ['first_name', 'nombre'],
  lastName: ['last_name', 'apellido'],
};

/** What a questionnaire reads of the case's sample data. */
export interface CaseFieldsUsed {
  /** The sample columns read by name (`case.first_name`, and those behind `respondent.*`). */
  fields: string[];
  /**
   * The case or the respondent read as a whole (`case` or `respondent` alone, or by a computed
   * index): what it reads cannot be told, so every field counts as used.
   */
  all: boolean;
}

const MENTION = /\b(case|respondent)\b/;
const AST_TYPES = new Set<string>([
  'num',
  'str',
  'bool',
  'null',
  'var',
  'member',
  'index',
  'call',
  'unary',
  'binary',
  'in',
  'between',
]);

/**
 * The case fields a questionnaire uses: in a text (`{{case.first_name}}`, `{{respondent.firstName}}`,
 * also in an `{{#if}}`), in an expression (filters, prefills `case.region`, validations, quotas,
 * scripts) or anywhere else in the definition. It reads the questionnaire as stored: every
 * string that mentions `case` or `respondent` is read as a template when it has pipes, else as
 * an expression; compiled syntax trees are walked as they are. What cannot be read (prose) is
 * skipped. Used to send an interviewer only the personal fields the questionnaire shows.
 */
export function caseFieldsUsed(definition: unknown): CaseFieldsUsed {
  const fields = new Set<string>();
  let all = false;
  const field = (ns: string, name: string) => {
    if (ns === 'case') fields.add(name);
    else if (RESPONDENT_FIELDS[name]) RESPONDENT_FIELDS[name]!.forEach((f) => fields.add(f));
  };
  const isNs = (n: Node | undefined): n is Extract<Node, { type: 'var' }> =>
    !!n && n.type === 'var' && (n.name === 'case' || n.name === 'respondent');
  /** A syntax tree (parsed here, or compiled in the definition). */
  const walk = (n: Node | undefined): void => {
    if (!n || typeof n !== 'object') return;
    switch (n.type) {
      case 'var':
        if (isNs(n)) all = true;
        return;
      case 'member':
        if (isNs(n.object)) field(n.object.name, n.property);
        else walk(n.object);
        return;
      case 'index':
        if (isNs(n.object) && n.index.type === 'str') field(n.object.name, n.index.value);
        else {
          walk(n.object);
          walk(n.index);
        }
        return;
      case 'call':
        n.args.forEach(walk);
        return;
      case 'unary':
        walk(n.arg);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'in':
        walk(n.value);
        n.list.forEach(walk);
        return;
      case 'between':
        walk(n.value);
        walk(n.low);
        walk(n.high);
        return;
      default:
        return;
    }
  };
  const text = (s: string) => {
    if (!MENTION.test(s)) return;
    if (hasPipes(s)) {
      try {
        for (const e of templateExpressions(parseTemplate(s))) walk(e.node);
      } catch {
        // Not a valid template: the designer reports it; nothing is read from it here.
      }
      return;
    }
    // A bare word ("case", "respondent": a name or a label) reads nothing as an expression.
    const parsed = tryParse(s);
    if (parsed.ok && parsed.node.type !== 'var') walk(parsed.node);
  };
  /** A node of a compiled syntax tree: walked whole, not visited field by field. */
  const isAst = (v: Record<string, unknown>) =>
    typeof v.type === 'string' && AST_TYPES.has(v.type) && !!v.span && typeof v.span === 'object';
  const visit = (v: unknown): void => {
    if (typeof v === 'string') text(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (isAst(o)) walk(o as unknown as Node);
      else Object.values(o).forEach(visit);
    }
  };
  visit(definition);
  return { fields: [...fields].sort(), all };
}
