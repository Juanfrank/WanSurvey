import type { RoutingNode } from '@wansurvey/logic';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { inputCls } from './fields.js';
import { locate, type Draft } from './tree.js';
import { assignLanes, logicSummary, type Routing } from './useRouting.js';
import { nodeLabel } from './vars.js';

const END_ID = '__END';
const LANE = 14;

interface Arc {
  from: string;
  to: string;
  kind: 'skip' | 'row';
  label: string;
}

const hasLogic = (n: RoutingNode) =>
  !!n.showIf || n.skips.length > 0 || n.ends.length > 0 || n.checks.errors + n.checks.warnings > 0;

/**
 * The questionnaire's routing as a map: items in order down a spine, conditional items marked,
 * skip arrows in a gutter, end rules as exits and rosters as loops. Every arrow is also written
 * out in the card, so the drawing is never the only way to read the logic.
 */
export function RoutingMap({
  draft,
  routing,
  lang,
  onOpen,
}: {
  draft: Draft;
  routing: Routing;
  lang: string;
  onOpen(id: string): void;
}) {
  const { t } = useTranslation();
  const [onlyLogic, setOnlyLogic] = useState(false);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [geo, setGeo] = useState<{ y: Record<string, number>; width: number }>({ y: {}, width: 0 });

  const nodes = routing.nodes;
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const hiddenUnder = (n: RoutingNode) => {
      for (let p = n.parentId; p; p = routing.byId.get(p)?.parentId ?? null)
        if (collapsed.has(p)) return true;
      return false;
    };
    return nodes.filter((n) => {
      if (n.kind === 'pagebreak') return false;
      if (hiddenUnder(n)) return false;
      const container = n.kind === 'section' || n.kind === 'block' || n.kind === 'roster';
      if (onlyLogic && !container && !hasLogic(n)) return false;
      if (term) {
        const at = locate(draft, n.id);
        const text = `${n.name ?? n.id} ${at ? nodeLabel(at.node, lang) : ''}`.toLowerCase();
        if (!container && !text.includes(term)) return false;
      }
      return true;
    });
  }, [nodes, routing.byId, collapsed, onlyLogic, search, draft, lang]);
  const shown = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);

  const arcs = useMemo<Arc[]>(() => {
    const out: Arc[] = [];
    for (const n of nodes) {
      for (const s of n.skips) {
        const label = routing.describe(s.ast, s.src);
        if (s.target === 'END') out.push({ from: n.id, to: END_ID, kind: 'skip', label });
        else if (s.target === 'END_ROW') {
          let p = n.parentId;
          while (p && routing.byId.get(p)?.kind !== 'roster')
            p = routing.byId.get(p)?.parentId ?? null;
          if (p) out.push({ from: n.id, to: p, kind: 'row', label });
        } else if (typeof s.target === 'number') {
          out.push({ from: n.id, to: nodes[s.target]!.id, kind: 'skip', label });
        }
      }
    }
    return out.filter((a) => shown.has(a.from) && (a.to === END_ID || shown.has(a.to)));
  }, [nodes, routing, shown]);
  const lanes = useMemo(
    () =>
      assignLanes(
        arcs.map((a) => ({
          from: visible.findIndex((n) => n.id === a.from),
          to: a.to === END_ID ? visible.length : visible.findIndex((n) => n.id === a.to),
        })),
      ),
    [arcs, visible],
  );
  const laneCount = lanes.length ? Math.max(...lanes) + 1 : 0;
  const gutter = 20 + laneCount * LANE;

  // Measure card centres after layout so arrows follow wrapping text and resizes.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const y: Record<string, number> = {};
      el.querySelectorAll<HTMLElement>('[data-card]').forEach((c) => {
        y[c.dataset.card!] = c.offsetTop + Math.min(c.offsetHeight / 2, 18);
      });
      setGeo({ y, width: el.clientWidth });
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [visible]);

  const related = useMemo(() => {
    if (!active) return new Set<string>();
    const n = routing.byId.get(active);
    const s = new Set<string>(n?.readBy ?? []);
    for (const a of arcs) if (a.from === active) s.add(a.to);
    for (const a of arcs) if (a.to === active) s.add(a.from);
    return s;
  }, [active, arcs, routing.byId]);

  const onKey = (e: KeyboardEvent<HTMLOListElement>) => {
    const cards = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[data-card] > button') ?? []),
    ];
    const i = cards.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      cards[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      cards.at(-1)?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('designer.routing.search')}</span>
          <input
            type="search"
            className={`${inputCls} w-56`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyLogic}
            onChange={(e) => setOnlyLogic(e.target.checked)}
          />
          {t('designer.routing.onlyLogic')}
        </label>
        <Legend />
      </div>
      <p className="text-xs text-slate-600">{t('designer.routing.help')}</p>
      <div className="relative" style={{ paddingRight: gutter }}>
        <ol
          ref={listRef}
          className="flex flex-col gap-1.5"
          aria-label={t('designer.routing.title')}
          onKeyDown={onKey}
          data-testid="routing-map"
        >
          {visible.map((n) => (
            <Card
              key={n.id}
              n={n}
              routing={routing}
              draft={draft}
              lang={lang}
              active={active === n.id}
              related={related.has(n.id)}
              collapsed={collapsed.has(n.id)}
              onToggle={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                })
              }
              onActive={setActive}
              onOpen={onOpen}
            />
          ))}
          <li
            data-card={END_ID}
            className="rounded-md border border-slate-800 bg-slate-800 px-3 py-1.5 text-sm font-semibold text-slate-50"
          >
            ■ {t('designer.routing.end')}
          </li>
        </ol>
        <svg
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 h-full overflow-visible"
          style={{ width: gutter }}
        >
          <defs>
            <marker
              id="rm-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>
          {arcs.map((a, i) => {
            const y0 = geo.y[a.from];
            const y1 = geo.y[a.to];
            if (y0 === undefined || y1 === undefined) return null;
            const x = 4;
            const bulge = 14 + lanes[i]! * LANE;
            const hot = active !== null && (a.from === active || a.to === active);
            return (
              <path
                key={i}
                d={`M ${x} ${y0} C ${x + bulge} ${y0}, ${x + bulge} ${y1}, ${x + 2} ${y1}`}
                fill="none"
                className={
                  hot
                    ? 'text-indigo-ink-700'
                    : a.kind === 'row'
                      ? 'text-amber-ink-600'
                      : 'text-slate-400'
                }
                stroke="currentColor"
                strokeWidth={hot ? 2.5 : 1.5}
                strokeDasharray={a.kind === 'row' ? '4 3' : undefined}
                markerEnd="url(#rm-arrow)"
                data-arc={`${a.from}->${a.to}`}
              >
                <title>{a.label}</title>
              </path>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <ul
      className="flex flex-wrap gap-3 text-xs text-slate-700"
      aria-label={t('designer.routing.legend')}
    >
      <li className="flex items-center gap-1">
        <span
          className="inline-block h-3 w-5 rounded border border-dashed border-violet-500"
          aria-hidden
        />
        {t('designer.routing.legendConditional')}
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden className="text-slate-500">
          ⤵
        </span>
        {t('designer.routing.legendSkip')}
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden className="text-red-ink-700">
          ⏹
        </span>
        {t('designer.routing.legendEnd')}
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden className="text-amber-ink-700">
          ↻
        </span>
        {t('designer.routing.legendRoster')}
      </li>
    </ul>
  );
}

function Card({
  n,
  routing,
  draft,
  lang,
  active,
  related,
  collapsed,
  onToggle,
  onActive,
  onOpen,
}: {
  n: RoutingNode;
  routing: Routing;
  draft: Draft;
  lang: string;
  active: boolean;
  related: boolean;
  collapsed: boolean;
  onToggle(): void;
  onActive(id: string | null): void;
  onOpen(id: string): void;
}) {
  const { t } = useTranslation();
  const at = locate(draft, n.id);
  const text = at ? nodeLabel(at.node, lang) : '';
  const container = n.kind === 'section' || n.kind === 'block' || n.kind === 'roster';
  const lines = logicSummary(n, routing, t);
  const checks = n.checks.errors + n.checks.warnings;
  const ring = active ? 'ring-2 ring-indigo-600' : related ? 'ring-2 ring-amber-400' : '';
  const style =
    n.kind === 'section'
      ? 'border-slate-300 bg-slate-100 font-semibold'
      : n.kind === 'roster'
        ? 'border-amber-300 bg-amber-50'
        : n.kind === 'block'
          ? 'border-slate-200 bg-slate-50'
          : n.showIf
            ? 'border-dashed border-violet-500 bg-white'
            : 'border-slate-200 bg-white';
  return (
    <li
      data-card={n.id}
      data-testid="routing-card"
      className="flex items-start gap-1"
      style={{ marginLeft: `${n.depth * 1.25}rem` }}
    >
      {container ? (
        <button
          type="button"
          className="mt-1.5 w-4 shrink-0 text-xs text-slate-600"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'designer.routing.expand' : 'designer.routing.collapse', {
            id: n.id,
          })}
          onClick={onToggle}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : null}
      <button
        type="button"
        className={`min-w-0 flex-1 rounded-md border px-3 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${style} ${ring}`}
        onClick={() => onOpen(n.id)}
        onMouseEnter={() => onActive(n.id)}
        onMouseLeave={() => onActive(null)}
        onFocus={() => onActive(n.id)}
        onBlur={() => onActive(null)}
        aria-describedby={lines.length ? `rm-${n.id}-logic` : undefined}
      >
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono">{n.name ?? n.id}</span>
          <span className="min-w-0 truncate text-slate-700">{text}</span>
          {n.kind === 'roster' && n.roster ? (
            <span className="text-xs text-amber-ink-900">
              ↻{' '}
              {n.roster.count === 'fixed'
                ? t('designer.routing.loopFixed', { n: n.roster.n, count: n.roster.n })
                : n.roster.count === 'expression'
                  ? t('designer.routing.loopExpr', { expr: n.roster.expr })
                  : t('designer.routing.loopOpen')}
            </span>
          ) : null}
          {checks ? (
            <span className="text-xs text-slate-600">
              ✓ {t('designer.routing.checks', { count: checks })}
            </span>
          ) : null}
          {n.readBy.length ? (
            <span className="text-xs text-slate-600">
              {t('designer.routing.usedBy', { count: n.readBy.length })}
            </span>
          ) : null}
        </span>
        {lines.length ? (
          <span id={`rm-${n.id}-logic`} className="mt-0.5 flex flex-col text-xs">
            {n.showIf ? <span className="text-violet-ink-800">◇ {lines[0]}</span> : null}
            {n.skips.map((_, i) => (
              <span key={`s${i}`} className="text-slate-700">
                ⤵ {lines[(n.showIf ? 1 : 0) + i]}
              </span>
            ))}
            {n.ends.map((_, i) => (
              <span key={`e${i}`} className="text-red-ink-800">
                ⏹ {lines[(n.showIf ? 1 : 0) + n.skips.length + i]}
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
}
