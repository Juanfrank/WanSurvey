import * as Tabs from '@radix-ui/react-tabs';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreMenu } from './MoreMenu.js';
import { useMedia } from './SideDrawer.js';

/** First level: underlined tabs across the page. */
export const tabCls =
  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-navy data-[state=active]:border-indigo-600 data-[state=active]:font-semibold data-[state=active]:text-indigo-ink-600';

/** Second level: soft pills under a tab. */
export const subTabCls =
  'rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 data-[state=active]:bg-indigo-50 data-[state=active]:font-semibold data-[state=active]:text-indigo-ink-700';

/** The list of a first-level tab set. */
export function TabBar({
  label,
  items,
}: {
  label: string;
  items: { value: string; label: ReactNode }[];
}) {
  return (
    <Tabs.List aria-label={label} className="flex flex-wrap gap-1 border-b border-slate-200">
      {items.map((x) => (
        <Tabs.Trigger key={x.value} value={x.value} className={tabCls}>
          {x.label}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}

/** The list of a second-level tab set. */
export function SubTabBar({
  label,
  items,
}: {
  label: string;
  items: { value: string; label: ReactNode }[];
}) {
  return (
    <Tabs.List aria-label={label} className="flex flex-wrap gap-1">
      {items.map((x) => (
        <Tabs.Trigger key={x.value} value={x.value} className={subTabCls}>
          {x.label}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}

export interface OverflowTab {
  value: string;
  label: string;
  /** Seldom used: kept in "More" unless it is the open tab. */
  rarely?: boolean;
  /** Called on a click on the tab (or on its entry in "More"), besides selecting it. */
  onClick?: () => void;
}

/** The gap between two tabs (gap-1). */
const GAP = 4;

/**
 * A first-level tab list that stays on one line. Tabs marked `rarely` (People, the project's
 * settings) go in a "More ▾" menu after the list, and so do the last tabs that do not fit the
 * width; the open tab is never hidden: when it is one of those, it shows in the row. Under
 * 640 px the row scrolls sideways instead (only the `rarely` ones are in "More").
 *
 * Use it inside a Radix `Tabs.Root` whose value is `value`; `onSelect` does what the root's
 * `onValueChange` does, for the entries picked from "More".
 *
 *   <Tabs.Root value={tab} onValueChange={setTab}>
 *     <OverflowTabList
 *       label={t('cases.tabs.label')}
 *       value={tab}
 *       onSelect={setTab}
 *       items={[
 *         { value: 'overview', label: t('cases.tabs.overview') },
 *         { value: 'settings', label: t('cases.tabs.settings'), rarely: true },
 *       ]}
 *     />
 *     <Tabs.Content value="overview">…</Tabs.Content>
 *   </Tabs.Root>
 *
 * In end-to-end tests, `gotoTab(page, name)` (e2e/helpers.ts) opens a tab wherever it is.
 */
export function OverflowTabList({
  label,
  items,
  value,
  onSelect,
}: {
  label: string;
  items: OverflowTab[];
  value: string;
  onSelect(value: string): void;
}) {
  const { t } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const narrow = useMedia('(max-width: 639px)');
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const [sizes, setSizes] = useState<number[]>([]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const on = () => setWidth(el.clientWidth || Number.POSITIVE_INFINITY);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The width of every tab (and of "More", last), measured on a hidden copy of the row.
  const labels = `${items.map((x) => x.label).join('\u0000')}\u0000${t('ui.more')}`;
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const read = () => {
      const next = [...el.children].map((c) => (c as HTMLElement).offsetWidth);
      setSizes((s) => (s.length === next.length && s.every((v, i) => v === next[i]) ? s : next));
    };
    read();
    // Again when the web font arrives or the text changes size (the copy's width follows).
    let live = true;
    void document.fonts?.ready.then(() => live && read());
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => {
      live = false;
      ro?.disconnect();
    };
  }, [labels]);

  const kept = items.filter((x) => !x.rarely || x.value === value);
  let shown = kept;
  const known = sizes.length === items.length + 1 && sizes.every((s) => s > 0);
  if (!narrow && known && Number.isFinite(width)) {
    const w = (x: OverflowTab) => sizes[items.indexOf(x)]! + GAP;
    const all = kept.reduce((a, x) => a + w(x), 0);
    if (kept.length < items.length || all > width) {
      // Room for "More", then the open tab, then the others in order while they fit.
      let room = width - sizes[items.length]! - GAP;
      const active = kept.find((x) => x.value === value);
      if (active) room -= w(active);
      const fit = new Set(active ? [active.value] : []);
      for (const x of kept) {
        if (x === active) continue;
        if (w(x) > room) break;
        room -= w(x);
        fit.add(x.value);
      }
      shown = kept.filter((x) => fit.has(x.value));
    }
  }
  const hidden = items.filter((x) => !shown.includes(x));

  return (
    <div ref={wrap} className="relative flex min-w-0 items-end gap-x-1 border-b border-slate-200">
      <Tabs.List
        aria-label={label}
        className={`flex min-w-0 gap-1 ${narrow ? 'overflow-x-auto' : ''}`}
        data-overflow-tabs=""
      >
        {shown.map((x) => (
          <Tabs.Trigger
            key={x.value}
            value={x.value}
            className={`${tabCls} whitespace-nowrap`}
            onClick={x.onClick}
          >
            {x.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {hidden.length ? (
        <MoreMenu
          label={t('ui.moreSections')}
          unstyled
          className="-mb-px inline-flex flex-none items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-navy aria-expanded:text-navy"
          entries={hidden.map((x) => ({
            type: 'item' as const,
            id: x.value,
            label: x.label,
            onSelect: () => {
              x.onClick?.();
              onSelect(x.value);
              // The tab picked now shows in the row: the focus goes to it.
              requestAnimationFrame(() =>
                wrap.current
                  ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
                  ?.focus(),
              );
            },
          }))}
        >
          {t('ui.more')}
          <span aria-hidden="true" className="text-xs">
            ▾
          </span>
        </MoreMenu>
      ) : null}
      {/* A copy of the row out of sight, to know how wide each tab is. */}
      <div
        ref={measure}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex h-0 w-max overflow-hidden whitespace-nowrap"
      >
        {items.map((x) => (
          <span key={x.value} className={`${tabCls} flex-none font-semibold`}>
            {x.label}
          </span>
        ))}
        <span className={`${tabCls} flex-none`}>{t('ui.more')} ▾</span>
      </div>
    </div>
  );
}
