import {
  freshName,
  locate,
  renameVariable,
  updateNode,
  usedNames,
  type Draft,
  type TreeNode,
} from './tree.js';

/**
 * Three-way merge of questionnaire drafts, for two designers editing at once.
 *
 * `base` is the draft both started from, `mine` has the local edits and `theirs` was saved by
 * someone else. Items are merged by id: content (an item without its children), parent and
 * order separately, so edits to different items, or to different parts of the structure,
 * combine. Questionnaire-level parts (title, languages, settings, answer sets, scripts, quotas)
 * merge as whole values. Only the same thing changed differently on both sides is a conflict.
 */
export interface MergeResult {
  /** The merged draft, or null when there are conflicts. */
  draft: Draft | null;
  /** Item ids, or `questionnaire.<key>`, changed differently on both sides. */
  conflicts: string[];
}

type Own = Omit<TreeNode, 'items'>;
interface Entry {
  own: Own;
  container: boolean;
  parent: string | null;
  prev: string | null;
}
interface Indexed {
  byId: Map<string, Entry>;
  children: Map<string | null, string[]>;
}

/** JSON with sorted keys, so equal values compare equal whatever the key order. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function index(d: Draft): Indexed {
  const byId = new Map<string, Entry>();
  const children = new Map<string | null, string[]>();
  const walk = (list: TreeNode[], parent: string | null) => {
    children.set(
      parent,
      list.map((n) => n.id),
    );
    list.forEach((node, i) => {
      const { items, ...own } = node as TreeNode & { items?: TreeNode[] };
      byId.set(node.id, {
        own: own as Own,
        container: Array.isArray(items),
        parent,
        prev: i ? list[i - 1]!.id : null,
      });
      if (Array.isArray(items)) walk(items, node.id);
    });
  };
  walk(d.sections as TreeNode[], null);
  return { byId, children };
}

/** Three-way choice for one value; `conflict` when both sides changed it differently. */
function pick<T>(base: T, mine: T, theirs: T): { value: T; conflict: boolean } {
  if (same(mine, theirs) || same(base, theirs)) return { value: mine, conflict: false };
  if (same(base, mine)) return { value: theirs, conflict: false };
  return { value: mine, conflict: true };
}

/** Gives an item a new id (and variable name, when they matched), updating references. */
function renameId(d: Draft, id: string, newId: string): Draft {
  const at = locate(d, id);
  if (!at) return d;
  if ('name' in at.node && at.node.name === id) return renameVariable(d, id, newId);
  const json = JSON.stringify(d, (key, value: unknown) =>
    (key === 'to' || key === 'itemId') && value === id ? newId : value,
  );
  return updateNode(JSON.parse(json) as Draft, id, (n) => ({ ...n, id: newId }));
}

export function mergeDrafts(base: Draft, mine: Draft, theirs: Draft): MergeResult {
  // Both added an item with the same new id (e.g. both added "Q5"): mine gets a fresh id.
  const b0 = index(base);
  const t0 = index(theirs);
  for (const [id, entry] of index(mine).byId) {
    const other = t0.byId.get(id);
    if (!b0.byId.has(id) && other && !same(other.own, entry.own)) {
      const used = new Set([...usedNames(mine), ...usedNames(theirs)]);
      mine = renameId(mine, id, freshName(used, id));
    }
  }

  const b = index(base);
  const m = index(mine);
  const t = index(theirs);
  const conflicts: string[] = [];

  // Questionnaire-level parts.
  const top: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  keys.delete('sections');
  for (const k of keys) {
    const r = pick(
      (base as Record<string, unknown>)[k],
      (mine as Record<string, unknown>)[k],
      (theirs as Record<string, unknown>)[k],
    );
    if (r.conflict) conflicts.push(`questionnaire.${k}`);
    if (r.value !== undefined) top[k] = r.value;
  }

  // Content and parent of every item that survives.
  const kept = new Map<string, Entry>();
  const ids = new Set([...b.byId.keys(), ...m.byId.keys(), ...t.byId.keys()]);
  for (const id of ids) {
    const was = b.byId.get(id);
    const my = m.byId.get(id);
    const their = t.byId.get(id);
    if (!my && !their) continue;
    if (!was) {
      kept.set(id, (their ?? my)!);
      continue;
    }
    if (!my || !their) {
      // Deleted on one side: fine unless the other side edited it meanwhile.
      const other = (my ?? their)!;
      if (!same(other.own, was.own)) conflicts.push(id);
      continue;
    }
    const own = pick(was.own, my.own, their.own);
    const parent = pick(was.parent, my.parent, their.parent);
    if (own.conflict || parent.conflict) conflicts.push(id);
    kept.set(id, {
      own: own.value,
      container: my.container || their.container,
      parent: parent.value,
      prev: null,
    });
  }

  // Order: theirs, then each item mine added or moved goes after its predecessor in mine.
  const order = new Map<string | null, string[]>();
  const listOf = (p: string | null) => order.get(p) ?? order.set(p, []).get(p)!;
  for (const [p, kids] of t.children)
    order.set(
      p,
      kids.filter((id) => kept.get(id)?.parent === p),
    );
  const placedByMine = (id: string) => {
    const my = m.byId.get(id);
    const was = b.byId.get(id);
    if (!my || kept.get(id)?.parent !== my.parent) return false;
    return !was || was.parent !== my.parent || was.prev !== my.prev || !t.byId.has(id);
  };
  for (const [p, kids] of m.children)
    for (const id of kids) {
      if (!kept.has(id) || !placedByMine(id)) continue;
      // Theirs moved it too: theirs wins the position unless mine also changed its parent.
      const their = t.byId.get(id);
      const was = b.byId.get(id);
      if (their && was && (their.parent !== was.parent || their.prev !== was.prev)) {
        if (kept.get(id)!.parent === their.parent) continue;
      }
      for (const list of order.values()) {
        const at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1);
      }
      const list = listOf(p);
      const prev = m.byId.get(id)!.prev;
      list.splice(prev && list.includes(prev) ? list.indexOf(prev) + 1 : 0, 0, id);
    }
  // Anything kept but not yet placed (its parent changed on their side only).
  const placed = new Set([...order.values()].flat());
  for (const [id, e] of kept) if (!placed.has(id)) listOf(e.parent).push(id);

  // Every item needs a parent that still exists and holds items.
  for (const [id, e] of kept)
    if (e.parent !== null && !kept.get(e.parent)?.container) conflicts.push(id);

  if (conflicts.length) return { draft: null, conflicts: [...new Set(conflicts)] };

  const build = (p: string | null): TreeNode[] =>
    (order.get(p) ?? []).map((id) => {
      const e = kept.get(id)!;
      return (e.container ? { ...e.own, items: build(id) } : e.own) as TreeNode;
    });
  return {
    draft: { ...(top as Draft), sections: build(null) as Draft['sections'] },
    conflicts: [],
  };
}
