import * as Tabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

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
