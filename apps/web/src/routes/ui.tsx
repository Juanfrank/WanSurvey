import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { localiseError } from '../i18n-messages.js';
import { CloseIcon } from './icons.js';
import { LogoMark, LogoName } from './Logo.js';

/** Small shared building blocks so screens stay consistent. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-6 shadow-card ${className}`}>
      {children}
    </div>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  className = '',
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  /** `sm`: the compact size, the same as `smallBtn`, for rows of controls. */
  size?: 'md' | 'sm';
  /** An action under way: clicks do nothing and a spinner shows beside the text. */
  busy?: boolean;
}) {
  // Disabled, the primary button turns neutral grey: a faded blue read as one more variant.
  const styles =
    variant === 'primary'
      ? 'border border-indigo-600 bg-indigo-600 text-on-fill hover:border-indigo-500 hover:bg-indigo-500 disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-600 disabled:hover:border-slate-200 disabled:hover:bg-slate-200'
      : 'border border-slate-300 bg-white text-navy hover:border-indigo-600 hover:text-indigo-ink-600 disabled:opacity-50 disabled:hover:border-slate-300 disabled:hover:text-navy';
  return (
    <button
      className={`rounded-md ${size === 'sm' ? 'px-3 py-1' : 'px-4 py-2'} text-sm font-semibold disabled:cursor-not-allowed ${busy ? 'inline-flex cursor-wait items-center gap-2' : ''} ${styles} ${className}`}
      disabled={disabled}
      // Not `disabled` while busy: the focused button would lose the focus.
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      {...rest}
      onClick={busy ? (e) => e.preventDefault() : rest.onClick}
    >
      {busy ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const badgeTones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-800',
  info: 'bg-indigo-100 text-indigo-ink-900',
  success: 'bg-emerald-100 text-emerald-ink-900',
  warning: 'bg-amber-100 text-amber-ink-900',
  danger: 'bg-red-100 text-red-ink-900',
};

/**
 * A status label: one shape (a pill) and one size everywhere, its colour saying what kind of
 * state it is, so the same colour means the same thing in every list.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  className = '',
  children,
}: {
  tone?: Tone;
  /** A small dot before the text, for a state that is live (in progress, online). */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[tone]} ${className}`}
    >
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * Table styles shared by the administration lists, so they all read the same: a white table
 * with a border, small semibold column headings, rows about 44 px high, figures on the right.
 */
export const tableCls =
  'w-full border-collapse overflow-hidden rounded-xl border border-slate-200 bg-white text-sm';
export const thCls =
  'border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600';
export const tdCls = 'h-11 border-b border-slate-200 px-3 py-2 align-middle';
/** Add to a heading or cell holding figures. */
export const numCls = 'text-right tabular-nums';

export type NoticeTone = 'success' | 'info' | 'warning' | 'error';

const noticeTones: Record<NoticeTone, { box: string; mark: string }> = {
  info: { box: 'border-indigo-200 bg-indigo-50 text-indigo-ink-900', mark: 'i' },
  success: { box: 'border-emerald-200 bg-emerald-50 text-emerald-ink-900', mark: '✓' },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-ink-900', mark: '!' },
  error: { box: 'border-red-200 bg-red-50 text-red-ink-900', mark: '!' },
};

/**
 * The one way to confirm an action or warn about something on a page: a tinted box with a
 * mark, the message and, when the screen lets it go, a button to close it. Announced to screen
 * readers (errors at once, the rest politely): keep it rendered and change its children, empty
 * when there is nothing to say.
 */
export function Notice({
  tone = 'success',
  onClose,
  className = '',
  children,
}: {
  tone?: NoticeTone;
  /** Shows a close button that calls this. */
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { box, mark } = noticeTones[tone];
  // The live region stays on the page while empty, so a message put in it is announced.
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} data-tone={tone} className={className}>
      {children ? (
        <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm ${box}`}>
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-4 w-4 flex-none place-items-center rounded-full border border-current text-[10px] font-bold leading-none"
          >
            {mark}
          </span>
          <div className="min-w-0 flex-1">{children}</div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('app.close')}
              title={t('app.close')}
              className="-my-0.5 -mr-1 grid h-6 w-6 flex-none place-items-center rounded-full hover:bg-current/10"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 focus:border-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        {...rest}
      />
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-ink-800">
      {children}
    </p>
  );
}

/**
 * What a list shows before and instead of its data: "Loading…" (announced), the error with a
 * button to try again, or the empty message. With data, the children.
 */
export function QueryState({
  query,
  empty,
  isEmpty,
  children,
}: {
  query: { isPending: boolean; error: unknown; refetch(): unknown };
  /** Shown when the data came back empty. */
  empty?: ReactNode;
  isEmpty?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (query.error)
    return (
      <div className="flex flex-wrap items-center gap-3" data-testid="query-error">
        <ErrorText>{localiseError(t, query.error)}</ErrorText>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <p role="status" aria-busy="true" className="text-slate-600">
        {t('app.loading')}
      </p>
    );
  if (isEmpty && empty) return <p className="text-slate-600">{empty}</p>;
  return <>{children}</>;
}

/** Links to the About and Privacy pages (public, so also before signing in). */
export function InfoLinks({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('info.about')} className={`flex flex-wrap gap-4 text-sm ${className}`}>
      <a className="text-indigo-ink-700 underline" href="/about">
        {t('info.about')}
      </a>
      <a className="text-indigo-ink-700 underline" href="/privacy">
        {t('info.privacy')}
      </a>
      <a className="text-indigo-ink-700 underline" href="/terms">
        {t('info.terms')}
      </a>
    </nav>
  );
}

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="mb-6 flex items-center justify-center gap-3 text-3xl">
          <LogoMark className="h-11 w-11" />
          <LogoName />
        </p>
        <Card>
          <h1 className="mb-4 text-xl font-bold">{title}</h1>
          {children}
        </Card>
        <InfoLinks className="mt-4 justify-center" />
      </div>
    </main>
  );
}

/**
 * A file picker whose button and "no file" text are in the interface language (the browser's
 * own control shows them in the browser's language). The input keeps the field's label.
 */
export function FileInput({
  label,
  accept,
  inputRef,
  onChange,
  labelClassName = 'font-medium',
  multiple,
}: {
  label: string;
  accept: string;
  /** Several files at once; their names are listed. */
  multiple?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  labelClassName?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span id={`${id}-label`} className={labelClassName}>
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <label className="inline-flex flex-none cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-navy hover:border-indigo-600 hover:text-indigo-ink-600 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-600">
          <input
            ref={inputRef}
            id={id}
            type="file"
            accept={accept}
            multiple={multiple}
            aria-labelledby={`${id}-label`}
            className="sr-only"
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])].map((f) => f.name);
              setName(picked.length ? picked.join(', ') : null);
              onChange?.(e);
            }}
          />
          {t('app.chooseFile')}
        </label>
        <span className="min-w-0 truncate text-slate-600">{name ?? t('app.noFile')}</span>
      </div>
    </div>
  );
}
