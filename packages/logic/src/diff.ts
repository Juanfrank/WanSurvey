import type { Question, Questionnaire, VersionMapping } from '@wansurvey/schema';
import { buildModel, type Model, type VariableInfo } from './model.js';
import type { MessageRef } from './typecheck.js';

export type BreakingKind = 'removed' | 'type' | 'codes' | 'roster' | 'gridRows';

/** A change that makes data from the previous version incompatible with the next one. */
export interface BreakingChange {
  /** Stable id, `kind:VARIABLE`; the key of its entry in the mapping. */
  id: string;
  kind: BreakingKind;
  variable: string;
  message: string;
  msg?: MessageRef;
  /** Codes (or grid rows) that no longer exist. */
  removedCodes?: (string | number)[];
  /** Which mapping actions make sense for it. */
  allowed: ('rename' | 'recode' | 'drop')[];
}

const DATA_KINDS = new Set<VariableInfo['kind']>(['question', 'computed', 'roster']);

function gridRows(model: Model, v: VariableInfo): (string | number)[] {
  const def = model.nodes[v.node]?.def as Question | undefined;
  return def?.type === 'grid' ? (def.rows ?? []).map((r) => r.code) : [];
}

const key = (c: string | number) => String(c);

/**
 * Differences between two versions that would break merged data: removed variables, changed
 * value types, removed codes, variables moved into or out of a roster, removed grid rows.
 * Added variables and added codes are not breaking.
 */
export function breakingChanges(prev: Questionnaire, next: Questionnaire): BreakingChange[] {
  const a = buildModel(prev);
  const b = buildModel(next);
  const out: BreakingChange[] = [];
  for (const [name, pv] of Object.entries(a.vars)) {
    if (!DATA_KINDS.has(pv.kind)) continue;
    const nv = Object.prototype.hasOwnProperty.call(b.vars, name) ? b.vars[name] : undefined;
    if (!nv || !DATA_KINDS.has(nv.kind)) {
      out.push({
        id: `removed:${name}`,
        kind: 'removed',
        variable: name,
        message: `${name} no longer exists`,
        allowed: ['rename', 'drop'],
      });
      continue;
    }
    if (pv.type !== nv.type || (pv.kind === 'roster') !== (nv.kind === 'roster')) {
      out.push({
        id: `type:${name}`,
        kind: 'type',
        variable: name,
        message: `${name} changed from ${pv.type} to ${nv.type}`,
        allowed: ['drop'],
      });
      continue;
    }
    if (pv.rosterChain.join('/') !== nv.rosterChain.join('/')) {
      out.push({
        id: `roster:${name}`,
        kind: 'roster',
        variable: name,
        message: `${name} moved ${nv.rosterChain.length ? `into roster ${nv.rosterChain.at(-1)}` : 'out of its roster'}`,
        allowed: ['drop'],
      });
      continue;
    }
    if (pv.codes) {
      const now = new Set((nv.codes ?? []).map(key));
      const removed = pv.codes.filter((c) => !now.has(key(c)));
      if (removed.length) {
        out.push({
          id: `codes:${name}`,
          kind: 'codes',
          variable: name,
          message: `${name} lost code(s) ${removed.join(', ')}`,
          removedCodes: removed,
          allowed: ['recode', 'drop'],
        });
      }
    }
    const rowsBefore = gridRows(a, pv);
    if (rowsBefore.length) {
      const now = new Set(gridRows(b, nv).map(key));
      const removed = rowsBefore.filter((c) => !now.has(key(c)));
      if (removed.length) {
        out.push({
          id: `gridRows:${name}`,
          kind: 'gridRows',
          variable: name,
          message: `${name} lost grid row(s) ${removed.join(', ')}`,
          removedCodes: removed,
          allowed: ['drop'],
        });
      }
    }
  }
  return out;
}

export interface MappingProblem {
  changeId: string;
  message: string;
  msg: MessageRef;
}

/** Checks that the mapping covers every breaking change with a valid action. */
export function validateMapping(
  changes: BreakingChange[],
  mapping: VersionMapping | undefined,
  prev: Questionnaire,
  next: Questionnaire,
): MappingProblem[] {
  const m = mapping ?? {};
  const a = buildModel(prev);
  const b = buildModel(next);
  const problems: MappingProblem[] = [];
  const ids = new Set(changes.map((c) => c.id));
  for (const id of Object.keys(m)) {
    if (!ids.has(id))
      problems.push({
        changeId: id,
        message: `No breaking change '${id}'`,
        msg: { id: 'no_such_change', params: { id } },
      });
  }
  for (const c of changes) {
    const action = Object.prototype.hasOwnProperty.call(m, c.id) ? m[c.id] : undefined;
    if (!action) {
      problems.push({
        changeId: c.id,
        message: `Choose what happens to ${c.variable}`,
        msg: { id: 'choose', params: { name: c.variable } },
      });
      continue;
    }
    if (!c.allowed.includes(action.action)) {
      problems.push({
        changeId: c.id,
        message: `'${action.action}' is not possible here`,
        msg: { id: 'not_possible', params: { action: action.action } },
      });
      continue;
    }
    if (action.action === 'rename') {
      const target = Object.prototype.hasOwnProperty.call(b.vars, action.to)
        ? b.vars[action.to]
        : undefined;
      const source = a.vars[c.variable]!;
      if (!target) {
        problems.push({
          changeId: c.id,
          message: `${action.to} does not exist in this version`,
          msg: { id: 'target_missing', params: { name: action.to } },
        });
      } else if (Object.prototype.hasOwnProperty.call(a.vars, action.to)) {
        problems.push({
          changeId: c.id,
          message: `${action.to} already existed and has its own data`,
          msg: { id: 'target_existed', params: { name: action.to } },
        });
      } else if (target.type !== source.type) {
        problems.push({
          changeId: c.id,
          message: `${action.to} holds ${target.type} values, ${c.variable} held ${source.type}`,
          msg: {
            id: 'target_type',
            params: { name: action.to, type: target.type, old: c.variable, oldType: source.type },
          },
        });
      }
    }
    if (action.action === 'recode') {
      const valid = new Set((b.vars[c.variable]?.codes ?? []).map(key));
      for (const code of c.removedCodes ?? []) {
        if (!Object.prototype.hasOwnProperty.call(action.map, key(code))) {
          problems.push({
            changeId: c.id,
            message: `Code ${code} needs a new code or 'discard'`,
            msg: { id: 'code_needs_target', params: { code: String(code) } },
          });
        }
      }
      for (const [from, to] of Object.entries(action.map)) {
        if (to !== null && !valid.has(key(to))) {
          problems.push({
            changeId: c.id,
            message: `${from} → ${to}: ${to} is not a code`,
            msg: { id: 'not_a_code', params: { from, to: String(to) } },
          });
        }
      }
    }
  }
  return problems;
}
