import type { ContainerItem, Questionnaire, Section } from '@wansurvey/schema';

/** Fields that hold expressions; their changes are shown as logic, in plain language. */
const LOGIC_KEYS = new Set([
  'showIf',
  'optionFilter',
  'prefill',
  'when',
  'formula',
  'expr',
  'rowLabel',
]);

export type FieldChange =
  | { kind: 'text'; field: string; lang: string; before: string; after: string }
  | { kind: 'logic'; field: string; before: string | null; after: string | null }
  | { kind: 'value'; field: string; before: string | null; after: string | null };

export interface ItemComparison {
  id: string;
  /** section, question, static, computed, pagebreak, block or roster. */
  kind: string;
  name: string | null;
  status: 'added' | 'removed' | 'changed' | 'moved';
  /** Moved to another parent, or out of order among the items it shares with the other version. */
  moved: boolean;
  parentBefore: string | null;
  parentAfter: string | null;
  changes: FieldChange[];
}

export interface VersionComparison {
  /** Items that differ, in the order of the newer version, then the removed ones. */
  items: ItemComparison[];
  /** Questionnaire-level changes: title, languages, settings, answer sets, scripts, quotas. */
  questionnaire: FieldChange[];
  counts: { added: number; removed: number; changed: number; moved: number };
}

interface Placed {
  node: Section | ContainerItem;
  parentId: string | null;
}

function index(q: Questionnaire): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const walk = (list: (Section | ContainerItem)[], parentId: string | null) => {
    for (const node of list) {
      out.set(node.id, { node, parentId });
      if ('items' in node && Array.isArray(node.items)) walk(node.items, node.id);
    }
  };
  walk(q.sections, null);
  return out;
}

const isText = (v: unknown): v is Record<string, string> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.entries(v).every(
    ([k, x]) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(k) && typeof x === 'string',
  );

type Leaf =
  { kind: 'text'; lang: string; value: string } | { kind: 'logic' | 'value'; value: string };

/** Flattens a value into readable field paths, e.g. `options[2].label`, `skips[1].when`. */
function leaves(value: unknown, path: string, key: string, out: Map<string, Leaf>) {
  if (value === undefined || value === null) return;
  if (isText(value)) {
    for (const [lang, text] of Object.entries(value))
      out.set(`${path}\u0000${lang}`, { kind: 'text', lang, value: text });
    return;
  }
  if (typeof value === 'string' && LOGIC_KEYS.has(key)) {
    out.set(path, { kind: 'logic', value });
    return;
  }
  if (Array.isArray(value)) {
    const objects = value.every((v) => v && typeof v === 'object' && !Array.isArray(v));
    // Entries with a code (options, rows) or an id (checks, scripts, quotas) are matched by it.
    const id = !objects
      ? null
      : (['code', 'id'] as const).find((f) =>
          (value as Record<string, unknown>[]).every((v) => v[f] !== undefined),
        );
    if (id) {
      for (const v of value as Record<string, unknown>[])
        leaves(v, `${path}[${String(v[id])}]`, '', out);
    } else if (objects) {
      value.forEach((v, i) => leaves(v, `${path}[${i + 1}]`, '', out));
    } else out.set(path, { kind: 'value', value: JSON.stringify(value) });
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'items') continue;
      leaves(v, path ? `${path}.${k}` : k, k, out);
    }
    return;
  }
  out.set(path, { kind: 'value', value: String(value) });
}

function diffLeaves(before: unknown, after: unknown): FieldChange[] {
  const a = new Map<string, Leaf>();
  const b = new Map<string, Leaf>();
  leaves(before, '', '', a);
  leaves(after, '', '', b);
  const out: FieldChange[] = [];
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  for (const k of keys) {
    const x = a.get(k);
    const y = b.get(k);
    if (x?.value === y?.value) continue;
    const [field] = k.split('\u0000') as [string];
    const kind = (y ?? x)!.kind;
    if (kind === 'text')
      out.push({
        kind,
        field,
        lang: ((y ?? x) as { lang: string }).lang,
        before: x?.value ?? '',
        after: y?.value ?? '',
      });
    else out.push({ kind, field, before: x?.value ?? null, after: y?.value ?? null });
  }
  return out;
}

/** Positions of the longest increasing subsequence; entries outside it count as moved. */
function stable(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

/**
 * Compares two versions of a questionnaire item by item (matched by id): added, removed and
 * moved items, and every changed field, with texts per language and logic as expressions.
 */
export function compareVersions(before: Questionnaire, after: Questionnaire): VersionComparison {
  const a = index(before);
  const b = index(after);

  // Moved: a new parent, or out of order among the siblings both versions share.
  const moved = new Set<string>();
  const parents = new Set([...b.values()].map((p) => p.parentId));
  for (const parent of parents) {
    const kids = [...b.entries()]
      .filter(([id, p]) => p.parentId === parent && a.get(id)?.parentId === parent)
      .map(([id]) => id);
    const oldOrder = new Map(
      [...a.entries()].filter(([, p]) => p.parentId === parent).map(([id], i) => [id, i]),
    );
    const keep = stable(kids.map((id) => oldOrder.get(id)!));
    kids.forEach((id, i) => !keep.has(i) && moved.add(id));
  }

  const describe = (p: Placed) => ({
    id: p.node.id,
    kind: 'kind' in p.node ? p.node.kind : 'section',
    name: 'name' in p.node && typeof p.node.name === 'string' ? p.node.name : null,
  });
  const items: ItemComparison[] = [];
  for (const [id, now] of b) {
    const was = a.get(id);
    if (!was) {
      items.push({
        ...describe(now),
        status: 'added',
        moved: false,
        parentBefore: null,
        parentAfter: now.parentId,
        changes: [],
      });
      continue;
    }
    const changes = diffLeaves(was.node, now.node);
    const isMoved = moved.has(id) || was.parentId !== now.parentId;
    if (!changes.length && !isMoved) continue;
    items.push({
      ...describe(now),
      status: changes.length ? 'changed' : 'moved',
      moved: isMoved,
      parentBefore: was.parentId,
      parentAfter: now.parentId,
      changes,
    });
  }
  for (const [id, was] of a)
    if (!b.has(id))
      items.push({
        ...describe(was),
        status: 'removed',
        moved: false,
        parentBefore: was.parentId,
        parentAfter: null,
        changes: [],
      });

  const questionnaire = diffLeaves(
    { ...before, sections: undefined },
    { ...after, sections: undefined },
  );
  return {
    items,
    questionnaire,
    counts: {
      added: items.filter((i) => i.status === 'added').length,
      removed: items.filter((i) => i.status === 'removed').length,
      changed: items.filter((i) => i.status === 'changed').length,
      moved: items.filter((i) => i.moved).length,
    },
  };
}
