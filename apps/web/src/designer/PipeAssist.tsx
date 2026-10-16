import {
  createContext,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { KindIcon } from './kinds.js';
import type { VarOption } from './vars.js';

/** The variables offered after `{{` in question texts and labels (set by the designer). */
export const PipeVariablesContext = createContext<VarOption[] | null>(null);

interface Suggestion {
  insert: string;
  name: string;
  detail: string;
  kind: VarOption['kind'] | 'label';
  questionType?: VarOption['questionType'];
}

/** The open `{{…` before the caret, if any: where it starts and what has been typed. */
export function openPipe(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('{{');
  if (start < 0) return null;
  const typed = before.slice(start + 2);
  if (typed.includes('}}') || !/^[A-Za-z0-9_.\s|#]*$/.test(typed)) return null;
  return { start, query: typed.trim() };
}

function suggestions(vars: VarOption[], query: string, labelWord: string): Suggestion[] {
  const q = query.toLowerCase();
  const out: Suggestion[] = [];
  for (const v of vars) {
    const hit =
      !q ||
      v.name.toLowerCase().includes(q.split('|')[0]!.trim()) ||
      v.text.toLowerCase().includes(q);
    if (!hit) continue;
    out.push({
      insert: v.name,
      name: v.name,
      detail: v.text,
      kind: v.kind,
      ...(v.questionType ? { questionType: v.questionType } : {}),
    });
    // Coded answers can be piped as their label too.
    if (v.codes?.length)
      out.push({
        insert: `${v.name} | label`,
        name: `${v.name} | label`,
        detail: labelWord,
        kind: 'label',
      });
  }
  return out.slice(0, 12);
}

type FieldProps = {
  id?: string;
  className?: string;
  value: string;
  placeholder?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  onChange(e: { target: { value: string } }): void;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void;
  onBlur?(): void;
  rows?: number;
  autoComplete?: string;
};

/**
 * A text input (or textarea) that opens a list of variables when `{{` is typed, like the
 * IntelliSense of a formula editor: ↑↓ choose, Enter or Tab insert `{{NAME}}`, Escape closes.
 * Without the designer's variables it is a plain field.
 */
export function PipeField({ multiline, ...props }: FieldProps & { multiline?: boolean }) {
  const { t } = useTranslation();
  const vars = useContext(PipeVariablesContext);
  const listId = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const list = useMemo(
    () => (open && vars ? suggestions(vars, open.query, t('designer.pipe.label')) : []),
    [open, vars, t],
  );
  const shown = !!open && list.length > 0;

  const sync = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if (!vars) return;
    const next = openPipe(el.value, el.selectionStart ?? el.value.length);
    setOpen(next);
    if (!next || next.query !== open?.query) setActive(0);
  };

  const insert = (s: Suggestion) => {
    const el = ref.current;
    if (!el || !open) return;
    const caret = el.selectionStart ?? el.value.length;
    // Swallow a `}}` already typed right after the caret.
    const rest = el.value.slice(caret).replace(/^\s*\}\}/, '');
    const text = `${el.value.slice(0, open.start)}{{${s.insert}}}`;
    props.onChange({ target: { value: text + rest } });
    setOpen(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (shown) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(list[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(null);
        return;
      }
    }
    props.onKeyDown?.(e);
  };

  const common = {
    ...props,
    ref,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      props.onChange(e);
      sync(e.target);
    },
    onKeyDown,
    onKeyUp: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')
        sync(e.currentTarget);
    },
    onBlur: () => {
      // Let a click on a suggestion land first.
      setTimeout(() => setOpen(null), 120);
      props.onBlur?.();
    },
    'aria-autocomplete': vars ? ('list' as const) : undefined,
    // aria-expanded belongs to the combobox role, which only the single-line field takes.
    'aria-expanded': vars && !multiline ? shown : undefined,
    'aria-controls': shown ? listId : undefined,
    'aria-activedescendant': shown ? `${listId}-${active}` : undefined,
  };

  return (
    <div className="relative min-w-0 flex-1">
      {multiline ? (
        <textarea rows={props.rows ?? 2} {...common} />
      ) : (
        <input type="text" role={vars ? 'combobox' : undefined} {...common} />
      )}
      {shown ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-full min-w-[18rem] rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-lg">
          <ul
            id={listId}
            role="listbox"
            aria-label={t('designer.pipe.title')}
            className="max-h-72 overflow-y-auto"
            data-testid="pipe-assist"
          >
            {list.map((s, i) => (
              <li
                key={`${s.insert}-${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 aria-selected:bg-indigo-50"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span aria-hidden className="flex w-5 justify-center text-slate-500">
                  {s.kind === 'question' && s.questionType ? (
                    <KindIcon k={s.questionType} className="size-3.5" />
                  ) : s.kind === 'computed' ? (
                    <KindIcon k="computed" className="size-3.5" />
                  ) : s.kind === 'roster' ? (
                    <KindIcon k="roster" className="size-3.5" />
                  ) : s.kind === 'label' ? (
                    <span className="text-xs">Aa</span>
                  ) : (
                    <span className="text-xs">⌂</span>
                  )}
                </span>
                <span className="shrink-0 font-mono">{s.name}</span>
                <span className="truncate text-xs text-slate-500">{s.detail}</span>
              </li>
            ))}
          </ul>
          <p aria-hidden className="px-2 pt-1 text-[11px] text-slate-500">
            {t('designer.pipe.keys')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
