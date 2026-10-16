import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { smallBtn } from './fields.js';
import { iconKeyOf, KindIcon, questionMenu, structureMenu } from './kinds.js';
import { below, Menu, type MenuEntry } from './Menu.js';
import {
  duplicate,
  flatten,
  indent,
  insert,
  isSection,
  locate,
  canMoveTo,
  dropPlace,
  move,
  moveTo,
  outdent,
  remove,
  type Draft,
  type DropZone,
  type NewKind,
  type TreeNode,
} from './tree.js';
import { assignLanes, type Routing } from './useRouting.js';
import { nodeLabel, nodeName } from './vars.js';
import { dispositionLabel } from '../i18n-messages.js';

export const SETTINGS_ID = '__settings';

/**
 * The questionnaire as an accessible tree (WAI-ARIA tree pattern). Arrow keys move, Alt+arrows
 * reorder and indent, Insert adds, Delete removes (undo with Ctrl+Z), Ctrl+D duplicates,
 * F2 renames and Enter jumps to the editor.
 */
export function Outline({
  draft,
  selected,
  onSelect,
  change,
  errorsById,
  routing = null,
  lang,
  readOnly,
  onRename,
  onEnter,
  announce,
  others,
  commentCounts,
  onInsertFromLibrary,
  onSaveToLibrary,
}: {
  draft: Draft;
  selected: string;
  onSelect(id: string): void;
  change(next: Draft): void;
  errorsById: ReadonlyMap<string, number>;
  /** Routing of the draft for logic badges and skip arcs; null when the draft does not parse. */
  routing?: Routing | null;
  lang: string;
  readOnly: boolean;
  onRename(): void;
  onEnter(): void;
  announce(message: string): void;
  /** Other editors per item id, for presence markers. */
  others?: ReadonlyMap<string, string[]>;
  /** Open comment threads per item id. */
  commentCounts?: ReadonlyMap<string, number>;
  /** Opens the question library to insert after (or inside) a row. */
  onInsertFromLibrary?(afterId: string | null, inside: boolean): void;
  /** Saves a row (not a section) to the question library. */
  onSaveToLibrary?(id: string): void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // One menu at a time: the question types, the structural elements, or a row's actions.
  const [menu, setMenu] = useState<{
    mode: 'question' | 'structure' | 'row';
    at: { x: number; y: number };
  } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const treeRef = useRef<HTMLUListElement>(null);
  const addQuestionRef = useRef<HTMLButtonElement>(null);
  const addStructureRef = useRef<HTMLButtonElement>(null);

  const rows = useMemo(() => flatten(draft, collapsed), [draft, collapsed]);
  const ids = [SETTINGS_ID, ...rows.map((r) => r.node.id)];

  // Skip arcs: from the skipping item to its target, or to the nearest visible ancestor
  // when the target is inside a collapsed block; END lands below the last row.
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.node.id)), [rows]);
  const arcs = useMemo(() => {
    if (!routing) return [];
    const visibleFor = (id: string): string | null => {
      for (let cur: string | null = id; cur; cur = routing.byId.get(cur)?.parentId ?? null)
        if (visibleIds.has(cur)) return cur;
      return null;
    };
    const out: { from: string; to: string; label: string }[] = [];
    for (const n of routing.nodes)
      for (const sk of n.skips) {
        const from = visibleFor(n.id);
        const to =
          sk.target === 'END'
            ? '__end'
            : typeof sk.target === 'number'
              ? visibleFor(routing.nodes[sk.target]!.id)
              : null;
        if (from && to && from !== to)
          out.push({
            from,
            to,
            label: `${n.name ?? n.id} → ${sk.to}: ${routing.describe(sk.ast, sk.src)}`,
          });
      }
    return out;
  }, [routing, visibleIds]);
  const order = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i])), [rows]);
  const lanes = useMemo(
    () =>
      assignLanes(
        arcs.map((a) => ({ from: order.get(a.from)!, to: order.get(a.to) ?? rows.length })),
      ),
    [arcs, order, rows.length],
  );
  const gutter = arcs.length ? 10 + (Math.max(...lanes) + 1) * 9 : 0;
  const [rowY, setRowY] = useState<Record<string, number>>({});
  const [hot, setHot] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el || !arcs.length) return;
    const measure = () => {
      const y: Record<string, number> = {};
      let last = 0;
      el.querySelectorAll<HTMLElement>('[data-id]').forEach((li) => {
        y[li.dataset.id!] = li.offsetTop + li.offsetHeight / 2;
        last = li.offsetTop + li.offsetHeight;
      });
      y.__end = last + 6;
      setRowY(y);
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [arcs, rows]);
  const index = Math.max(0, ids.indexOf(selected));

  // Drag and drop: the top or bottom quarter of a row drops before or after it, the middle of a
  // section, block or roster drops at the end of its items. Invalid places show no marker.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; zone: DropZone } | null>(null);
  const zoneFor = (e: { clientY: number; currentTarget: HTMLElement }, node: TreeNode) => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = box.height ? (e.clientY - box.top) / box.height : 0;
    if ('items' in node) return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside';
    return f < 0.5 ? 'before' : 'after';
  };
  const placeFor = (id: string, zone: DropZone) => {
    if (!dragId || dragId === id) return null;
    const place = dropPlace(draft, id, zone);
    return place && canMoveTo(draft, dragId, place.parentId) ? place : null;
  };
  const endDrag = () => {
    setDragId(null);
    setDropAt(null);
  };

  // Keep keyboard focus on the selected row after it moves.
  useEffect(() => {
    if (!focusTick) return;
    const rowsEls = treeRef.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [];
    [...rowsEls].find((el) => el.dataset.id === selected)?.focus();
  }, [focusTick, selected]);

  const go = (id: string | undefined) => {
    if (!id) return;
    onSelect(id);
    setFocusTick((n) => n + 1);
  };

  const structural = (next: Draft, focusId = selected) => {
    change(next);
    onSelect(focusId);
    setFocusTick((n) => n + 1);
  };

  const target = () => {
    const after = selected === SETTINGS_ID ? null : selected;
    const row = rows.find((r) => r.node.id === after);
    const inside =
      !!row &&
      !isSection(row.node) &&
      (row.node.kind === 'block' || row.node.kind === 'roster') &&
      !collapsed.has(row.node.id);
    return { after, inside };
  };

  const rowEl = (id: string) =>
    [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].find(
      (el) => el.dataset.id === id,
    ) ?? null;
  const closeMenu = () => {
    setMenu(null);
    setFocusTick((n) => n + 1);
  };

  const add = (what: NewKind) => {
    setMenu(null);
    const { after, inside } = target();
    const r = insert(draft, after, what, { inside });
    structural(r.draft, r.newId);
    announce(t('designer.outline.added', { name: r.newId }));
  };

  const selectedRow = rows.find((r) => r.node.id === selected);
  const selectedNode = selectedRow?.node;
  const del = (node: TreeNode) => {
    const next = remove(draft, node.id);
    if (next !== draft && JSON.stringify(next) !== JSON.stringify(draft)) {
      structural(next, ids[ids.indexOf(node.id) - 1]!);
      announce(t('designer.outline.deleted', { name: nodeName(node) }));
    }
  };
  const dup = (node: TreeNode) => {
    const r = duplicate(draft, node.id);
    if (r.newId) structural(r.draft, r.newId);
  };

  const libraryEntry: MenuEntry[] = onInsertFromLibrary
    ? [
        { type: 'separator' },
        {
          type: 'item',
          id: 'library',
          label: t('designer.library.insert'),
          icon: <KindIcon k="block" />,
          onSelect: () => {
            const { after, inside } = target();
            onInsertFromLibrary(after, inside);
          },
        },
      ]
    : [];

  // The row's actions, each also reachable from the keyboard (shortcut shown).
  const rowEntries: MenuEntry[] = selectedNode
    ? [
        {
          type: 'item',
          id: 'edit',
          label: t('designer.outline.menuEdit'),
          shortcut: 'Enter',
          onSelect: onEnter,
        },
        ...(readOnly
          ? []
          : ([
              {
                type: 'item',
                id: 'addq',
                label: t('designer.outline.menuAddQuestion'),
                shortcut: 'Insert',
                keepOpen: true,
                onSelect: () => setMenu((m) => (m ? { ...m, mode: 'question' } : m)),
              },
              {
                type: 'item',
                id: 'adds',
                label: t('designer.outline.menuAddStructure'),
                shortcut: 'Shift+Insert',
                keepOpen: true,
                onSelect: () => setMenu((m) => (m ? { ...m, mode: 'structure' } : m)),
              },
              ...libraryEntry.slice(1),
              { type: 'separator' },
              {
                type: 'item',
                id: 'rename',
                label: t('designer.outline.menuRename'),
                shortcut: 'F2',
                onSelect: onRename,
              },
              {
                type: 'item',
                id: 'dup',
                label: t('designer.outline.menuDuplicate'),
                shortcut: 'Ctrl+D',
                onSelect: () => dup(selectedNode),
              },
              ...(onSaveToLibrary && !isSection(selectedNode)
                ? [
                    {
                      type: 'item' as const,
                      id: 'save',
                      label: t('designer.outline.menuSaveLibrary'),
                      onSelect: () => onSaveToLibrary(selectedNode.id),
                    },
                  ]
                : []),
              { type: 'separator' },
              {
                type: 'item',
                id: 'up',
                label: t('designer.outline.menuUp'),
                shortcut: 'Alt+↑',
                onSelect: () => structural(move(draft, selectedNode.id, -1)),
              },
              {
                type: 'item',
                id: 'down',
                label: t('designer.outline.menuDown'),
                shortcut: 'Alt+↓',
                onSelect: () => structural(move(draft, selectedNode.id, 1)),
              },
              ...(!isSection(selectedNode)
                ? [
                    {
                      type: 'item' as const,
                      id: 'indent',
                      label: t('designer.outline.menuIndent'),
                      shortcut: 'Alt+→',
                      onSelect: () => structural(indent(draft, selectedNode.id)),
                    },
                    {
                      type: 'item' as const,
                      id: 'outdent',
                      label: t('designer.outline.menuOutdent'),
                      shortcut: 'Alt+←',
                      onSelect: () => structural(outdent(draft, selectedNode.id)),
                    },
                  ]
                : []),
              { type: 'separator' },
              {
                type: 'item',
                id: 'delete',
                label: t('designer.outline.menuDelete'),
                shortcut: t('designer.outline.keyDelete'),
                onSelect: () => del(selectedNode),
              },
            ] as MenuEntry[])),
      ]
    : [];

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const row = rows[index - 1];
    const node = row?.node;
    const container = !!node && 'items' in node;
    const key = e.key;
    let handled = true;
    if (e.altKey && !readOnly && node) {
      if (key === 'ArrowUp') structural(move(draft, node.id, -1));
      else if (key === 'ArrowDown') structural(move(draft, node.id, 1));
      else if (key === 'ArrowRight') structural(indent(draft, node.id));
      else if (key === 'ArrowLeft') structural(outdent(draft, node.id));
      else handled = false;
    } else if (key === 'ArrowDown') go(ids[index + 1]);
    else if (key === 'ArrowUp') go(ids[index - 1]);
    else if (key === 'Home') go(ids[0]);
    else if (key === 'End') go(ids.at(-1));
    else if (key === 'ArrowRight' && node && container) {
      if (collapsed.has(node.id)) setCollapsed((c) => new Set([...c].filter((x) => x !== node.id)));
      else go(ids[index + 1]);
    } else if (key === 'ArrowLeft' && node) {
      if (container && !collapsed.has(node.id)) setCollapsed((c) => new Set(c).add(node.id));
      else if (row.parentId) go(row.parentId);
    } else if (key === 'Enter') onEnter();
    else if (key === 'F2' && node) onRename();
    else if (((key === 'F10' && e.shiftKey) || key === 'ContextMenu') && node)
      setMenu({ mode: 'row', at: below(rowEl(node.id)) });
    else if (readOnly) handled = false;
    else if (key === 'Insert' || (key === '+' && !e.ctrlKey))
      setMenu({
        mode: e.shiftKey ? 'structure' : 'question',
        at: below(rowEl(selected)),
      });
    else if ((key === 'Delete' || key === 'Backspace') && node) del(node);
    else if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'd' && node) dup(node);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="relative flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="outline-h" className="font-semibold">
          {t('designer.outline.title')}
        </h2>
        {!readOnly ? (
          <div className="flex gap-1">
            <button
              ref={addQuestionRef}
              type="button"
              className={`${smallBtn} inline-flex items-center gap-1`}
              aria-label={t('designer.outline.addQuestionLabel')}
              aria-haspopup="menu"
              aria-expanded={menu?.mode === 'question'}
              onClick={() =>
                setMenu((m) =>
                  m?.mode === 'question'
                    ? null
                    : { mode: 'question', at: below(addQuestionRef.current) },
                )
              }
            >
              <span aria-hidden>+</span> {t('designer.outline.addQuestion')}
            </button>
            <button
              ref={addStructureRef}
              type="button"
              className={`${smallBtn} inline-flex items-center gap-1`}
              aria-label={t('designer.outline.addStructureLabel')}
              aria-haspopup="menu"
              aria-expanded={menu?.mode === 'structure'}
              onClick={() =>
                setMenu((m) =>
                  m?.mode === 'structure'
                    ? null
                    : { mode: 'structure', at: below(addStructureRef.current) },
                )
              }
            >
              <span aria-hidden>+</span> {t('designer.outline.addStructure')}
            </button>
          </div>
        ) : null}
      </div>
      {menu ? (
        <Menu
          label={
            menu.mode === 'row'
              ? t('designer.outline.menu', { name: selectedNode ? nodeName(selectedNode) : '' })
              : menu.mode === 'question'
                ? t('designer.outline.addQuestionLabel')
                : t('designer.outline.addStructureLabel')
          }
          entries={
            menu.mode === 'question'
              ? [...questionMenu(t, (type) => add({ kind: 'question', type })), ...libraryEntry]
              : menu.mode === 'structure'
                ? structureMenu(t, add)
                : rowEntries
          }
          at={menu.at}
          onClose={closeMenu}
        />
      ) : null}
      <div
        className="relative lg:pl-[var(--gutter)]"
        style={{ '--gutter': `${gutter}px` } as CSSProperties}
      >
        {arcs.length ? (
          <svg
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 hidden h-full overflow-visible lg:block"
            style={{ width: gutter }}
            data-testid="outline-arcs"
          >
            {arcs.map((a, i) => {
              const y0 = rowY[a.from];
              const y1 = rowY[a.to];
              if (y0 === undefined || y1 === undefined) return null;
              const x = gutter;
              const bulge = 8 + lanes[i]! * 9;
              const on = hot !== null && (a.from === hot || a.to === hot);
              return (
                <path
                  key={i}
                  d={`M ${x} ${y0} C ${x - bulge} ${y0}, ${x - bulge} ${y1}, ${x - 1} ${y1}`}
                  fill="none"
                  stroke="currentColor"
                  className={on ? 'text-indigo-ink-700' : 'text-slate-400'}
                  strokeWidth={on ? 2 : 1.25}
                  markerEnd="url(#ol-arrow)"
                >
                  <title>{a.label}</title>
                </path>
              );
            })}
            <defs>
              <marker
                id="ol-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            </defs>
          </svg>
        ) : null}
        <ul
          onMouseOver={(e) =>
            setHot((e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id ?? null)
          }
          onMouseLeave={() => setHot(null)}
          onFocus={(e) => setHot((e.target as HTMLElement).dataset.id ?? null)}
          ref={treeRef}
          role="tree"
          aria-labelledby="outline-h"
          aria-describedby="outline-keys"
          className="flex flex-col rounded-md border border-slate-200 bg-white py-1 text-sm"
          onKeyDown={onKey}
        >
          <li
            role="treeitem"
            aria-level={1}
            aria-selected={selected === SETTINGS_ID}
            tabIndex={selected === SETTINGS_ID ? 0 : -1}
            data-id={SETTINGS_ID}
            className="cursor-pointer px-2 py-1 font-medium aria-selected:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
            onClick={() => go(SETTINGS_ID)}
            onFocus={() => selected !== SETTINGS_ID && onSelect(SETTINGS_ID)}
          >
            ⚙ {t('designer.settings.title')}
          </li>
          {rows.map(({ node, depth }) => {
            const container = 'items' in node;
            const errors = errorsById.get(node.id) ?? 0;
            const label = nodeLabel(node, lang);
            return (
              <li
                key={node.id}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={selected === node.id}
                aria-expanded={container ? !collapsed.has(node.id) : undefined}
                tabIndex={selected === node.id ? 0 : -1}
                data-id={node.id}
                data-testid="outline-item"
                className={`flex cursor-pointer items-center gap-1.5 py-1 pr-2 aria-selected:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 data-[drop=after]:shadow-[inset_0_-2px_0_0_#4338ca] data-[drop=before]:shadow-[inset_0_2px_0_0_#4338ca] data-[drop=inside]:bg-indigo-50 data-[drop=inside]:ring-2 data-[drop=inside]:ring-inset data-[drop=inside]:ring-indigo-400 ${dragId === node.id ? 'opacity-50' : ''}`}
                style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
                onClick={() => go(node.id)}
                onFocus={() => selected !== node.id && onSelect(node.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  go(node.id);
                  setMenu({ mode: 'row', at: { x: e.clientX, y: e.clientY } });
                }}
                draggable={!readOnly}
                title={readOnly ? undefined : t('designer.outline.drag', { name: nodeName(node) })}
                data-drop={dropAt?.id === node.id ? dropAt.zone : undefined}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', node.id);
                  setDragId(node.id);
                }}
                onDragOver={(e) => {
                  const zone = zoneFor(e, node);
                  if (!placeFor(node.id, zone)) return setDropAt(null);
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dropAt?.id !== node.id || dropAt.zone !== zone)
                    setDropAt({ id: node.id, zone });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const moving = dragId;
                  const place = placeFor(node.id, zoneFor(e, node));
                  endDrag();
                  if (!moving || !place) return;
                  const moved = locate(draft, moving)?.node;
                  structural(moveTo(draft, moving, place.parentId, place.index), moving);
                  if (moved) announce(t('designer.outline.moved', { name: nodeName(moved) }));
                }}
                onDragEnd={endDrag}
              >
                {container ? (
                  <span aria-hidden className="w-3 text-slate-500">
                    {collapsed.has(node.id) ? '▸' : '▾'}
                  </span>
                ) : (
                  <span aria-hidden className="w-3" />
                )}
                <span aria-hidden className="flex w-6 shrink-0 justify-center text-slate-600">
                  <KindIcon k={iconKeyOf(node)} className="size-3.5" />
                </span>
                <span className={`shrink-0 font-mono ${isSection(node) ? 'font-semibold' : ''}`}>
                  {nodeName(node)}
                </span>
                <span className="truncate text-slate-600">{label}</span>
                <LogicBadges id={node.id} routing={routing} />
                {others?.get(node.id)?.length ? (
                  <span
                    role="img"
                    aria-label={others.get(node.id)!.join(', ')}
                    title={others.get(node.id)!.join(', ')}
                    className="shrink-0 rounded-full bg-sky-800 px-1.5 text-[10px] font-semibold text-on-fill"
                    data-testid="presence-marker"
                  >
                    {others
                      .get(node.id)!
                      .map((n) => initials(n))
                      .join(' ')}
                  </span>
                ) : null}
                {commentCounts?.get(node.id) ? (
                  <span
                    role="img"
                    aria-label={t('designer.comments.badge', { count: commentCounts.get(node.id) })}
                    title={t('designer.comments.badge', { count: commentCounts.get(node.id) })}
                    className="shrink-0 rounded bg-amber-100 px-1 text-xs text-amber-ink-900"
                    data-testid="comment-badge"
                  >
                    💬{commentCounts.get(node.id)}
                  </span>
                ) : null}
                {errors ? (
                  <span className="ml-auto shrink-0 rounded bg-red-100 px-1.5 text-xs text-red-ink-900">
                    {t('designer.outline.errors', { count: errors })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <p id="outline-keys" className="text-xs text-slate-600">
        {readOnly ? t('designer.outline.keysReadOnly') : t('designer.outline.keys')}
      </p>
    </div>
  );
}

/** "Ana María" → "AM". */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

/** Small marks for the logic attached to an item, each described for screen readers. */
function LogicBadges({ id, routing }: { id: string; routing: Routing | null }) {
  const { t } = useTranslation();
  const n = routing?.byId.get(id);
  if (!n || !routing) return null;
  const marks: { sym: string; label: string; cls: string; key: string }[] = [];
  if (n.showIf)
    marks.push({
      key: 'if',
      sym: '◇',
      cls: 'text-violet-ink-800',
      label: t('designer.badge.conditional', {
        text: routing.describe(n.showIf.ast, n.showIf.src),
      }),
    });
  if (n.skips.length)
    marks.push({
      key: 'skip',
      sym: n.skips.length > 1 ? `↷${n.skips.length}` : '↷',
      cls: 'text-slate-700',
      label: t('designer.badge.skips', {
        text: n.skips.map((s) => `${s.to}: ${routing.describe(s.ast, s.src)}`).join('; '),
      }),
    });
  if (n.ends.length)
    marks.push({
      key: 'end',
      sym: '⏹',
      cls: 'text-red-ink-700',
      label: t('designer.badge.ends', {
        text: n.ends
          .map((e) => `${dispositionLabel(t, e.disposition)}: ${routing.describe(e.ast, e.src)}`)
          .join('; '),
      }),
    });
  const checks = n.checks.errors + n.checks.warnings;
  if (checks)
    marks.push({
      key: 'chk',
      sym: '✓',
      cls: 'text-emerald-ink-800',
      label: t('designer.badge.checks', { count: checks }),
    });
  if (n.hasPrefill || n.hasFilter)
    marks.push({
      key: 'fx',
      sym: 'ƒ',
      cls: 'text-sky-ink-800',
      label: t('designer.badge.computed'),
    });
  if (!marks.length) return null;
  return (
    <span className="ml-auto flex shrink-0 gap-1 text-xs" data-testid="logic-badges">
      {marks.map((m) => (
        <span key={m.key} className={m.cls} title={m.label} role="img" aria-label={m.label}>
          {m.sym}
        </span>
      ))}
    </span>
  );
}
