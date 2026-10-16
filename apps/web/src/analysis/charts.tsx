import { useTranslation } from 'react-i18next';

export const fmtPct = (lang: string, v: number | null | undefined, digits = 0) =>
  v === null || v === undefined
    ? '–'
    : new Intl.NumberFormat(lang, {
        style: 'percent',
        maximumFractionDigits: digits,
      }).format(v);

export const fmtNum = (lang: string, v: number | null | undefined, digits = 1) =>
  v === null || v === undefined
    ? '–'
    : new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(v);

export interface Bar {
  key: string;
  label: string;
  value: number;
  /** Text shown after the bar (a count, a percentage…). */
  display: string;
  /** Greyed out: not part of the base (don't know, refused). */
  muted?: boolean;
}

/**
 * Horizontal bars as a real table: the label, a bar scaled to the largest value, and the
 * figure written out, so screen readers and print get the numbers, not the picture.
 */
export function BarTable({
  caption,
  rows,
  max,
  headers,
}: {
  caption?: string;
  rows: Bar[];
  max?: number;
  headers?: [string, string];
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <table className="w-full border-collapse text-sm">
      {caption ? <caption className="mb-1 text-left font-medium">{caption}</caption> : null}
      {headers ? (
        <thead className="sr-only">
          <tr>
            <th scope="col">{headers[0]}</th>
            <th scope="col">{headers[1]}</th>
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.muted ? 'text-slate-500' : ''}>
            <th scope="row" className="w-2/5 py-0.5 pr-3 text-left font-normal">
              {r.label}
            </th>
            <td className="py-0.5">
              <div className="flex items-center gap-2">
                <div className="h-3 flex-1 rounded-sm bg-slate-100 print:border print:border-slate-300">
                  <div
                    aria-hidden="true"
                    className={`h-3 rounded-sm ${r.muted ? 'bg-slate-400' : 'bg-indigo-600'} print:bg-slate-700`}
                    style={{ width: `${Math.min(100, (100 * r.value) / top)}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right tabular-nums">{r.display}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Progress towards a target, with the numbers written out. */
export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className="h-3 w-full rounded-full bg-slate-100"
    >
      <div
        className="h-3 rounded-full bg-emerald-600"
        style={{ width: `${Math.min(100, (100 * value) / Math.max(1, max))}%` }}
      />
    </div>
  );
}

/** Every day of the 30 ending with the last day given (or today), missing days as 0. */
function fillDays(days: { day: string; completes: number }[], span = 30) {
  const by = new Map(days.map((d) => [d.day, d.completes]));
  const today = new Date().toISOString().slice(0, 10);
  const lastDay = days.reduce((m, d) => (d.day > m ? d.day : m), today);
  const end = new Date(`${lastDay}T12:00:00Z`);
  return Array.from({ length: span }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (span - 1 - i));
    const day = d.toISOString().slice(0, 10);
    return { day, completes: by.get(day) ?? 0 };
  });
}

/**
 * Completes per day as columns, with the table behind it one click away. Drawn with HTML
 * boxes rather than a stretched SVG, so the figures keep their shape at any width and the
 * tallest column still has room for its label.
 */
export function DayColumns({ days: given }: { days: { day: string; completes: number }[] }) {
  const { t, i18n } = useTranslation();
  if (!given.length) return <p className="text-slate-600">–</p>;
  const days = fillDays(given);
  const max = Math.max(1, ...days.map((d) => d.completes));
  const short = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString(i18n.language, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  return (
    <div>
      <div
        role="img"
        aria-label={days.map((d) => `${short(d.day)}: ${d.completes}`).join(', ')}
        className="w-full max-w-2xl"
      >
        <div className="flex h-32 items-end gap-[2px] border-b border-slate-300 pt-4">
          {days.map((d) => (
            <div
              key={d.day}
              title={`${short(d.day)}: ${d.completes}`}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
            >
              {d.completes ? (
                <span className="mb-0.5 text-[10px] leading-none tabular-nums text-slate-700">
                  {d.completes}
                </span>
              ) : null}
              <div
                aria-hidden="true"
                className="w-full max-w-6 rounded-t-sm bg-indigo-600 print:bg-slate-700"
                style={{ height: `${(100 * d.completes) / max}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-slate-600">
          <span>{short(days[0]!.day)}</span>
          <span>{short(days[days.length - 1]!.day)}</span>
        </div>
      </div>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer text-indigo-ink-700">{t('analysis.live.table')}</summary>
        <table className="mt-1 text-sm">
          <thead>
            <tr>
              <th scope="col" className="pr-4 text-left">
                {t('analysis.live.day')}
              </th>
              <th scope="col" className="text-right">
                {t('analysis.live.completes')}
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td className="pr-4">{short(d.day)}</td>
                <td className="text-right tabular-nums">{d.completes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
