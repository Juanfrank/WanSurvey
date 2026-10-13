import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

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
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  const styles =
    variant === 'primary'
      ? 'border border-indigo-600 bg-indigo-600 text-white hover:border-indigo-500 hover:bg-indigo-500 disabled:border-indigo-300 disabled:bg-indigo-300'
      : 'border border-slate-300 bg-white text-navy hover:border-indigo-600 hover:text-indigo-600';
  return (
    <button
      className={`rounded-md px-4 py-2 text-sm font-semibold ${styles} ${className}`}
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
        className="rounded-md border border-slate-300 bg-white px-3 py-2 focus:border-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        {...rest}
      />
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-2xl font-bold tracking-tight text-navy">WanSurvey</p>
        <Card>
          <h1 className="mb-4 text-xl font-bold">{title}</h1>
          {children}
        </Card>
      </div>
    </main>
  );
}
