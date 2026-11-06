import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { applySuggestion, rank, tokenAt, type Suggestion, type Token } from './suggest.js';

const BADGE: Record<Suggestion['kind'], string> = {
  question: 'bg-indigo-100 text-indigo-ink-800',
  computed: 'bg-indigo-100 text-indigo-ink-800',
  roster: 'bg-indigo-100 text-indigo-ink-800',
  case: 'bg-emerald-100 text-emerald-ink-800',
  context: 'bg-slate-100 text-slate-700',
  function: 'bg-amber-100 text-amber-900',
  keyword: 'bg-slate-100 text-slate-700',
};

/**
 * A text field that offers suggestions while it is typed, as a code editor does: the variables,
 * `case.` fields, functions and keywords that fit the word at the cursor. Up and Down choose,
 * Enter or Tab take it, Escape closes, Ctrl+Space opens it on an empty word. It is a combobox
 * for screen readers, and it never takes a key when its list is closed.
 */
export function Suggest({
  value,
  onChange,
  suggestions,
  multiline = false,
  rows = 2,
  className,
  id,
  ...aria
}: {
  value: string;
  onChange(v: string): void;
  suggestions: Suggestion[];
  multiline?: boolean;
  rows?: number;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | undefined;
  placeholder?: string;
  spellCheck?: boolean;
}) {
  const { t } = useTranslation();
  const auto = useId();
  const inputId = id ?? auto;
  const listId = `${inputId}-list`;
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [token, setToken] = useState<Token | null>(null);
  const [caretTo, setCaretTo] = useState<number | null>(null);

  const shown = useMemo(
    () => (open && token ? rank(suggestions, token.text) : []),
    [open, token, suggestions],
  );
  const visible = shown.length > 0;

  // The cursor goes where the inserted text ends, once the field has the new value.
  useEffect(() => {
    if (caretTo === null) return;
    ref.current?.setSelectionRange(caretTo, caretTo);
    setCaretTo(null);
  }, [caretTo, value]);

  /** `force`: Ctrl+Space, which also opens the list on an empty word. */
  const look = (el: HTMLTextAreaElement | HTMLInputElement, force: boolean) => {
    const caret = el.selectionStart ?? el.value.length;
    const tok = tokenAt(el.value, caret);
    setToken(tok);
    setActive(0);
    setOpen(tok !== null && (force || tok.text.length > 0));
  };

  const accept = (i: number) => {
    const s = shown[i];
    if (!s || !token) return;
    const r = applySuggestion(value, token, s);
    onChange(r.text);
    setCaretTo(r.caret);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      look(e.currentTarget, true);
      return;
    }
    if (!visible) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const shared = {
    id: inputId,
    ref,
    value,
    className,
    // A text area cannot be a combobox in ARIA: it gets the live announcement below instead.
    ...(multiline
      ? {}
      : {
          role: 'combobox' as const,
          'aria-autocomplete': 'list' as const,
          'aria-expanded': visible,
          'aria-controls': listId,
          'aria-activedescendant': visible ? `${inputId}-opt-${active}` : undefined,
        }),
    autoComplete: 'off',
    spellCheck: false,
    ...aria,
    onChange: (e: { target: HTMLTextAreaElement | HTMLInputElement }) => {
      onChange(e.target.value);
      look(e.target, false);
    },
    onKeyDown,
    // A click moves the cursor away from the word the list was about.
    onClick: () => setOpen(false),
    onBlur: () => setOpen(false),
  };

  return (
    <div className="relative min-w-0">
      {multiline ? <textarea rows={rows} {...shared} /> : <input type="text" {...shared} />}
      <p role="status" className="sr-only">
        {visible
          ? `${t('designer.suggest.count', { count: shown.length })}: ${shown[active]?.label ?? ''}`
          : ''}
      </p>
      <ul
        id={listId}
        role="listbox"
        aria-label={t('designer.suggest.list')}
        hidden={!visible}
        className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-slate-300 bg-white py-1 shadow-lg"
      >
        {shown.map((s, i) => (
          <li
            key={`${s.kind}:${s.label}`}
            id={`${inputId}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            // The mouse must not take the focus from the field: the list would close first.
            onMouseDown={(e) => {
              e.preventDefault();
              accept(i);
            }}
            onMouseEnter={() => setActive(i)}
            className={`flex cursor-pointer items-baseline gap-2 px-2 py-1 text-sm ${
              i === active ? 'bg-indigo-50' : ''
            }`}
          >
            <span className="font-mono font-semibold text-slate-900">{s.label}</span>
            <span className={`rounded px-1 text-[11px] ${BADGE[s.kind]}`}>
              {t(`designer.suggest.kinds.${s.kind}`)}
            </span>
            {s.detail ? (
              <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{s.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
