import { QUESTION_TYPES } from '@wansurvey/schema';
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
import {
  duplicate,
  flatten,
  indent,
  insert,
  isSection,
  move,
  outdent,
  remove,
  type Draft,
  type NewKind,
  type TreeNode,
} from './tree.js';
import { assignLanes, type Routing } from './useRouting.js';
import { nodeLabel, nodeName } from './vars.js';

export const SETTINGS_ID = '__settings';

const NEW_KINDS: NewKind[] = [
  ...QUESTION_TYPES.map((type) => ({ kind: 'question' as const, type })),
  { kind: 'static' },
  { kind: 'computed' },
  { kind: 'pagebreak' },
  { kind: 'block' },
  { kind: 'roster' },
  { kind: 'section' },
];

const kindKey = (k: NewKind) =>
  k.kind === 'question' ? `designer.type.${k.type}` : `designer.kind.${k.kind}`;

function badge(node: TreeNode): string {
  if (isSection(node)) return '§';
  switch (node.kind) {
    case 'question':
      return (
        {
          single: '◉',
          multi: '☑',
          numeric: '#',
          text: 'Aa',
          date: '📅',
          time: '⏱',
          datetime: '📅',
          grid: '▦',
          ranking: '⇅',
          scale: '⋯',
          yesno: 'Y/N',
        } as const
      )[node.type];
    case 'static':
      return 'ℹ';
    case 'computed':
      return 'ƒ';
    case 'pagebreak':
      return '—';
    case 'block':
      return '▢';
    case 'roster':
      return '↻';
  }
}

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
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const treeRef = useRef<HTMLUListElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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

  // Keep keyboard focus on the selected row after it moves.
  useEffect(() => {
    if (!focusTick) return;
    const rowsEls = treeRef.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [];
    [...rowsEls].find((el) => el.dataset.id === selected)?.focus();
  }, [focusTick, selected]);

  useEffect(() => {
    if (picker) pickerRef.current?.querySelector('button')?.focus();
  }, [picker]);

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

  const add = (what: NewKind) => {
    setPicker(false);
    const after = selected === SETTINGS_ID ? null : selected;
    const row = rows.find((r) => r.node.id === after);
    const inside =
      !!row &&
      !isSection(row.node) &&
      (row.node.kind === 'block' || row.node.kind === 'roster') &&
      !collapsed.has(row.node.id);
    const r = insert(draft, after, what, { inside });
    structural(r.draft, r.newId);
    announce(t('designer.outline.added', { name: r.newId }));
  };

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
    else if (readOnly) handled = false;
    else if (key === 'Insert' || (key === '+' && !e.ctrlKey)) setPicker(true);
    else if ((key === 'Delete' || key === 'Backspace') && node) {
      const next = remove(draft, node.id);
      if (next !== draft && JSON.stringify(next) !== JSON.stringify(draft)) {
        structural(next, ids[index - 1]!);
        announce(t('designer.outline.deleted', { name: nodeName(node) }));
      }
    } else if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'd' && node) {
      const r = duplicate(draft, node.id);
      if (r.newId) structural(r.draft, r.newId);
    } else handled = false;
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
          <button
            type="button"
            className={smallBtn}
            aria-haspopup="true"
            aria-expanded={picker}
            onClick={() => setPicker((p) => !p)}
          >
            {t('designer.outline.add')}
          </button>
        ) : null}
      </div>
      {picker ? (
        <div
          ref={pickerRef}
          role="group"
          aria-label={t('designer.outline.pickType')}
          className="absolute right-0 top-9 z-10 grid w-64 grid-cols-2 gap-1 rounded-md border border-slate-300 bg-white p-2 shadow-lg"
          onKeyDown={(e) => {
            const buttons = [...(pickerRef.current?.querySelectorAll('button') ?? [])];
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') {
              e.preventDefault();
              setPicker(false);
              setFocusTick((n) => n + 1);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
              e.preventDefault();
              buttons[(i + 1) % buttons.length]?.focus();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
              e.preventDefault();
              buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
            }
          }}
        >
          {NEW_KINDS.map((k) => (
            <button
              key={kindKey(k)}
              type="button"
              className="rounded px-2 py-1 text-left text-sm hover:bg-indigo-50 focus:bg-indigo-50"
              onClick={() => add(k)}
            >
              {t(kindKey(k))}
            </button>
          ))}
        </div>
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
                  className={on ? 'text-indigo-700' : 'text-slate-400'}
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
                className="flex cursor-pointer items-center gap-1.5 py-1 pr-2 aria-selected:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
                onClick={() => go(node.id)}
                onFocus={() => selected !== node.id && onSelect(node.id)}
              >
                {container ? (
                  <span aria-hidden className="w-3 text-slate-500">
                    {collapsed.has(node.id) ? '▸' : '▾'}
                  </span>
                ) : (
                  <span aria-hidden className="w-3" />
                )}
                <span aria-hidden className="w-6 shrink-0 text-center text-xs text-slate-600">
                  {badge(node)}
                </span>
                <span className={`shrink-0 font-mono ${isSection(node) ? 'font-semibold' : ''}`}>
                  {nodeName(node)}
                </span>
                <span className="truncate text-slate-600">{label}</span>
                <LogicBadges id={node.id} routing={routing} />
                {errors ? (
                  <span className="ml-auto shrink-0 rounded bg-red-100 px-1.5 text-xs text-red-900">
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
      cls: 'text-violet-800',
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
      cls: 'text-red-700',
      label: t('designer.badge.ends', {
        text: n.ends.map((e) => `${e.disposition}: ${routing.describe(e.ast, e.src)}`).join('; '),
      }),
    });
  const checks = n.checks.errors + n.checks.warnings;
  if (checks)
    marks.push({
      key: 'chk',
      sym: '✓',
      cls: 'text-emerald-800',
      label: t('designer.badge.checks', { count: checks }),
    });
  if (n.hasPrefill || n.hasFilter)
    marks.push({ key: 'fx', sym: 'ƒ', cls: 'text-sky-800', label: t('designer.badge.computed') });
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
