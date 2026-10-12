import { evaluateCondition, tryParse, type Node, type Scope, type Value } from '@wansurvey/logic';

export const MASK = '•••';

export interface CaseLike {
  sample: unknown;
  status: string;
  priority: number;
  modePreference: string | null;
}

/** Checks a rule expression before it is saved: it must parse and only read case data. */
export function ruleError(filter: string): string | null {
  const r = tryParse(filter);
  if (!r.ok) return r.error.message;
  const bad: string[] = [];
  const walk = (n: Node): void => {
    if (n.type === 'var' && !['status', 'priority', 'modePreference', 'case'].includes(n.name))
      bad.push(n.name);
    if (n.type === 'member') {
      if (!(n.object.type === 'var' && n.object.name === 'case')) walk(n.object);
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'span' || !v || typeof v !== 'object') continue;
      if (Array.isArray(v)) v.forEach((x) => walk(x as Node));
      else if ('type' in v) walk(v as Node);
    }
  };
  walk(r.node);
  return bad.length
    ? `Rules can only use case.*, status, priority and modePreference (not ${bad.join(', ')})`
    : null;
}

function caseScope(c: CaseLike): Scope {
  const sample = (c.sample ?? {}) as Record<string, unknown>;
  const vars: Record<string, Value> = {
    status: c.status,
    priority: c.priority,
    modePreference: c.modePreference,
  };
  return {
    get: (name) => (name in vars ? vars[name]! : undefined),
    namespace: (ns) => (ns === 'case' ? sample : undefined),
    rowIndex: () => null,
    rowScope: () => null,
    label: () => null,
    mode: null,
    today: new Date().toISOString().slice(0, 10),
  };
}

/** A compiled rule; null input matches every case. */
export function compileRule(filter: string | null | undefined): (c: CaseLike) => boolean {
  if (!filter?.trim()) return () => true;
  const r = tryParse(filter);
  if (!r.ok) return () => false;
  return (c) => evaluateCondition(r.node, caseScope(c));
}

/** Replaces personal sample fields and contact values when the viewer lacks `pii.view`. */
export function maskSample(
  sample: Record<string, unknown>,
  piiFields: ReadonlySet<string>,
  canSeePii: boolean,
): Record<string, unknown> {
  if (canSeePii) return sample;
  return Object.fromEntries(
    Object.entries(sample).map(([k, v]) => [k, piiFields.has(k) && v !== null ? MASK : v]),
  );
}

export function maskContact<T extends { value: string }>(c: T, canSeePii: boolean): T {
  return canSeePii ? c : { ...c, value: MASK };
}
