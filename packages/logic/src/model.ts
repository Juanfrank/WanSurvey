import {
  SKIP_END,
  SKIP_END_ROW,
  type AnswerOption,
  type Block,
  type Computed,
  type PageBreak,
  type Question,
  type Questionnaire,
  type Roster,
  type Section,
  type StaticText,
} from '@wansurvey/schema';
import { NAMESPACES, RESERVED_IDENTIFIERS, type Node, type Span } from './ast.js';
import type { TypeTag } from './functions.js';
import { tryParse } from './parser.js';
import { own } from './values.js';

export type NodeKind =
  'section' | 'block' | 'roster' | 'question' | 'static' | 'computed' | 'pagebreak';

export type NodeDef = Section | Block | Roster | Question | StaticText | Computed | PageBreak;

/** A parsed expression with the variables it reads (normalised to their storage root). */
export interface CompiledExpr {
  src: string;
  ast: Node | null;
  error?: { message: string; span: Span };
  /** Root variables read: top-level names, or the outermost roster for roster-row variables. */
  roots: string[];
  /** Every variable name referenced (before normalisation). */
  refs: string[];
}

export type SkipTarget = number | typeof SKIP_END | typeof SKIP_END_ROW | null;

export interface CompiledNode {
  index: number;
  id: string;
  kind: NodeKind;
  parent: number | null;
  children: number[];
  /** Index of the last node in this node's subtree (== index for leaves). */
  end: number;
  /** Names of enclosing rosters, outermost first. */
  rosterChain: string[];
  name?: string;
  def: NodeDef;
  showIf?: CompiledExpr;
  prefill?: CompiledExpr;
  formula?: CompiledExpr;
  optionFilter?: CompiledExpr;
  rosterCount?: CompiledExpr;
  rowLabel?: CompiledExpr;
  minDate?: CompiledExpr;
  maxDate?: CompiledExpr;
  validations: { id: string; severity: 'error' | 'warning'; expr: CompiledExpr }[];
  skips: { to: string; target: SkipTarget; expr: CompiledExpr }[];
  endIf: { disposition: string; expr: CompiledExpr }[];
}

export interface VariableInfo {
  name: string;
  node: number;
  kind: 'question' | 'computed' | 'roster' | 'other';
  type: TypeTag;
  questionType?: Question['type'];
  rosterChain: string[];
  /** Codes of the answer set, when the variable is a coded question. */
  codes?: (string | number)[];
}

export interface Model {
  questionnaire: Questionnaire;
  nodes: CompiledNode[];
  byId: Record<string, number>;
  vars: Record<string, VariableInfo>;
  quotas: { id: string; name: string; max: number; disposition: string; expr: CompiledExpr }[];
  /** Root variable → indices of nodes whose expressions read it (the dependency graph). */
  dependents: Record<string, number[]>;
  /** Structural problems found while building (duplicate ids, names...). */
  problems: {
    code: string;
    message: string;
    itemId?: string;
    params?: Record<string, string>;
  }[];
}

const RESERVED = new Set<string>([
  ...RESERVED_IDENTIFIERS,
  'code',
  'i',
  'today',
  'roster',
  'true',
  'false',
  'null',
]);
const NS = new Set<string>(NAMESPACES);

export const YES_NO_OPTIONS: AnswerOption[] = [
  { code: 1, label: { en: 'Yes', es: 'Sí' } },
  { code: 2, label: { en: 'No', es: 'No' } },
];

/** Options of a question: inline, from a shared answer set, or Yes/No defaults. */
export function questionOptions(q: Question, questionnaire: Questionnaire): AnswerOption[] {
  if (q.options && q.options.length > 0) return q.options;
  if (q.answerSetId) return own(questionnaire.answerSets, q.answerSetId) ?? [];
  if (q.type === 'yesno') return YES_NO_OPTIONS;
  return [];
}

export function questionValueType(q: Question): TypeTag {
  switch (q.type) {
    case 'single':
    case 'yesno':
      return 'code';
    case 'multi':
    case 'ranking':
      return 'array';
    case 'numeric':
    case 'scale':
      return 'number';
    case 'text':
    case 'time':
      return 'string';
    case 'date':
    case 'datetime':
      return 'date';
    case 'grid':
      return 'any';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Walks an AST collecting referenced variable names (excluding namespaces, members and reserved words). */
export function collectRefs(node: Node, out: Set<string>): void {
  switch (node.type) {
    case 'var':
      if (!RESERVED.has(node.name) || node.name === 'i') {
        if (!NS.has(node.name)) out.add(node.name);
      }
      return;
    case 'member':
      collectRefs(node.object, out);
      return;
    case 'index':
      collectRefs(node.object, out);
      collectRefs(node.index, out);
      return;
    case 'call':
      node.args.forEach((a) => collectRefs(a, out));
      return;
    case 'unary':
      collectRefs(node.arg, out);
      return;
    case 'binary':
      collectRefs(node.left, out);
      collectRefs(node.right, out);
      return;
    case 'in':
      collectRefs(node.value, out);
      node.list.forEach((n) => collectRefs(n, out));
      return;
    case 'between':
      collectRefs(node.value, out);
      collectRefs(node.low, out);
      collectRefs(node.high, out);
      return;
    default:
      return;
  }
}

export function buildModel(questionnaire: Questionnaire): Model {
  const nodes: CompiledNode[] = [];
  const byId: Record<string, number> = {};
  const vars: Record<string, VariableInfo> = {};
  const problems: Model['problems'] = [];

  const exprs: CompiledExpr[] = [];
  const mk = (src: string): CompiledExpr => {
    const r = tryParse(src);
    const e: CompiledExpr = r.ok
      ? { src, ast: r.node, roots: [], refs: [] }
      : {
          src,
          ast: null,
          error: { message: r.error.message, span: r.error.span },
          roots: [],
          refs: [],
        };
    exprs.push(e);
    return e;
  };

  const addVar = (info: VariableInfo, itemId: string) => {
    if (RESERVED.has(info.name) || NS.has(info.name)) {
      problems.push({
        code: 'reserved_name',
        message: `'${info.name}' is a reserved word`,
        params: { name: info.name },
        itemId,
      });
    }
    if (own(vars, info.name)) {
      problems.push({
        code: 'duplicate_variable',
        message: `Variable '${info.name}' is defined twice`,
        params: { name: info.name },
        itemId,
      });
      return;
    }
    vars[info.name] = info;
  };

  const visit = (def: NodeDef, kind: NodeKind, parent: number | null, chain: string[]): number => {
    const index = nodes.length;
    if (own(byId, def.id) !== undefined) {
      problems.push({
        code: 'duplicate_id',
        message: `Item id '${def.id}' is used twice`,
        params: { name: def.id },
        itemId: def.id,
      });
    } else {
      byId[def.id] = index;
    }
    const node: CompiledNode = {
      index,
      id: def.id,
      kind,
      parent,
      children: [],
      end: index,
      rosterChain: chain,
      def,
      validations: [],
      skips: [],
      endIf: [],
    };
    nodes.push(node);
    if ('showIf' in def && def.showIf) node.showIf = mk(def.showIf);

    if (kind === 'question') {
      const q = def as Question;
      node.name = q.name;
      const options = questionOptions(q, questionnaire);
      addVar(
        {
          name: q.name,
          node: index,
          kind: 'question',
          type: questionValueType(q),
          questionType: q.type,
          rosterChain: chain,
          ...(options.length ? { codes: options.map((o) => o.code) } : {}),
        },
        q.id,
      );
      if (options.some((o) => o.otherSpecify)) {
        addVar(
          {
            name: `${q.name}_OTHER`,
            node: index,
            kind: 'other',
            type: 'string',
            rosterChain: chain,
          },
          q.id,
        );
      }
      if (q.prefill) node.prefill = mk(q.prefill);
      if (q.optionFilter) node.optionFilter = mk(q.optionFilter);
      if (q.minDate && !ISO_DATE.test(q.minDate)) node.minDate = mk(q.minDate);
      if (q.maxDate && !ISO_DATE.test(q.maxDate)) node.maxDate = mk(q.maxDate);
      for (const v of q.validations ?? [])
        node.validations.push({ id: v.id, severity: v.severity, expr: mk(v.when) });
      for (const s of q.skips ?? []) node.skips.push({ to: s.to, target: null, expr: mk(s.when) });
      for (const e of q.endIf ?? [])
        node.endIf.push({ disposition: e.disposition, expr: mk(e.when) });
    } else if (kind === 'computed') {
      const c = def as Computed;
      node.name = c.name;
      node.formula = mk(c.formula);
      addVar(
        { name: c.name, node: index, kind: 'computed', type: c.valueType, rosterChain: chain },
        c.id,
      );
    } else if (kind === 'roster') {
      const r = def as Roster;
      node.name = r.name;
      addVar(
        { name: r.name, node: index, kind: 'roster', type: 'roster', rosterChain: chain },
        r.id,
      );
      if (r.count.type === 'expression') node.rosterCount = mk(r.count.expr);
      if (r.rowLabel) node.rowLabel = mk(r.rowLabel);
    }

    const childChain = kind === 'roster' ? [...chain, (def as Roster).name] : chain;
    if (kind === 'section' || kind === 'block' || kind === 'roster') {
      for (const child of (def as Section | Block | Roster).items) {
        node.children.push(visit(child, child.kind as NodeKind, index, childChain));
      }
    }
    node.end = nodes.length - 1;
    return index;
  };

  for (const section of questionnaire.sections) visit(section, 'section', null, []);

  // Resolve skip targets.
  for (const node of nodes) {
    for (const skip of node.skips) {
      if (skip.to === SKIP_END) skip.target = SKIP_END;
      else if (skip.to === SKIP_END_ROW) skip.target = SKIP_END_ROW;
      else skip.target = own(byId, skip.to) ?? null;
    }
  }

  const quotas = questionnaire.quotas.map((q) => ({
    id: q.id,
    name: q.name,
    max: q.max,
    disposition: q.disposition,
    expr: mk(q.when),
  }));

  // Resolve references → roots.
  for (const e of exprs) {
    if (!e.ast) continue;
    const refs = new Set<string>();
    collectRefs(e.ast, refs);
    e.refs = [...refs];
    const roots = new Set<string>();
    for (const r of refs) {
      const v = own(vars, r);
      if (v) roots.add(v.rosterChain[0] ?? r);
    }
    e.roots = [...roots].sort();
  }

  // Dependency graph: variable root → nodes reading it.
  const dependents: Record<string, Set<number>> = {};
  for (const node of nodes) {
    for (const e of nodeExpressions(node)) {
      for (const r of e.expr.roots) (dependents[r] ??= new Set()).add(node.index);
    }
  }

  return {
    questionnaire,
    nodes,
    byId,
    vars,
    quotas,
    dependents: Object.fromEntries(
      Object.entries(dependents).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]),
    ),
    problems,
  };
}

/** Every expression attached to a node, labelled by field (for diagnostics). */
export function nodeExpressions(node: CompiledNode): { field: string; expr: CompiledExpr }[] {
  const out: { field: string; expr: CompiledExpr }[] = [];
  if (node.showIf) out.push({ field: 'showIf', expr: node.showIf });
  if (node.prefill) out.push({ field: 'prefill', expr: node.prefill });
  if (node.formula) out.push({ field: 'formula', expr: node.formula });
  if (node.optionFilter) out.push({ field: 'optionFilter', expr: node.optionFilter });
  if (node.rosterCount) out.push({ field: 'count', expr: node.rosterCount });
  if (node.rowLabel) out.push({ field: 'rowLabel', expr: node.rowLabel });
  if (node.minDate) out.push({ field: 'minDate', expr: node.minDate });
  if (node.maxDate) out.push({ field: 'maxDate', expr: node.maxDate });
  node.validations.forEach((v) => out.push({ field: `validations.${v.id}`, expr: v.expr }));
  node.skips.forEach((s, i) => out.push({ field: `skips[${i}]`, expr: s.expr }));
  node.endIf.forEach((s, i) => out.push({ field: `endIf[${i}]`, expr: s.expr }));
  return out;
}

export function isAncestor(nodes: CompiledNode[], ancestor: number, descendant: number): boolean {
  const a = nodes[ancestor]!;
  return descendant > ancestor && descendant <= a.end;
}
