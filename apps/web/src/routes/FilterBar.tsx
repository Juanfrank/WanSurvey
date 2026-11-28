import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from './icons.js';

/** One filter that is on, shown as a chip under the search: "Status: Assigned ✕". */
export interface ActiveFilter {
  /** Stable key (the filter's name). */
  id: string;
  /** What is filtered: "Status". */
  label: string;
  /** The value chosen: "Assigned". */
  value: string;
  /** Turns this filter off. */
  onRemove(): void;
}

/**
 * FilterBar: the one line above a list that holds its search, its filters and its tools.
 *
 *   [ Search…          ] [⚲ Filters · 2 ▾] (Status: Assigned ✕) (Team: North ✕)   12 cases  [tools]
 *
 * - The search is always in view. Its label is the placeholder and the field's accessible name
 *   (`aria-label`), so it needs no line of its own.
 * - The other filters (selects, quick toggles) go in `children`: they show in a panel that
 *   floats over the list when the "Filters" button is pressed, without pushing the list down.
 *   Lay them out as usual (`<label>` + control); the panel wraps them in a row. Each keeps the
 *   state it already had in the screen: the bar only shows and hides them.
 * - Each filter that is on is a chip (`active`) with a button to remove it ("Remove filter:
 *   Status Assigned"); the button says how many are on ("Filters · 2").
 * - `count` (the number of results, live) and `actions` (buttons, a `MoreMenu`) sit on the right.
 *
 * The panel: the button has `aria-expanded` and `aria-controls`; on opening, the focus goes to
 * the panel's first control; Escape closes it and returns to the button; so does pressing the
 * button again; a click outside closes it (the focus goes where the click went). Under 640 px
 * the panel takes the whole width.
 *
 *   <FilterBar
 *     search={{ value: q, onChange: setQ, label: t('team.search') }}
 *     active={status ? [{ id: 'status', label: t('team.status'), value: t(`team.s.${status}`),
 *       onRemove: () => setStatus('') }] : []}
 *     count={t('team.count', { count: rows.length })}
 *     actions={<Button onClick={invite}>{t('team.invite.open')}</Button>}
 *   >
 *     <label className="flex flex-col gap-1 text-sm">
 *       <span className="font-medium">{t('team.status')}</span>
 *       <select value={status} onChange={(e) => setStatus(e.target.value)}>…</select>
 *     </label>
 *   </FilterBar>
 *
 * Without `children` there is no Filters button (a search alone).
 *
 * `lead`: the one filter used most, kept in view before the Filters button (the review queue's
 * Status). It is a control of its own, with its visible label; it gets no chip.
 */
export function FilterBar({
  search,
  lead,
  active = [],
  activeCount,
  count,
  actions,
  children,
  panelLabel,
  className = '',
}: {
  search?: {
    value: string;
    onChange(value: string): void;
    /** The field's name, shown as its placeholder. */
    label: string;
    /** Width class of the field (default: 20 rem, the whole width on a phone). */
    className?: string;
  };
  /** A filter kept in view, before the Filters button (label + control). */
  lead?: ReactNode;
  /** The filters that are on, as chips. */
  active?: ActiveFilter[];
  /** The number on the button, when it is not the number of chips. */
  activeCount?: number;
  /** The number of results, announced politely when it changes. */
  count?: ReactNode;
  /** Buttons on the right of the line. */
  actions?: ReactNode;
  /** The filter controls, shown in the floating panel. */
  children?: ReactNode;
  /** Names the panel (default "Filters"). */
  panelLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const panelId = `${id}-filters`;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const on = activeCount ?? active.length;

  const chips = useRef<HTMLUListElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // After a chip goes, the focus moves to the chip now in its place, or to the Filters button.
  const removed = (index: number) =>
    requestAnimationFrame(() => {
      const left = [...(chips.current?.querySelectorAll<HTMLElement>('[data-chip] button') ?? [])];
      (left[Math.min(index, left.length - 1)] ?? button.current ?? searchInput.current)?.focus();
    });

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // On opening, the focus goes into the panel.
  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel.current)?.focus();
  }, [open]);

  // A click (or touch) outside the panel and its button closes it.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
      // If the click lands on nothing that takes the focus, it would be lost with the panel.
      setTimeout(() => {
        if (document.activeElement === document.body) button.current?.focus();
      }, 0);
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);

  return (
    <div className={`relative flex flex-wrap items-center gap-2 ${className}`} data-filter-bar="">
      {search ? (
        <input
          ref={searchInput}
          type="search"
          aria-label={search.label}
          placeholder={search.label}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          className={`min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${search.className ?? 'w-full sm:w-80'}`}
        />
      ) : null}
      {lead}
      {children ? (
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          data-filters-button=""
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-semibold hover:border-indigo-600 hover:text-indigo-ink-600 ${
            on
              ? 'border-indigo-300 bg-indigo-50 text-indigo-ink-700'
              : 'border-slate-300 bg-white text-navy'
          }`}
          onClick={() => (open ? close(true) : setOpen(true))}
        >
          <FunnelIcon />
          {on ? t('ui.filtersOn', { count: on }) : t('ui.filters')}
          <span aria-hidden="true" className="text-xs">
            {open ? '▴' : '▾'}
          </span>
        </button>
      ) : null}
      {active.length ? (
        <ul
          ref={chips}
          className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
          aria-label={t('ui.activeFilters')}
        >
          {active.map((f, i) => (
            <li
              key={f.id}
              data-chip={f.id}
              // A long chip is cut short (whole in its title), so the count keeps its line.
              className="inline-flex min-w-0 max-w-[18rem] items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-indigo-ink-800"
            >
              <span className="min-w-0 truncate" title={`${f.label}: ${f.value}`}>
                {f.label}: {f.value}
              </span>
              <button
                type="button"
                aria-label={t('ui.removeFilter', { label: f.label, value: f.value })}
                title={t('ui.removeFilter', { label: f.label, value: f.value })}
                className="grid h-5 w-5 flex-none place-items-center rounded-full hover:bg-indigo-100"
                onClick={() => {
                  f.onRemove();
                  removed(i);
                }}
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            </li>
          ))}
          {active.length > 1 ? (
            <li>
              <button
                type="button"
                className="rounded px-1 text-xs font-medium text-indigo-ink-700 underline-offset-2 hover:underline"
                onClick={() => {
                  active.forEach((f) => f.onRemove());
                  removed(0);
                }}
              >
                {t('ui.clearFilters')}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {count !== undefined || actions ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {count !== undefined ? (
            <span role="status" aria-live="polite" className="text-sm text-slate-700">
              {count}
            </span>
          ) : null}
          {actions}
        </div>
      ) : null}
      {children ? (
        <div
          ref={panel}
          id={panelId}
          role="group"
          aria-label={panelLabel ?? t('ui.filters')}
          tabIndex={-1}
          hidden={!open}
          data-filters-panel=""
          className="absolute left-0 right-0 top-[calc(100%+0.375rem)] z-40 flex flex-wrap items-end gap-3 rounded-xl border border-slate-300 bg-white p-4 shadow-lg focus:outline-none sm:right-auto sm:w-max sm:max-w-[min(48rem,100%)]"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close(true);
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function FunnelIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M3 4h14l-5.5 6.5V16l-3 1.5v-7L3 4z" />
    </svg>
  );
}
