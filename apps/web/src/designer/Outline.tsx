import { QUESTION_TYPES } from '@wansurvey/schema';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
      <ul
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
              {errors ? (
                <span className="ml-auto shrink-0 rounded bg-red-100 px-1.5 text-xs text-red-900">
                  {t('designer.outline.errors', { count: errors })}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p id="outline-keys" className="text-xs text-slate-600">
        {readOnly ? t('designer.outline.keysReadOnly') : t('designer.outline.keys')}
      </p>
    </div>
  );
}
