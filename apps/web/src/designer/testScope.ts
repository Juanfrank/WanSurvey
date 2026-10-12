import {
  NAMESPACES,
  special,
  type Namespace,
  type Node,
  type Scope,
  type Value,
} from '@wansurvey/logic';

/** Names an expression reads: variables (`Q1`) and namespaced fields (`case.region`). */
export function readNames(node: Node): string[] {
  const out: string[] = [];
  const ns = new Set<string>(NAMESPACES);
  const add = (n: string) => !out.includes(n) && out.push(n);
  const walk = (n: Node): void => {
    switch (n.type) {
      case 'var':
        if (!ns.has(n.name) && n.name !== 'mode' && n.name !== 'index') add(n.name);
        return;
      case 'member':
        if (n.object.type === 'var' && ns.has(n.object.name)) add(`${n.object.name}.${n.property}`);
        else walk(n.object);
        return;
      case 'index':
        walk(n.object);
        walk(n.index);
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
  walk(node);
  return out;
}

/** Test input text → value: '' unanswered, '$DK'/'$RF' specials, numbers stay numbers. */
export function testValue(raw: string | string[] | undefined): Value {
  if (Array.isArray(raw)) return raw.map((x) => testValue(x)) as Value[];
  if (raw === undefined || raw === '') return null;
  if (raw === '$DK') return special('DK');
  if (raw === '$RF') return special('RF');
  return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
}

/** A scope over typed test answers, for "Try it" in the condition builder. */
export function testScope(
  values: Record<string, string | string[]>,
  labels: (name: string, code: Value) => string | null,
  today = new Date().toISOString().slice(0, 10),
): Scope {
  return {
    get: (name) => (name in values ? testValue(values[name]) : null),
    namespace: (ns: Namespace) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values))
        if (k.startsWith(`${ns}.`)) out[k.slice(ns.length + 1)] = testValue(v);
      return out;
    },
    rowIndex: () => null,
    rowScope: () => null,
    label: labels,
    mode: 'CAPI',
    today,
  };
}
