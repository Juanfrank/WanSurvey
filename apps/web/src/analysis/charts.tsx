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

/** Completes per day as columns, with the table behind it one click away. */
export function DayColumns({ days }: { days: { day: string; completes: number }[] }) {
  const { t, i18n } = useTranslation();
  if (!days.length) return <p className="text-slate-600">–</p>;
  const max = Math.max(1, ...days.map((d) => d.completes));
  const w = 16;
  const h = 80;
  const short = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString(i18n.language, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  return (
    <div>
      <svg
        role="img"
        aria-label={days.map((d) => `${short(d.day)}: ${d.completes}`).join(', ')}
        viewBox={`0 0 ${days.length * w} ${h + 14}`}
        className="h-28 w-full max-w-xl"
        preserveAspectRatio="none"
      >
        {days.map((d, i) => {
          const bh = (h * d.completes) / max;
          return (
            <g key={d.day}>
              <rect
                x={i * w + 2}
                y={h - bh}
                width={w - 4}
                height={bh}
                className="fill-indigo-600"
              />
              <text
                x={i * w + w / 2}
                y={h - bh - 2}
                textAnchor="middle"
                className="fill-slate-700"
                fontSize="7"
              >
                {d.completes}
              </text>
            </g>
          );
        })}
        <line x1="0" x2={days.length * w} y1={h} y2={h} className="stroke-slate-300" />
        <text x="0" y={h + 11} fontSize="7" className="fill-slate-600">
          {short(days[0]!.day)}
        </text>
        <text
          x={days.length * w}
          y={h + 11}
          fontSize="7"
          textAnchor="end"
          className="fill-slate-600"
        >
          {short(days[days.length - 1]!.day)}
        </text>
      </svg>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer text-indigo-700">{t('analysis.live.table')}</summary>
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
