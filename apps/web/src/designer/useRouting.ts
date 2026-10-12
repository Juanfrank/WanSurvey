import {
  describeCondition,
  routingMap,
  type Node,
  type RoutingNode,
  type Value,
} from '@wansurvey/logic';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DraftApi } from './useDraft.js';
import { variablesOf } from './vars.js';

/** Lanes for arcs so overlapping spans never share a lane (greedy interval colouring). */
export function assignLanes(arcs: { from: number; to: number }[]): number[] {
  const order = arcs
    .map((a, i) => ({ i, lo: Math.min(a.from, a.to), hi: Math.max(a.from, a.to) }))
    .sort((x, y) => x.hi - x.lo - (y.hi - y.lo) || x.lo - y.lo);
  const lanes: { lo: number; hi: number }[][] = [];
  const out = new Array<number>(arcs.length).fill(0);
  for (const a of order) {
    let lane = lanes.findIndex((l) => l.every((b) => a.hi <= b.lo || a.lo >= b.hi));
    if (lane < 0) lane = lanes.push([]) - 1;
    lanes[lane]!.push(a);
    out[a.i] = lane;
  }
  return out;
}

/**
 * The draft's routing (from `routingMap`) plus a plain-language describer, shared by the
 * Routing tab and the outline. Null when the draft does not parse.
 */
export function useRouting(d: Pick<DraftApi, 'questionnaire'>) {
  const { t } = useTranslation();
  const q = d.questionnaire;
  return useMemo(() => {
    if (!q) return null;
    const nodes = routingMap(q);
    const vars = new Map(variablesOf(q, q.defaultLanguage).map((v) => [v.name, v]));
    const describe = (ast: Node | null, src: string) =>
      ast
        ? describeCondition(ast, {
            ref: (n) => n,
            label: (n, c: Value) =>
              vars.get(n)?.codes?.find((x) => String(x.code) === String(c))?.label || null,
            t: (k, v) => t(k, { ...v, ns: 'renderer' }),
          })
        : src;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return { nodes, byId, describe };
  }, [q, t]);
}

export type Routing = NonNullable<ReturnType<typeof useRouting>>;

/** Short logic summary of a node for badges and screen readers. */
export function logicSummary(
  n: RoutingNode,
  r: Routing,
  t: (k: string, v?: Record<string, unknown>) => string,
) {
  const parts: string[] = [];
  if (n.showIf)
    parts.push(t('designer.routing.askIf', { c: r.describe(n.showIf.ast, n.showIf.src) }));
  for (const s of n.skips) {
    const target =
      s.to === 'END'
        ? t('designer.logic.end')
        : s.to === 'END_ROW'
          ? t('designer.logic.endRow')
          : s.to;
    parts.push(t('designer.routing.skipTo', { to: target, c: r.describe(s.ast, s.src) }));
  }
  for (const e of n.ends)
    parts.push(t('designer.routing.endsAs', { d: e.disposition, c: r.describe(e.ast, e.src) }));
  return parts;
}
