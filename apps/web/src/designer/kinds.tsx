import type { QuestionType } from '@wansurvey/schema';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import type { MenuEntry } from './Menu.js';
import { isSection, type NewKind, type TreeNode } from './tree.js';

type IconKey = QuestionType | Exclude<NewKind['kind'], 'question'>;

/** One stroke icon per question type and structural element (the outline uses them too). */
const PATHS: Record<IconKey, ReactNode> = {
  single: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
  multi: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12.5 3 3 5-6.5" />
    </>
  ),
  yesno: (
    <>
      <rect x="2.5" y="7" width="19" height="10" rx="5" />
      <circle cx="16.5" cy="12" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  ranking: (
    <>
      <path d="M10 6h11M10 12h11M10 18h11" />
      <path d="M4 4.5h1.5V9M3.5 9h3.5M3.5 14.5c1-1.2 3.5-1 3.3.6-.2 1.2-3.3 2.4-3.3 3.4h3.5" />
    </>
  ),
  scale: (
    <>
      <path d="M3 17h18" />
      <path d="M5 17v-3M9.5 17v-6M14.5 17v-9M19 17v-12" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3.5" width="18" height="17" rx="2" />
      <path d="M3 9.5h18M3 15h18M9 3.5v17M15 3.5v17" />
    </>
  ),
  text: <path d="M5 7V4.5h14V7M9.5 19.5h5M12 4.5v15" />,
  numeric: <path d="M5 9h15M4 15h15M10.5 3.5 8.5 20.5M15.5 3.5l-2 17" />,
  date: (
    <>
      <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
      <path d="M16 2.5v4M8 2.5v4M3.5 10h17M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" />
    </>
  ),
  time: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  datetime: (
    <>
      <path d="M20.5 9.5V6.5a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M16 2.5v4M8 2.5v4M3.5 10h6" />
      <circle cx="16.5" cy="16.5" r="4.5" />
      <path d="M16.5 14.5v2l1.3 1" />
    </>
  ),
  static: (
    <>
      <path d="M4 5.5h16v10H9l-4.5 4v-4H4z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
  computed: (
    <>
      <rect x="4.5" y="2.5" width="15" height="19" rx="2" />
      <path d="M8 6.5h8M8 11h.01M12 11h.01M16 11h.01M8 14.5h.01M12 14.5h.01M16 14.5h.01M8 18h.01M12 18h4" />
    </>
  ),
  pagebreak: <path d="M5 3.5v5h14v-5M5 20.5v-5h14v5M3 12h2.5M9 12h2.5M15 12h2.5M21 12h.5" />,
  block: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="3 2.2" />
      <path d="M8 9h8M8 12.5h8M8 16h5" />
    </>
  ),
  roster: (
    <>
      <path d="m16.5 2.5 3.5 3.5-3.5 3.5" />
      <path d="M4 11V10a4 4 0 0 1 4-4h12" />
      <path d="m7.5 21.5-3.5-3.5 3.5-3.5" />
      <path d="M20 13v1a4 4 0 0 1-4 4H4" />
    </>
  ),
  section: <path d="M4 5v14M12 5v14M4 12h8M16.5 9.5 19.5 7v12" />,
};

export function KindIcon({ k, className = 'size-4' }: { k: IconKey; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {PATHS[k]}
    </svg>
  );
}

export const iconKeyOf = (node: TreeNode): IconKey =>
  isSection(node) ? 'section' : node.kind === 'question' ? node.type : node.kind;

export const iconKeyOfKind = (k: NewKind): IconKey => (k.kind === 'question' ? k.type : k.kind);

/** Question types in the order and groups every picker shows them. */
export const QUESTION_GROUPS: { key: string; types: QuestionType[] }[] = [
  { key: 'choice', types: ['single', 'multi', 'yesno', 'ranking'] },
  { key: 'scales', types: ['scale', 'grid'] },
  { key: 'open', types: ['text', 'numeric'] },
  { key: 'dates', types: ['date', 'time', 'datetime'] },
];

/** Organisation and plain-text elements (the "add structure" button). */
export const STRUCTURE_GROUPS: { key: string; kinds: Exclude<NewKind['kind'], 'question'>[] }[] = [
  { key: 'organise', kinds: ['section', 'block', 'roster', 'pagebreak'] },
  { key: 'texts', kinds: ['static', 'computed'] },
];

/** Menu entries for the question types, grouped; `current` marks the chosen one. */
export function questionMenu(
  t: TFunction,
  onPick: (type: QuestionType) => void,
  current?: QuestionType,
): MenuEntry[] {
  return QUESTION_GROUPS.map((g) => ({
    type: 'group' as const,
    label: t(`designer.kindGroups.${g.key}`),
    items: g.types.map((type) => ({
      type: 'item' as const,
      id: type,
      label: t(`designer.type.${type}`),
      hint: t(`designer.typeHints.${type}`),
      icon: <KindIcon k={type} />,
      ...(current !== undefined ? { checked: current === type } : {}),
      onSelect: () => onPick(type),
    })),
  }));
}

/** Menu entries for sections, blocks, rosters, page breaks, texts and computed variables. */
export function structureMenu(t: TFunction, onPick: (k: NewKind) => void): MenuEntry[] {
  return STRUCTURE_GROUPS.map((g) => ({
    type: 'group' as const,
    label: t(`designer.kindGroups.${g.key}`),
    items: g.kinds.map((kind) => ({
      type: 'item' as const,
      id: kind,
      label: t(`designer.kind.${kind}`),
      hint: t(`designer.kindHints.${kind}`),
      icon: <KindIcon k={kind} />,
      onSelect: () => onPick({ kind } as NewKind),
    })),
  }));
}
