import { useRef, useState, type ReactNode } from 'react';
import { below, Menu, type MenuCloseReason, type MenuEntry } from '../designer/Menu.js';

export type { MenuEntry } from '../designer/Menu.js';

/**
 * MoreMenu («⋯»): a button that opens a menu of secondary actions, for a row of a list (edit,
 * duplicate, delete…) or for a toolbar (rarely used tools), so they do not take a column or a
 * line of their own.
 *
 * It is the app's popup `Menu` (designer/Menu.tsx, the questionnaire and user actions) behind a
 * button: the button says `aria-haspopup="menu"` and `aria-expanded`; in the menu the arrow
 * keys, Home/End and the first letter move, Enter or Space picks, Escape closes; picking or
 * Escape puts the focus back on the button.
 *
 * Entries are `MenuEntry` items: `{ type: 'item', id, label, onSelect }` (with `disabled`,
 * `hint`, `icon` if needed), groups and separators.
 *
 *   // One per row: a bare "⋯" named after the row.
 *   <MoreMenu label={t('team.actions', { name: m.name })} entries={entriesFor(m)} />
 *
 *   // In a toolbar, with visible text (the name starts with it).
 *   <MoreMenu label={t('cases.list.moreTools')} entries={tools}>
 *     <span aria-hidden="true">⋯</span> {t('ui.more')}
 *   </MoreMenu>
 *
 * Renders nothing when there are no entries.
 */
export function MoreMenu({
  label,
  entries,
  children,
  className = '',
  unstyled = false,
  minWidth,
}: {
  /**
   * Names the button and the menu. With visible text (`children`), start it with that text
   * ("More tools of the case list" for "⋯ More"), so speech users can say what they see.
   */
  label: string;
  entries: MenuEntry[];
  /** The button's visible content; a bare "⋯" when left out. */
  children?: ReactNode;
  className?: string;
  /** `className` is the button's whole look (the default one is left out). */
  unstyled?: boolean;
  minWidth?: number;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!entries.length) return null;
  const close = (reason?: MenuCloseReason) => {
    setAt(null);
    // A pick or Escape returns to the button; a click elsewhere leaves the focus there.
    if (reason === 'select' || reason === 'escape') button.current?.focus();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label={label}
        title={children ? undefined : label}
        data-more-menu=""
        className={
          unstyled
            ? className
            : `inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm font-semibold text-navy hover:border-indigo-600 hover:text-indigo-ink-600 aria-expanded:border-indigo-600 ${className}`
        }
        // While open, the menu's own "click outside" would close it and this click reopen it.
        onMouseDown={(e) => {
          if (at) e.stopPropagation();
        }}
        onClick={(e) => setAt(at ? null : below(e.currentTarget))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !at) {
            e.preventDefault();
            setAt(below(e.currentTarget));
          }
        }}
      >
        {children ?? (
          <span aria-hidden="true" className="px-0.5 leading-none">
            ⋯
          </span>
        )}
      </button>
      {at ? (
        <Menu label={label} entries={entries} at={at} onClose={close} minWidth={minWidth} />
      ) : null}
    </>
  );
}
