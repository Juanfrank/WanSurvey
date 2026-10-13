import {
  MODES,
  SKIP_END,
  SKIP_END_ROW,
  type LocalizedText,
  type Question,
  type Questionnaire,
  type Roster,
  type Script,
} from '@wansurvey/schema';
import type { Node, Span } from './ast.js';
import { evaluate, type Scope } from './evaluator.js';
import {
  buildModel,
  isAncestor,
  nodeExpressions,
  questionOptions,
  type CompiledExpr,
  type CompiledNode,
  type Model,
} from './model.js';
import { parseTemplate, TemplateError, templateExpressions, hasPipes } from './piping.js';
import { typecheck, type MessageRef, type StaticType } from './typecheck.js';
import { own, truthy } from './values.js';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  /** English text; `msg` identifies the translatable message. */
  message: string;
  msg?: MessageRef;
  itemId?: string;
  field?: string;
  span?: Span;
}

export interface AnalysisResult {
  model: Model;
  diagnostics: Diagnostic[];
  canPublish: boolean;
}

/** Publish-time static analysis. Publishing is blocked when any diagnostic is an error. */
export function analyze(questionnaire: Questionnaire): AnalysisResult {
  const model = buildModel(questionnaire);
  const diagnostics: Diagnostic[] = [];
  const add = (d: Diagnostic) => diagnostics.push(d);

  for (const p of model.problems)
    add({
      severity: 'error',
      code: p.code,
      message: p.message,
      msg: { id: p.code, params: p.params ?? {} },
      itemId: p.itemId,
    });

  const specialCodes = Object.values(questionnaire.settings.specialCodes).map((s) => s.code);

  for (const node of model.nodes) {
    checkExpressions(model, node, specialCodes, add);
    checkSkips(model, node, add);
    if (node.kind === 'question') checkQuestion(model, node, specialCodes, add);
    if (node.kind === 'roster') checkRoster(node, add);
    checkVariants(node, questionnaire.modes, add);
    checkTexts(model, node, specialCodes, add);
  }
  checkUnreachable(model, add);
  checkComputedCycles(model, add);
  checkQuotas(model, specialCodes, add);
  checkScripts(model, specialCodes, add);

  return { model, diagnostics, canPublish: !diagnostics.some((d) => d.severity === 'error') };
}

// ---------------------------------------------------------------------------

/** Which nodes may an expression attached to `node` read? Earlier ones (and its own answer for checks). */
function checkForwardRefs(
  model: Model,
  node: CompiledNode,
  field: string,
  refs: string[],
  allowSelf: boolean,
  add: (d: Diagnostic) => void,
  code = 'forward_reference',
) {
  for (const ref of refs) {
    const v = own(model.vars, ref);
    if (!v) continue;
    const ownSubtree = field === 'rowLabel' && v.node > node.index && v.node <= node.end;
    if (v.node < node.index || ownSubtree) continue;
    if (v.node === node.index) {
      if (allowSelf) continue;
      if (node.kind === 'computed' && field === 'formula') {
        add({
          severity: 'error',
          code: 'computed_cycle',
          message: `Computed variable ${ref} refers to itself`,
          msg: { id: 'self_reference', params: { name: ref } },
          itemId: node.id,
          field,
        });
        continue;
      }
    }
    add({
      severity: 'error',
      code,
      message:
        code === 'missing_pipe'
          ? `Pipe {{${ref}}} refers to a question that is asked later, so it would be empty here`
          : `${field} refers to ${ref}, which is asked later (forward reference)`,
      msg: {
        id: code === 'missing_pipe' ? 'pipe_later' : 'forward_reference',
        params: { name: ref },
      },
      itemId: node.id,
      field,
    });
  }
}

const SELF_FIELDS = /^(validations\.|skips\[|endIf\[)/;

function exprChain(node: CompiledNode, field: string): string[] {
  return node.kind === 'roster' && field === 'rowLabel'
    ? [...node.rosterChain, node.name!]
    : node.rosterChain;
}

function checkExpressions(
  model: Model,
  node: CompiledNode,
  specialCodes: (string | number)[],
  add: (d: Diagnostic) => void,
) {
  for (const { field, expr } of nodeExpressions(node)) {
    if (!expr.ast) {
      add({
        severity: 'error',
        code: 'syntax',
        message: expr.error!.message,
        msg: { id: 'syntax', params: { at: expr.error!.span.start + 1 } },
        itemId: node.id,
        field,
        span: expr.error!.span,
      });
      continue;
    }
    const { type, issues } = typecheck(expr.ast, {
      vars: model.vars,
      rosterChain: exprChain(node, field),
      codeBound: field === 'optionFilter',
      specialCodes,
    });
    for (const i of issues) add({ ...i, itemId: node.id, field });
    checkForwardRefs(model, node, field, expr.refs, SELF_FIELDS.test(field), add);

    if (field === 'count' && !['number', 'any', 'code'].includes(type.t)) {
      add({
        severity: 'error',
        code: 'type_mismatch',
        message: 'Roster count must be a number',
        msg: { id: 'roster_count_number' },
        itemId: node.id,
        field,
      });
    }
    if (field === 'formula' && node.kind === 'computed') {
      const declared = (node.def as { valueType: string }).valueType;
      if (!compatible(declared, type)) {
        add({
          severity: 'warning',
          code: 'type_mismatch',
          message: `Formula returns ${type.t} but ${node.name} is declared as ${declared}`,
          msg: { id: 'formula_type', params: { got: type.t, name: node.name!, declared } },
          itemId: node.id,
          field,
        });
      }
    }
  }
}

function compatible(declared: string, t: StaticType): boolean {
  if (t.t === 'any' || t.t === 'null') return true;
  if (declared === t.t) return true;
  if ((declared === 'code' || declared === 'number') && (t.t === 'number' || t.t === 'code'))
    return true;
  if ((declared === 'date' || declared === 'string') && (t.t === 'date' || t.t === 'string'))
    return true;
  return false;
}

function checkSkips(model: Model, node: CompiledNode, add: (d: Diagnostic) => void) {
  node.skips.forEach((skip, i) => {
    const field = `skips[${i}]`;
    if (skip.target === null) {
      add({
        severity: 'error',
        code: 'unknown_skip_target',
        message: `Skip target '${skip.to}' does not exist`,
        msg: { id: 'unknown_skip_target', params: { target: skip.to } },
        itemId: node.id,
        field,
      });
      return;
    }
    if (skip.target === SKIP_END) return;
    if (skip.target === SKIP_END_ROW) {
      if (node.rosterChain.length === 0) {
        add({
          severity: 'error',
          code: 'skip_scope',
          message: 'END_ROW can only be used inside a roster',
          msg: { id: 'end_row_outside' },
          itemId: node.id,
          field,
        });
      }
      return;
    }
    const target = model.nodes[skip.target]!;
    if (target.index <= node.index || isAncestor(model.nodes, target.index, node.index)) {
      add({
        severity: 'error',
        code: 'backward_skip',
        message: `Skip to ${target.id} goes backwards`,
        msg: { id: 'backward_skip', params: { target: target.id } },
        itemId: node.id,
        field,
      });
      return;
    }
    if (target.rosterChain.join('.') !== node.rosterChain.join('.')) {
      add({
        severity: 'error',
        code: 'skip_scope',
        message: `Skip to ${target.id} crosses a roster boundary; use END_ROW to finish the current row`,
        msg: { id: 'skip_crosses_roster', params: { target: target.id } },
        itemId: node.id,
        field,
      });
    }
  });
}

function checkQuestion(
  model: Model,
  node: CompiledNode,
  specialCodes: (string | number)[],
  add: (d: Diagnostic) => void,
) {
  const q = node.def as Question;
  const err = (
    code: string,
    message: string,
    field?: string,
    params: Record<string, string | number> = {},
  ) =>
    add({
      severity: 'error',
      code,
      message,
      msg: { id: code, params: { name: q.name, ...params } },
      itemId: node.id,
      ...(field ? { field } : {}),
    });
  const options = questionOptions(q, model.questionnaire);
  const coded = ['single', 'multi', 'grid', 'ranking'].includes(q.type);
  if (q.answerSetId && !own(model.questionnaire.answerSets, q.answerSetId)) {
    err('unknown_answer_set', `Answer set '${q.answerSetId}' does not exist`, 'answerSetId', {
      set: q.answerSetId,
    });
  }
  if (coded && options.length === 0)
    err('missing_options', `${q.name} has no answer options`, 'options');
  const seen = new Set<string>();
  for (const o of options) {
    const k = String(o.code);
    if (seen.has(k))
      err('duplicate_code', `Code ${k} appears twice in ${q.name}`, 'options', { code: k });
    seen.add(k);
    if (specialCodes.some((c) => String(c) === k)) {
      err(
        'special_code_clash',
        `Code ${k} in ${q.name} clashes with a special code (DK/Refused/NA)`,
        'options',
        { code: k },
      );
    }
  }
  if (q.type === 'grid' && (!q.rows || q.rows.length === 0))
    err('missing_rows', `Grid ${q.name} has no rows`, 'rows');
  if (q.min !== undefined && q.max !== undefined && q.min > q.max)
    err('invalid_range', `min is greater than max in ${q.name}`, 'min');
  if (q.scale && q.scale.min >= q.scale.max)
    err('invalid_scale', `Scale min must be below max in ${q.name}`, 'scale');
  if (
    q.minSelections !== undefined &&
    q.maxSelections !== undefined &&
    q.minSelections > q.maxSelections
  ) {
    err(
      'invalid_selections',
      `minSelections is greater than maxSelections in ${q.name}`,
      'minSelections',
    );
  }
  if (q.pattern !== undefined) {
    try {
      new RegExp(q.pattern);
    } catch {
      err('invalid_pattern', `Pattern of ${q.name} is not a valid regular expression`, 'pattern');
    }
  }
  if (q.optionFilter && !coded && q.type !== 'yesno') {
    err('invalid_option_filter', 'Option filters only apply to choice questions', 'optionFilter');
  }
}

function checkRoster(node: CompiledNode, add: (d: Diagnostic) => void) {
  const r = node.def as Roster;
  if (r.items.length === 0)
    add({
      severity: 'warning',
      code: 'empty_container',
      message: `Roster ${r.name} has no items`,
      msg: { id: 'empty_roster', params: { name: r.name } },
      itemId: r.id,
    });
}

function checkVariants(node: CompiledNode, modes: readonly string[], add: (d: Diagnostic) => void) {
  const def = node.def as { variants?: Partial<Record<string, { visibleInMode?: boolean }>> };
  if (!def.variants) return;
  // Wording for a mode the questionnaire is not fielded in is never shown (Q1).
  for (const m of Object.keys(def.variants))
    if (!modes.includes(m))
      add({
        severity: 'warning',
        code: 'variant_unused_mode',
        message: `${node.id} has wording for ${m}, which this questionnaire does not use`,
        msg: { id: 'variant_unused_mode', params: { name: node.id, mode: m } },
        itemId: node.id,
      });
  const hiddenEverywhere = (modes.length ? modes : MODES).every(
    (m) => def.variants?.[m]?.visibleInMode === false,
  );
  if (hiddenEverywhere) {
    add({
      severity: 'warning',
      code: 'hidden_in_all_modes',
      message: `${node.id} is hidden in every mode`,
      msg: { id: 'hidden_in_all_modes', params: { name: node.id } },
      itemId: node.id,
    });
  }
}

// --- texts and pipes ---------------------------------------------------------

function nodeTexts(
  node: CompiledNode,
): { field: string; text: LocalizedText; allowSelf: boolean }[] {
  const out: { field: string; text: LocalizedText; allowSelf: boolean }[] = [];
  const def = node.def as {
    text?: LocalizedText;
    title?: LocalizedText;
    variants?: Record<
      string,
      | { text?: LocalizedText; interviewerInstruction?: LocalizedText; helpText?: LocalizedText }
      | undefined
    >;
  };
  if (node.kind === 'question' || node.kind === 'static')
    out.push({ field: 'text', text: def.text!, allowSelf: false });
  if ((node.kind === 'section' || node.kind === 'block' || node.kind === 'roster') && def.title) {
    out.push({ field: 'title', text: def.title, allowSelf: false });
  }
  for (const [mode, v] of Object.entries(def.variants ?? {})) {
    if (!v) continue;
    if (v.text) out.push({ field: `variants.${mode}.text`, text: v.text, allowSelf: false });
    if (v.interviewerInstruction)
      out.push({
        field: `variants.${mode}.interviewerInstruction`,
        text: v.interviewerInstruction,
        allowSelf: false,
      });
    if (v.helpText)
      out.push({ field: `variants.${mode}.helpText`, text: v.helpText, allowSelf: false });
  }
  if (node.kind === 'question') {
    const q = node.def as Question;
    (q.options ?? []).forEach((o, i) =>
      out.push({ field: `options[${i}].label`, text: o.label, allowSelf: false }),
    );
    (q.validations ?? []).forEach((v) =>
      out.push({ field: `validations.${v.id}.message`, text: v.message, allowSelf: true }),
    );
  }
  return out;
}

function checkTemplate(
  model: Model,
  node: CompiledNode,
  field: string,
  text: LocalizedText,
  allowSelf: boolean,
  chain: string[],
  specialCodes: (string | number)[],
  add: (d: Diagnostic) => void,
) {
  for (const [lang, src] of Object.entries(text)) {
    if (!hasPipes(src)) continue;
    let exprs: { src: string; node: Node }[];
    try {
      exprs = templateExpressions(parseTemplate(src));
    } catch (e) {
      if (e instanceof TemplateError) {
        add({
          severity: 'error',
          code: 'pipe_syntax',
          message: `${e.message} (${lang})`,
          msg: { id: 'pipe_syntax', params: { lang } },
          itemId: node.id,
          field,
        });
        continue;
      }
      throw e;
    }
    for (const e of exprs) {
      const { issues } = typecheck(e.node, { vars: model.vars, rosterChain: chain, specialCodes });
      for (const i of issues) {
        add({
          ...i,
          code: i.code === 'unknown_variable' ? 'missing_pipe' : i.code,
          message: i.code === 'unknown_variable' ? `Pipe {{${e.src}}}: ${i.message}` : i.message,
          ...(i.code === 'unknown_variable'
            ? { msg: { id: 'missing_pipe', params: { pipe: e.src } } }
            : {}),
          itemId: node.id,
          field,
        });
      }
      const refs = new Set<string>();
      collectExprRefs(e.node, refs);
      checkForwardRefs(model, node, field, [...refs], allowSelf, add, 'missing_pipe');
    }
  }
}

function collectExprRefs(node: Node, out: Set<string>) {
  const stack: Node[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    switch (n.type) {
      case 'var':
        out.add(n.name);
        break;
      case 'member':
        stack.push(n.object);
        break;
      case 'index':
        stack.push(n.object, n.index);
        break;
      case 'call':
        stack.push(...n.args);
        break;
      case 'unary':
        stack.push(n.arg);
        break;
      case 'binary':
        stack.push(n.left, n.right);
        break;
      case 'in':
        stack.push(n.value, ...n.list);
        break;
      case 'between':
        stack.push(n.value, n.low, n.high);
        break;
    }
  }
}

function checkTexts(
  model: Model,
  node: CompiledNode,
  specialCodes: (string | number)[],
  add: (d: Diagnostic) => void,
) {
  const languages = model.questionnaire.languages;
  for (const { field, text, allowSelf } of nodeTexts(node)) {
    const chain = node.kind === 'roster' ? [...node.rosterChain, node.name!] : node.rosterChain;
    checkTemplate(model, node, field, text, allowSelf, chain, specialCodes, add);
    if (field === 'text' || field === 'title') {
      const missing = languages.filter((l) => !text[l]);
      if (missing.length) {
        add({
          severity: 'error',
          code: 'missing_translation',
          message: `Missing ${missing.join(', ')} translation`,
          msg: { id: 'missing_translation', params: { langs: missing.join(', ') } },
          itemId: node.id,
          field,
        });
      }
    }
  }
}

function checkScripts(
  model: Model,
  specialCodes: (string | number)[],
  add: (d: Diagnostic) => void,
) {
  for (const script of model.questionnaire.scripts) {
    if (!script.modes.some((m) => model.questionnaire.modes.includes(m)))
      add({
        severity: 'warning',
        code: 'script_unused_mode',
        message: `Script ${script.id} is for modes this questionnaire does not use`,
        msg: { id: 'script_unused_mode', params: { name: script.id } },
        field: `scripts.${script.id}`,
      });
    const anchorIndex = scriptAnchorIndex(model, script);
    if (anchorIndex === null) {
      add({
        severity: 'error',
        code: 'unknown_script_anchor',
        message: `Script ${script.id} is attached to an unknown item`,
        msg: { id: 'unknown_script_anchor', params: { name: script.id } },
        field: `scripts.${script.id}`,
      });
      continue;
    }
    // Pseudo-node positioned where the script is shown.
    const pseudo: CompiledNode = {
      index: anchorIndex,
      id: `script:${script.id}`,
      kind: 'static',
      parent: null,
      children: [],
      end: anchorIndex,
      rosterChain:
        anchorIndex < model.nodes.length ? (model.nodes[anchorIndex]?.rosterChain ?? []) : [],
      def: { id: script.id, kind: 'static', text: script.body },
      validations: [],
      skips: [],
      endIf: [],
    };
    checkTemplate(model, pseudo, 'body', script.body, false, pseudo.rosterChain, specialCodes, add);
  }
}

function scriptAnchorIndex(model: Model, script: Script): number | null {
  switch (script.anchor.at) {
    case 'start':
    case 'callOutcome':
      return 0;
    case 'end':
      return model.nodes.length;
    case 'section':
      return own(model.byId, script.anchor.sectionId) ?? null;
    case 'item':
      return own(model.byId, script.anchor.itemId) ?? null;
  }
}

// --- unreachable items -------------------------------------------------------

const NO_SCOPE: Scope = {
  get: () => undefined,
  namespace: () => undefined,
  rowIndex: () => null,
  rowScope: () => null,
  label: () => null,
  mode: null,
  today: '1970-01-01',
};

function hasDynamicParts(node: Node): boolean {
  switch (node.type) {
    case 'var':
      return true;
    case 'call':
      return node.name === 'today' || node.args.some(hasDynamicParts);
    case 'member':
      return true;
    case 'index':
      return true;
    case 'unary':
      return hasDynamicParts(node.arg);
    case 'binary':
      return hasDynamicParts(node.left) || hasDynamicParts(node.right);
    case 'in':
      return hasDynamicParts(node.value) || node.list.some(hasDynamicParts);
    case 'between':
      return hasDynamicParts(node.value) || hasDynamicParts(node.low) || hasDynamicParts(node.high);
    default:
      return false;
  }
}

/** Constant-folds an expression; returns undefined when it depends on answers or context. */
function constantTruth(expr: CompiledExpr | undefined): boolean | undefined {
  if (!expr?.ast || hasDynamicParts(expr.ast)) return undefined;
  return truthy(evaluate(expr.ast, NO_SCOPE));
}

function checkUnreachable(model: Model, add: (d: Diagnostic) => void) {
  const unreachable = new Set<number>();
  const markRange = (from: number, toExclusive: number, chain: string) => {
    for (let i = from; i < toExclusive; i++) {
      if (
        model.nodes[i]!.rosterChain.join('.') === chain ||
        model.nodes[i]!.rosterChain.join('.').startsWith(chain + '.') ||
        chain === ''
      ) {
        unreachable.add(i);
      }
    }
  };
  for (const node of model.nodes) {
    if (constantTruth(node.showIf) === false) {
      for (let i = node.index; i <= node.end; i++) unreachable.add(i);
    }
    const chain = node.rosterChain.join('.');
    const scopeEnd = (() => {
      if (node.rosterChain.length === 0) return model.nodes.length;
      // end of the innermost enclosing roster
      let p = node.parent;
      while (p !== null && model.nodes[p]!.kind !== 'roster') p = model.nodes[p]!.parent;
      return p === null ? model.nodes.length : model.nodes[p]!.end + 1;
    })();
    for (const e of node.endIf) {
      if (constantTruth(e.expr) === true) markRange(node.end + 1, model.nodes.length, '');
    }
    for (const s of node.skips) {
      if (constantTruth(s.expr) !== true || s.target === null) continue;
      if (s.target === SKIP_END) markRange(node.end + 1, model.nodes.length, '');
      else if (s.target === SKIP_END_ROW) markRange(node.end + 1, scopeEnd, chain);
      else {
        for (let i = node.end + 1; i < s.target; i++) {
          if (!isAncestor(model.nodes, i, s.target)) unreachable.add(i);
        }
      }
      break;
    }
  }
  // Report only the topmost unreachable node of each subtree.
  for (const i of [...unreachable].sort((a, b) => a - b)) {
    const n = model.nodes[i]!;
    if (n.parent !== null && unreachable.has(n.parent)) continue;
    add({
      severity: 'error',
      code: 'unreachable',
      message: `${n.id} can never be reached`,
      msg: { id: 'unreachable', params: { name: n.id } },
      itemId: n.id,
    });
  }
}

function checkComputedCycles(model: Model, add: (d: Diagnostic) => void) {
  const computed = model.nodes.filter((n) => n.kind === 'computed');
  const edges = new Map<string, string[]>();
  for (const c of computed) {
    edges.set(
      c.name!,
      (c.formula?.refs ?? []).filter((r) => own(model.vars, r)?.kind === 'computed'),
    );
  }
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const dfs = (name: string, stack: string[]) => {
    state.set(name, 1);
    for (const dep of edges.get(name) ?? []) {
      if (dep === name) continue; // self-reference reported as computed_cycle by forward-ref check
      if (state.get(dep) === 1) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          add({
            severity: 'error',
            code: 'computed_cycle',
            message: `Computed variables form a cycle: ${cycle.join(' → ')}`,
            msg: { id: 'computed_cycle', params: { cycle: cycle.join(' → ') } },
            itemId: model.nodes[own(model.vars, dep)!.node]!.id,
          });
        }
      } else if (!state.has(dep)) dfs(dep, [...stack, dep]);
    }
    state.set(name, 2);
  };
  for (const c of computed) if (!state.has(c.name!)) dfs(c.name!, [c.name!]);
}

function checkQuotas(
  model: Model,
  specialCodes: (string | number)[],
  add: (d: Diagnostic) => void,
) {
  for (const q of model.quotas) {
    const field = `quotas.${q.id}`;
    if (!q.expr.ast) {
      add({
        severity: 'error',
        code: 'syntax',
        message: q.expr.error!.message,
        msg: { id: 'syntax', params: { at: q.expr.error!.span.start + 1 } },
        field,
        span: q.expr.error!.span,
      });
      continue;
    }
    const { issues } = typecheck(q.expr.ast, { vars: model.vars, rosterChain: [], specialCodes });
    for (const i of issues) add({ ...i, field });
  }
}
