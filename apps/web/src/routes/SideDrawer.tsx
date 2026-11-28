import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, PinIcon } from './icons.js';

function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage may be unavailable; the choice just isn't remembered.
  }
}

/** Whether a media query matches, following changes. */
export function useMedia(query: string) {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** A boolean remembered on this device (localStorage), with a default when nothing is saved. */
export function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => readFlag(key, fallback));
  const set = (v: boolean) => {
    setValue(v);
    writeFlag(key, v);
  };
  return [value, set] as const;
}

export interface DrawerState {
  /** Pinned open as a column beside the content (on a wide screen). */
  inline: boolean;
  pinned: boolean;
  setPinned(v: boolean): void;
  /** Collapsed to a rail, the pane is open over the content. */
  open: boolean;
  /** Opened on purpose (click or shortcut), not just by pointing at the rail. */
  held: boolean;
  /** Opens (and keeps open until Escape, a click elsewhere or focus leaving) or closes it. */
  setOpen(v: boolean): void;
  /** Opens it from pointing at the rail (it then stays open like the rest); `false` closes it unless it was opened on purpose. */
  peek(v: boolean): void;
}

/**
 * State of a side pane that is pinned beside the content or collapsed to a rail whose pane
 * opens over the content. Pinned by default on wide screens; on narrow ones it is always a
 * rail. The choice is remembered on the device.
 */
export function useDrawer(storageKey: string, pinnedDefault = true): DrawerState {
  const wide = useMedia('(min-width: 1024px)');
  const [pinned, setPinned] = useStoredFlag(storageKey, pinnedDefault);
  const [state, setState] = useState({ open: false, held: false });
  const inline = wide && pinned;
  return {
    inline,
    pinned,
    setPinned: (v) => {
      setPinned(v);
      setState({ open: false, held: false });
    },
    open: !inline && state.open,
    held: state.held,
    setOpen: (v) => setState({ open: v, held: v }),
    peek: (v) =>
      setState((s) => (v ? { ...s, open: true } : s.held ? s : { open: false, held: false })),
  };
}

/** How long the pointer rests on the rail before the pane opens by itself. */
const PEEK_DELAY_MS = 300;
/** How long the pointer may stay off a pane opened by pointing before it closes. */
const PEEK_GRACE_MS = 1200;

/**
 * A side pane. Pinned, it is a sticky column beside the content. Collapsed, it is a slim sticky
 * rail (icon, title, count) that stays beside the content; resting the pointer on it (with a
 * mouse), clicking it or a shortcut opens the pane over the content next to the rail, without
 * moving the content. It closes on Escape, the close button, a click elsewhere or focus leaving
 * it; opened by pointing, also once the pointer has stayed off it for a while (a moment off it,
 * with a magnifier or a shaky hand, does not close it). The content stays mounted while
 * collapsed, so it keeps its state.
 */
export function SideDrawer({
  id,
  drawer,
  side,
  label,
  icon,
  badge,
  badgeLabel,
  width = '22rem',
  className = '',
  float,
  docked = false,
  column = false,
  children,
}: {
  id: string;
  drawer: DrawerState;
  side: 'left' | 'right';
  label: string;
  icon: ReactNode;
  badge?: number;
  /** What the count means, read with the rail button by a screen reader ("Due now: 1"). */
  badgeLabel?: string;
  /** Width when pinned. */
  width?: string;
  className?: string;
  /**
   * Collapsed, a floating button at the bottom right (its visible text: "Callbacks (2)")
   * instead of a rail: the content keeps the whole width. The pane opens above the button.
   */
  float?: string;
  /**
   * With `float`: the button sits where the drawer is placed in the page (in a header row)
   * instead of fixed at the bottom right, so it never covers the content; the pane opens
   * below it.
   */
  docked?: boolean;
  /**
   * Pinned, the pane is a sticky column of the page's own grid (under the page's header and
   * toolbar) instead of a column glued to the side panel over the whole height: the header
   * keeps the page's full width. The caller's grid gives it its column (`width` is not used),
   * and `--sticky-top` (default 4rem) says where it sticks: under the page's sticky toolbar.
   */
  column?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const enter = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { inline, open } = drawer;
  // Only a real mouse opens it by pointing; touch screens and pens open it with a tap.
  const canPeek = useMedia('(hover: hover) and (pointer: fine)');
  const countId = `${id}-count`;

  // A click elsewhere closes the pane, and so does Escape when focus is outside it (opened by
  // pointing, it does not take the focus).
  useEffect(() => {
    if (inline || !open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) drawer.setOpen(false);
    };
    // Not an Escape meant for a dialog, menu or list that has the focus.
    const esc = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (
        e.key === 'Escape' &&
        !e.defaultPrevented &&
        !box.current?.contains(target) &&
        !target?.closest?.('dialog, [role="dialog"], [role="menu"], [role="listbox"]')
      )
        drawer.setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [inline, open, drawer]);
  // Folded to a button, a pane closed by what was picked in it (a "Call now") gives the focus
  // back to the button instead of leaving it on nothing.
  useLayoutEffect(() => {
    if (!open && pane.current?.contains(document.activeElement)) button.current?.focus();
  }, [open]);
  // A pending open or close is dropped once the pane changes by other means.
  useEffect(() => {
    clearTimeout(enter.current);
    clearTimeout(leave.current);
  }, [inline, open]);
  useEffect(
    () => () => {
      clearTimeout(enter.current);
      clearTimeout(leave.current);
    },
    [],
  );

  const pin = (
    <button
      type="button"
      data-pin
      aria-pressed={drawer.pinned}
      title={drawer.pinned ? t('app.unpin') : t('app.pin')}
      aria-label={`${drawer.pinned ? t('app.unpin') : t('app.pin')}: ${label}`}
      onClick={() => {
        drawer.setPinned(!drawer.pinned);
        // The control moves (into the column, or onto the rail): keep focus with it.
        requestAnimationFrame(() =>
          (
            document.querySelector<HTMLElement>(`#${id} [data-pin]`) ??
            document.querySelector<HTMLElement>(`[aria-controls="${id}"]`)
          )?.focus(),
        );
      }}
      className={`hidden h-8 w-8 place-items-center rounded-full lg:grid ${
        drawer.pinned
          ? 'bg-indigo-600 text-on-fill hover:bg-indigo-500'
          : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-ink-600'
      }`}
    >
      <PinIcon className="h-4 w-4" />
    </button>
  );

  // From 900 px the pane is glued to its edge: the left one to the side panel, the right one
  // to the window's edge; the page leaves room for it (main reads --pane-left/--pane-right).
  const place = side === 'left' ? 'min-[900px]:left-[var(--side-w,0px)]' : 'min-[900px]:right-0';
  const line = side === 'left' ? 'min-[900px]:border-r' : 'min-[900px]:border-l';
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty(`--pane-${side}`, inline ? (column ? '0px' : width) : float ? '0px' : '3rem');
    return () => void root.removeProperty(`--pane-${side}`);
  }, [side, inline, width, float, column]);

  if (inline && column)
    return (
      <aside
        id={id}
        aria-label={label}
        className={`sticky top-[var(--sticky-top,4rem)] flex max-h-[calc(100vh-var(--sticky-top,4rem)-1rem)] min-w-0 flex-col gap-1 self-start overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}
      >
        <div className="no-print flex justify-end">{pin}</div>
        {children}
      </aside>
    );

  if (inline)
    return (
      <aside
        id={id}
        aria-label={label}
        style={{ width }}
        className={`fixed inset-y-0 z-20 flex min-w-0 flex-col gap-1 overflow-y-auto border-slate-200 bg-white p-4 ${place} ${line} ${className}`}
      >
        <div className="no-print flex justify-end">{pin}</div>
        {children}
      </aside>
    );

  const closeButton = (
    <button
      type="button"
      aria-label={`${t('app.close')}: ${label}`}
      title={t('app.close')}
      onClick={() => {
        drawer.setOpen(false);
        button.current?.focus();
      }}
      className="grid h-8 w-8 place-items-center rounded-full text-slate-600 hover:bg-indigo-50 hover:text-indigo-ink-600"
    >
      <CloseIcon className="h-4 w-4" />
    </button>
  );
  const onEscape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && open && !e.defaultPrevented) {
      e.preventDefault();
      drawer.setOpen(false);
      button.current?.focus();
    }
  };

  if (float)
    return (
      <aside
        ref={box}
        aria-label={label}
        className={`no-print z-20 flex flex-col gap-2 ${
          side === 'left' ? 'items-start' : 'items-end'
        } ${
          docked
            ? 'relative'
            : `fixed bottom-4 ${
                side === 'left'
                  ? 'left-4 min-[900px]:left-[calc(var(--side-w,0px)+1rem)]'
                  : 'right-4'
              }`
        }`}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drawer.setOpen(false);
        }}
        onKeyDown={onEscape}
      >
        <div
          ref={pane}
          id={id}
          hidden={!open}
          className={`flex ${docked ? 'max-h-[min(32rem,calc(100vh-12rem))]' : 'max-h-[min(36rem,calc(100vh-6rem))]'} w-[min(24rem,calc(100vw-2rem))] flex-col gap-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-card ${
            docked ? `absolute top-full mt-2 ${side === 'left' ? 'left-0' : 'right-0'}` : ''
          } ${className}`}
        >
          <div className="flex items-center justify-end gap-1">
            {pin}
            {closeButton}
          </div>
          {children}
        </div>
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-describedby={badge ? countId : undefined}
          onClick={() => drawer.setOpen(!open)}
          className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold shadow-card ${
            open
              ? 'border-indigo-600 bg-indigo-600 text-on-fill'
              : badge
                ? 'border-amber-300 bg-amber-50 text-amber-ink-900 hover:bg-amber-100'
                : 'border-slate-200 bg-white text-navy hover:bg-indigo-50'
          }`}
        >
          {icon}
          {float}
        </button>
        {/* What the colour says, read as the button's description. */}
        {badge ? (
          <span id={countId} hidden>
            {badgeLabel ?? badge}
          </span>
        ) : null}
      </aside>
    );

  return (
    <aside
      ref={box}
      aria-label={label}
      className={`no-print sticky top-4 z-20 h-[calc(100vh-2rem)] w-12 self-start min-[900px]:fixed min-[900px]:top-0 min-[900px]:bottom-0 min-[900px]:h-screen ${place}`}
      onMouseEnter={() => {
        clearTimeout(enter.current);
        clearTimeout(leave.current);
        if (canPeek && !open) enter.current = setTimeout(() => drawer.peek(true), PEEK_DELAY_MS);
      }}
      // Passing over the rail on the way elsewhere does not open it.
      onMouseLeave={() => {
        clearTimeout(enter.current);
        if (open && !drawer.held)
          leave.current = setTimeout(() => drawer.peek(false), PEEK_GRACE_MS);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drawer.setOpen(false);
      }}
      onKeyDown={onEscape}
    >
      <div
        className={`flex h-full flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white py-3 shadow-sm min-[900px]:rounded-none min-[900px]:border-y-0 min-[900px]:shadow-none ${
          side === 'left' ? 'min-[900px]:border-l-0' : 'min-[900px]:border-r-0'
        }`}
      >
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-label={label}
          aria-describedby={badge ? countId : undefined}
          title={label}
          // Pointing opened it: a click keeps it open; otherwise a click opens or closes it.
          onClick={() => {
            clearTimeout(enter.current);
            drawer.setOpen(!(open && drawer.held));
          }}
          className={`grid h-9 w-9 place-items-center rounded-lg ${
            open
              ? 'bg-indigo-600 text-on-fill'
              : 'text-navy hover:bg-indigo-50 hover:text-indigo-ink-600'
          }`}
        >
          {icon}
        </button>
        {badge ? (
          <span
            id={countId}
            className="rounded-full bg-amber-100 px-2 text-xs font-bold text-amber-ink-900"
          >
            {badgeLabel ? (
              <>
                <span className="sr-only">{badgeLabel}</span>
                <span aria-hidden="true">{badge}</span>
              </>
            ) : (
              badge
            )}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className="rotate-180 text-xs font-semibold uppercase tracking-wider text-slate-600 [writing-mode:vertical-rl]"
        >
          {label}
        </span>
      </div>
      <div
        id={id}
        hidden={!open}
        className={`absolute top-0 flex h-full w-[min(26rem,calc(100vw-5rem))] flex-col gap-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-card min-[900px]:rounded-none min-[900px]:border-y-0 ${
          side === 'left' ? 'left-full ml-2 min-[900px]:ml-0' : 'right-full mr-2 min-[900px]:mr-0'
        } ${className}`}
      >
        <div className="flex items-center justify-end gap-1">
          {pin}
          {closeButton}
        </div>
        {children}
      </div>
    </aside>
  );
}
