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
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  /** `sm`: the compact size, the same as `smallBtn`, for rows of controls. */
  size?: 'md' | 'sm';
}) {
  const styles =
    variant === 'primary'
      ? 'border border-indigo-600 bg-indigo-600 text-on-fill hover:border-indigo-500 hover:bg-indigo-500 disabled:hover:border-indigo-600 disabled:hover:bg-indigo-600'
      : 'border border-slate-300 bg-white text-navy hover:border-indigo-600 hover:text-indigo-ink-600 disabled:hover:border-slate-300 disabled:hover:text-navy';
  return (
    <button
      className={`rounded-md ${size === 'sm' ? 'px-3 py-1' : 'px-4 py-2'} text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...rest}
    />
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
