import type {
  AnswerOption,
  ContainerItem,
  LocalizedText,
  Questionnaire,
  QuestionType,
  Section,
} from '@wansurvey/schema';
import { renameInExpression, renameInTemplate } from '@wansurvey/logic';

/**
 * Pure edits on a questionnaire draft, addressed by item/section id. Every function returns a
 * new draft; the input is never mutated (the designer keeps old drafts for undo).
 */
export type Draft = Questionnaire;
export type TreeNode = Section | ContainerItem;

export interface Located {
  node: TreeNode;
  /** The array holding the node: `sections` or a parent's `items`. */
  siblings: TreeNode[];
  index: number;
  /** Id of the parent section/block/roster; null for sections. */
  parentId: string | null;
  depth: number;
}

const hasItems = (n: TreeNode): n is Extract<TreeNode, { items: ContainerItem[] }> =>
  'items' in n && Array.isArray((n as { items?: unknown }).items);

export const isSection = (n: TreeNode): n is Section => !('kind' in n);

export function locate(draft: Draft, id: string): Located | null {
  const walk = (list: TreeNode[], parentId: string | null, depth: number): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i]!;
      if (node.id === id) return { node, siblings: list, index: i, parentId, depth };
      if (hasItems(node)) {
        const hit = walk(node.items, node.id, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(draft.sections, null, 0);
}

/** Depth-first list of every node, as the outline shows it. */
export function flatten(
  draft: Draft,
  collapsed: ReadonlySet<string> = new Set(),
): { node: TreeNode; depth: number; parentId: string | null }[] {
  const out: { node: TreeNode; depth: number; parentId: string | null }[] = [];
  const walk = (list: TreeNode[], depth: number, parentId: string | null) => {
    for (const node of list) {
      out.push({ node, depth, parentId });
      if (hasItems(node) && !collapsed.has(node.id)) walk(node.items, depth + 1, node.id);
    }
  };
  walk(draft.sections ?? [], 0, null);
  return out;
}

function edit(draft: Draft, fn: (d: Draft) => void): Draft {
  const copy = structuredClone(draft);
  fn(copy);
  return copy;
}

export function updateNode(draft: Draft, id: string, patch: (n: TreeNode) => TreeNode): Draft {
  return edit(draft, (d) => {
    const at = locate(d, id);
    if (at) at.siblings[at.index] = patch(at.node);
  });
}

/** Moves a node up or down among its siblings. */
export function move(draft: Draft, id: string, delta: -1 | 1): Draft {
  return edit(draft, (d) => {
    const at = locate(d, id);
    if (!at) return;
    const to = at.index + delta;
    if (to < 0 || to >= at.siblings.length) return;
    const [n] = at.siblings.splice(at.index, 1);
    at.siblings.splice(to, 0, n!);
  });
}

/** Puts an item at the end of the block/roster just above it. */
export function indent(draft: Draft, id: string): Draft {
  return edit(draft, (d) => {
    const at = locate(d, id);
    if (!at || isSection(at.node) || at.index === 0) return;
    const prev = at.siblings[at.index - 1]!;
    if (isSection(prev) || !hasItems(prev)) return;
    at.siblings.splice(at.index, 1);
    prev.items.push(at.node as ContainerItem);
  });
}

/** Moves an item out of its block/roster, right after it. */
export function outdent(draft: Draft, id: string): Draft {
  return edit(draft, (d) => {
    const at = locate(d, id);
    if (!at || isSection(at.node) || at.parentId === null) return;
    const parent = locate(d, at.parentId)!;
    if (isSection(parent.node)) return;
    at.siblings.splice(at.index, 1);
    parent.siblings.splice(parent.index + 1, 0, at.node);
  });
}

/** Whether `id` is `ancestorId` or lies inside it. */
export function isWithin(draft: Draft, id: string, ancestorId: string): boolean {
  let at = locate(draft, id);
  while (at) {
    if (at.node.id === ancestorId) return true;
    at = at.parentId ? locate(draft, at.parentId) : null;
  }
  return false;
}

/**
 * Whether `id` may be placed in `parentId` (null: the list of sections). Sections only sit at
 * the top; items sit in a section, block or roster, never inside themselves.
 */
export function canMoveTo(draft: Draft, id: string, parentId: string | null): boolean {
  const at = locate(draft, id);
  if (!at) return false;
  if (isSection(at.node)) return parentId === null;
  if (parentId === null) return false;
  const parent = locate(draft, parentId);
  return !!parent && hasItems(parent.node) && !isWithin(draft, parentId, id);
}

export type DropZone = 'before' | 'after' | 'inside';

/** Where a drop on row `overId` puts things: before or after it, or at the end of its items. */
export function dropPlace(
  draft: Draft,
  overId: string,
  zone: DropZone,
): { parentId: string | null; index: number } | null {
  const at = locate(draft, overId);
  if (!at) return null;
  if (zone === 'inside')
    return hasItems(at.node) ? { parentId: overId, index: at.node.items.length } : null;
  return { parentId: at.parentId, index: at.index + (zone === 'after' ? 1 : 0) };
}

/**
 * Moves a node into `parentId` at `index`, counted in the target list as it is before the
 * move (so dropping "before row 3" is index 3 wherever the node came from). Returns the draft
 * unchanged when the move is not allowed.
 */
export function moveTo(draft: Draft, id: string, parentId: string | null, index: number): Draft {
  if (!canMoveTo(draft, id, parentId)) return draft;
  return edit(draft, (d) => {
    const at = locate(d, id)!;
    const target: TreeNode[] =
      parentId === null ? d.sections : (locate(d, parentId)!.node as { items: TreeNode[] }).items;
    let to = Math.max(0, Math.min(index, target.length));
    if (target === at.siblings && at.index < to) to -= 1;
    at.siblings.splice(at.index, 1);
    target.splice(to, 0, at.node);
  });
}

export function remove(draft: Draft, id: string): Draft {
  return edit(draft, (d) => {
    const at = locate(d, id);
    if (!at) return;
    if (isSection(at.node) && d.sections.length <= 1) return;
    at.siblings.splice(at.index, 1);
  });
}

/** Every id and variable name in use, so new ones never collide. */
export function usedNames(draft: Draft): Set<string> {
  const used = new Set<string>();
  for (const { node } of flatten(draft)) {
    used.add(node.id);
    if ('name' in node && typeof node.name === 'string') used.add(node.name);
  }
  return used;
}

export function freshName(used: Set<string>, base: string): string {
  const stem = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '') || 'Q';
  if (!used.has(stem)) return stem;
  const m = /^(.*?)(\d+)$/.exec(stem);
  const prefix = m ? m[1]! : `${stem}_`;
  for (let i = m ? Number(m[2]) + 1 : 2; ; i++) {
    if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  }
}

/** A copy of a node with fresh ids/names (nested items too), placed right after it. */
export function duplicate(draft: Draft, id: string): { draft: Draft; newId: string | null } {
  let newId: string | null = null;
  const next = edit(draft, (d) => {
    const at = locate(d, id);
    if (!at) return;
    const used = usedNames(d);
    const rename = (n: TreeNode): TreeNode => {
      const copy = { ...n } as TreeNode & { name?: string; items?: ContainerItem[] };
      copy.id = freshName(used, n.id);
      used.add(copy.id);
      if ('name' in n && typeof n.name === 'string') {
        copy.name = n.name === n.id ? copy.id : freshName(used, n.name);
        used.add(copy.name);
      }
      if (copy.items) copy.items = copy.items.map((c) => rename(c) as ContainerItem);
      return copy;
    };
    const copy = rename(structuredClone(at.node));
    newId = copy.id;
    at.siblings.splice(at.index + 1, 0, copy);
  });
  return { draft: next, newId };
}

/** The variable-name root of a section: its `prefix`, or its id without `SEC_`/`SECTION_`. */
export function sectionRoot(section: Section): string {
  if (section.prefix) return section.prefix;
  const bare = section.id.replace(/^(SEC|SECTION|SECCION)_?/i, '');
  return /^[A-Za-z]/.test(bare) ? bare : `S${bare}`;
}

/** The section that holds `id` (itself when it is a section). */
export function sectionOf(draft: Draft, id: string): Section | null {
  let at = locate(draft, id);
  while (at && at.parentId !== null) at = locate(draft, at.parentId);
  return at && isSection(at.node) ? at.node : null;
}

export type NewKind =
  | { kind: 'question'; type: QuestionType }
  | { kind: 'static' }
  | { kind: 'computed' }
  | { kind: 'pagebreak' }
  | { kind: 'block' }
  | { kind: 'roster' }
  | { kind: 'section' };

function text(draft: Draft, s: string): LocalizedText {
  return Object.fromEntries((draft.languages ?? ['en']).map((l) => [l, s]));
}

export function newNode(draft: Draft, what: NewKind, used: Set<string>, root = 'Q'): TreeNode {
  const name = (base: string) => {
    const n = freshName(used, base);
    used.add(n);
    return n;
  };
  switch (what.kind) {
    case 'section':
      return { id: name('SEC_1'), title: text(draft, ''), items: [] };
    case 'question': {
      // A1, A2… after a root that ends in a letter; S1_1, S1_2… after one that ends in a digit.
      const id = name(/\d$/.test(root) ? `${root}_1` : `${root}1`);
      const q: ContainerItem = {
        kind: 'question',
        id,
        name: id,
        type: what.type,
        text: text(draft, ''),
      };
      if (what.type === 'single' || what.type === 'multi' || what.type === 'ranking') {
        q.options = [
          { code: 1, label: text(draft, '') },
          { code: 2, label: text(draft, '') },
        ];
      }
      if (what.type === 'grid') {
        q.rows = [{ code: 1, label: text(draft, '') }];
        q.options = [
          { code: 1, label: text(draft, '') },
          { code: 2, label: text(draft, '') },
        ];
      }
      if (what.type === 'scale') q.scale = { style: 'likert', min: 1, max: 5 };
      return q;
    }
    case 'static':
      return { kind: 'static', id: name('INFO_1'), text: text(draft, '') };
    case 'computed': {
      const id = name('CALC_1');
      return { kind: 'computed', id, name: id, formula: '0', valueType: 'number' };
    }
    case 'pagebreak':
      return { kind: 'pagebreak', id: name('PB_1') };
    case 'block':
      return { kind: 'block', id: name('BLOCK_1'), items: [] };
    case 'roster': {
      const id = name('ROSTER_1');
      return { kind: 'roster', id, name: id, count: { type: 'open', max: 20 }, items: [] };
    }
  }
}

/**
 * Inserts a new node after `afterId` (inside it, at the start, when it is a section, block or
 * roster that is expanded). Sections always go after the current section.
 */
export function insert(
  draft: Draft,
  afterId: string | null,
  what: NewKind,
  opts: { inside?: boolean } = {},
): { draft: Draft; newId: string } {
  let newId = '';
  const next = edit(draft, (d) => {
    const used = usedNames(d);
    // New questions are named after the root of the section they land in (A1, A2… in SEC_A).
    const host = afterId ? sectionOf(d, afterId) : d.sections[d.sections.length - 1];
    const node = newNode(d, what, used, host ? sectionRoot(host) : 'Q');
    newId = node.id;
    if (what.kind === 'section') {
      let sectionIndex = d.sections.length - 1;
      if (afterId) {
        let at = locate(d, afterId);
        while (at && at.parentId !== null) at = locate(d, at.parentId);
        if (at) sectionIndex = at.index;
      }
      d.sections.splice(sectionIndex + 1, 0, node as Section);
      return;
    }
    const at = afterId ? locate(d, afterId) : null;
    if (!at) {
      (d.sections[d.sections.length - 1]!.items as TreeNode[]).push(node);
      return;
    }
    if (hasItems(at.node) && (opts.inside || isSection(at.node))) {
      (at.node.items as TreeNode[]).unshift(node);
      return;
    }
    at.siblings.splice(at.index + 1, 0, node);
  });
  return { draft: next, newId };
}

/** Renames a variable (and its id when they matched), updating references in expressions. */
export function renameVariable(draft: Draft, id: string, newName: string): Draft {
  const at = locate(draft, id);
  if (!at || !('name' in at.node) || typeof at.node.name !== 'string') return draft;
  const old = at.node.name;
  if (old === newName) return draft;
  const renames: Record<string, string> = { [old]: newName };
  // The "other, specify" text follows its question.
  const options = questionOptionsOf(draft, at.node);
  if (options.some((o) => o.otherSpecify)) renames[`${old}_OTHER`] = `${newName}_OTHER`;
  const sameId = at.node.id === old;
  const json = JSON.stringify(draft, (key, value) => {
    if (typeof value !== 'string') return value;
    if (EXPRESSION_KEYS.has(key)) return renameInExpression(value, renames);
    // Skip targets and script anchors name the item id.
    if (sameId && (key === 'to' || key === 'itemId') && value === old) return newName;
    // Pipes in texts: {{OLD}}, {{OLD | label}}, {{#if OLD == 1}}.
    return renameInTemplate(value, renames);
  });
  const renamed = JSON.parse(json) as Draft;
  return updateNode(renamed, id, (n) => ({
    ...n,
    name: newName,
    ...(sameId ? { id: newName } : {}),
  })) as Draft;
}

/** Keys whose string values are logic expressions. */
export const EXPRESSION_KEYS = new Set([
  'showIf',
  'optionFilter',
  'prefill',
  'when',
  'formula',
  'expr',
  'rowLabel',
  'minDate',
  'maxDate',
]);

function questionOptionsOf(draft: Draft, node: TreeNode): AnswerOption[] {
  const q = node as { options?: AnswerOption[]; answerSetId?: string };
  if (q.options?.length) return q.options;
  return (q.answerSetId && draft.answerSets?.[q.answerSetId]) || [];
}

/** What the question library stores: one item, block or roster and the answer sets it uses. */
export interface LibraryContent {
  node: ContainerItem;
  answerSets: Record<string, AnswerOption[]>;
}

/** The answer sets a node (and its children) refers to. */
export function libraryContentOf(draft: Draft, id: string): LibraryContent | null {
  const at = locate(draft, id);
  if (!at || isSection(at.node)) return null;
  const node = structuredClone(at.node) as ContainerItem;
  const sets: Record<string, AnswerOption[]> = {};
  const walk = (n: TreeNode) => {
    const set = (n as { answerSetId?: string }).answerSetId;
    if (set && draft.answerSets?.[set]) sets[set] = draft.answerSets[set]!;
    if (hasItems(n)) n.items.forEach(walk);
  };
  walk(node);
  return { node, answerSets: sets };
}

/**
 * Inserts a library entry after `afterId` (or inside it). Ids and variable names already used
 * in the draft get fresh ones, with references inside the entry updated; answer sets are
 * reused when identical and renamed when a different set has the name.
 */
export function insertFromLibrary(
  draft: Draft,
  afterId: string | null,
  content: LibraryContent,
  opts: { inside?: boolean } = {},
): { draft: Draft; newId: string; renamed: Record<string, string> } {
  const used = usedNames(draft);
  const renamed: Record<string, string> = {};
  // Work on a scratch questionnaire holding only the entry, so renames stay inside it.
  let scratch = {
    ...draft,
    answerSets: {},
    sections: [{ id: '__library', title: {}, items: [structuredClone(content.node)] }],
  } as Draft;
  for (const { node } of flatten(scratch)) {
    if (node.id === '__library') continue;
    const name = 'name' in node && typeof node.name === 'string' ? node.name : null;
    if (!used.has(node.id) && (!name || !used.has(name))) {
      used.add(node.id);
      if (name) used.add(name);
      continue;
    }
    const fresh = freshName(used, name ?? node.id);
    used.add(fresh);
    renamed[name ?? node.id] = fresh;
    if (name && name === node.id) scratch = renameVariable(scratch, node.id, fresh);
    else if (name) {
      scratch = renameVariable(scratch, node.id, fresh);
      if (used.has(node.id)) {
        const id = freshName(used, node.id);
        used.add(id);
        scratch = updateNode(scratch, node.id, (n) => ({ ...n, id }));
      }
    } else scratch = updateNode(scratch, node.id, (n) => ({ ...n, id: fresh }));
  }
  let node = scratch.sections[0]!.items[0]!;

  // Answer sets: same name and content reuses it; a different set with the name is renamed.
  const sets = { ...(draft.answerSets ?? {}) };
  const setNames: Record<string, string> = {};
  for (const [name, options] of Object.entries(content.answerSets ?? {})) {
    const existing = sets[name];
    if (existing && JSON.stringify(existing) === JSON.stringify(options)) continue;
    const target = existing ? freshName(new Set(Object.keys(sets)), name) : name;
    sets[target] = options;
    if (target !== name) setNames[name] = target;
  }
  if (Object.keys(setNames).length)
    node = JSON.parse(
      JSON.stringify(node, (k, v: unknown) =>
        k === 'answerSetId' && typeof v === 'string' && setNames[v] ? setNames[v] : v,
      ),
    ) as ContainerItem;

  const placed = edit({ ...draft, answerSets: sets }, (d) => {
    const at = afterId ? locate(d, afterId) : null;
    if (!at) {
      (d.sections[d.sections.length - 1]!.items as TreeNode[]).push(node);
      return;
    }
    if (hasItems(at.node) && (opts.inside || isSection(at.node))) {
      (at.node.items as TreeNode[]).unshift(node);
      return;
    }
    if (isSection(at.node)) return;
    at.siblings.splice(at.index + 1, 0, node);
  });
  return { draft: placed, newId: node.id, renamed };
}
