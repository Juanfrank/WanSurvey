import type { Questionnaire, Roster } from '@wansurvey/schema';
import { SKIP_END, SKIP_END_ROW } from '@wansurvey/schema';
import type { Node } from './ast.js';
import { buildModel, nodeExpressions, type CompiledExpr, type NodeKind } from './model.js';

export interface RoutingCondition {
  src: string;
  /** Parsed form for plain-language rendering; null when it does not parse. */
  ast: Node | null;
}

export interface RoutingSkip extends RoutingCondition {
  to: string;
  /** Index of the target in `nodes`, or END / END_ROW, or null when the target is unknown. */
  target: number | typeof SKIP_END | typeof SKIP_END_ROW | null;
}

export interface RoutingNode {
  index: number;
  id: string;
  kind: NodeKind;
  /** Variable name for data items. */
  name?: string;
  depth: number;
  parentId: string | null;
  /** Index of the last node inside this one (sections, blocks, rosters). */
  end: number;
  showIf?: RoutingCondition;
  skips: RoutingSkip[];
  ends: (RoutingCondition & { disposition: string })[];
  checks: { errors: number; warnings: number };
  hasPrefill: boolean;
  hasFilter: boolean;
  roster?: { count: 'fixed' | 'expression' | 'open'; n?: number; expr?: string; max?: number };
  /** Variables this node's logic reads. */
  reads: string[];
  /** Ids of nodes whose logic reads this node's variable. */
  readBy: string[];
}

const cond = (e: CompiledExpr): RoutingCondition => ({ src: e.src, ast: e.ast });

/**
 * The questionnaire's routing as an ordered list: what is conditional, where each skip lands,
 * which rules end the interview, and which items depend on which. Drives the designer's
 * routing map and the outline's skip arcs; derived on the fly, never stored.
 */
export function routingMap(questionnaire: Questionnaire): RoutingNode[] {
  const model = buildModel(questionnaire);
  const depthOf = (i: number): number => {
    let d = 0;
    for (let p = model.nodes[i]!.parent; p !== null; p = model.nodes[p]!.parent) d++;
    return d;
  };
  return model.nodes.map((n) => {
    const reads = new Set<string>();
    for (const e of nodeExpressions(n)) for (const r of e.expr.refs) reads.add(r);
    const readBy =
      n.name !== undefined
        ? (model.dependents[n.name] ?? [])
            .filter((i) => i !== n.index)
            .map((i) => model.nodes[i]!.id)
        : [];
    const node: RoutingNode = {
      index: n.index,
      id: n.id,
      kind: n.kind,
      ...(n.name !== undefined ? { name: n.name } : {}),
      depth: depthOf(n.index),
      parentId: n.parent === null ? null : model.nodes[n.parent]!.id,
      end: n.end,
      ...(n.showIf ? { showIf: cond(n.showIf) } : {}),
      skips: n.skips.map((s) => ({ ...cond(s.expr), to: s.to, target: s.target })),
      ends: n.endIf.map((e) => ({ ...cond(e.expr), disposition: e.disposition })),
      checks: {
        errors: n.validations.filter((v) => v.severity === 'error').length,
        warnings: n.validations.filter((v) => v.severity === 'warning').length,
      },
      hasPrefill: !!n.prefill,
      hasFilter: !!n.optionFilter,
      reads: [...reads],
      readBy,
    };
    if (n.kind === 'roster') {
      const c = (n.def as Roster).count;
      node.roster =
        c.type === 'fixed'
          ? { count: 'fixed', n: c.n }
          : c.type === 'expression'
            ? { count: 'expression', expr: c.expr, ...(c.max ? { max: c.max } : {}) }
            : { count: 'open', ...(c.max ? { max: c.max } : {}) };
    }
    return node;
  });
}
