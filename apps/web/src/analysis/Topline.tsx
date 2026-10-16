import { useTranslation } from 'react-i18next';
import { BarTable, fmtNum, fmtPct } from './charts.js';

export type ToplineItem =
  | {
      kind: 'single';
      name: string;
      label: string;
      base: number;
      rows: {
        code: number;
        label: string;
        count: number;
        percent: number | null;
        missing: boolean;
      }[];
      /** For an ordinal scale: the mean of the valid answers. */
      mean?: number | null;
    }
  | {
      kind: 'multi';
      name: string;
      label: string;
      base: number;
      rows: { code: string; label: string; count: number; percent: number | null }[];
    }
  | { kind: 'text'; name: string; label: string; n: number; latest: string[] }
  | {
      kind: 'numeric';
      name: string;
      label: string;
      n: number;
      mean: number | null;
      median: number | null;
      min: number | null;
      max: number | null;
    };

/** One block per question: bars with counts and shares, or summary statistics. */
export function ToplineItems({ items }: { items: ToplineItem[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <div className="flex flex-col gap-6" data-testid="topline">
      {items.map((item) => (
        <section
          key={item.name}
          className="break-inside-avoid"
          aria-labelledby={`q-${item.name}`}
          data-variable={item.name}
        >
          <h3 id={`q-${item.name}`} className="font-medium">
            <span className="mr-2 font-mono text-xs text-slate-500">{item.name}</span> {item.label}
          </h3>
          {item.kind === 'text' ? (
            <div className="mt-1">
              <p className="text-slate-600">{t('analysis.results.written', { count: item.n })}</p>
              {item.latest.length ? (
                <>
                  <h4 className="sr-only">{t('analysis.results.latest')}</h4>
                  <ul className="mt-1 flex flex-col gap-1" data-testid={`latest-${item.name}`}>
                    {item.latest.map((text, i) => (
                      <li
                        key={i}
                        className="rounded-md border-l-4 border-indigo-200 bg-slate-50 px-3 py-1.5 text-slate-800"
                      >
                        {text}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-slate-600">{t('analysis.results.noneWritten')}</p>
              )}
            </div>
          ) : item.kind === 'numeric' ? (
            <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
              {(
                [
                  ['nValid', item.n, 0],
                  ['mean', item.mean, 1],
                  ['median', item.median, 1],
                  ['min', item.min, 1],
                  ['max', item.max, 1],
                ] as const
              ).map(([k, v, d]) => (
                <div key={k}>
                  <dt className="text-slate-600">{t(`analysis.results.${k}`)}</dt>
                  <dd className="font-semibold tabular-nums">{fmtNum(lang, v, d)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <p className="mb-1 text-slate-600">
                {t('analysis.results.base', { count: item.base })}
                {item.kind === 'single' && item.mean !== undefined ? (
                  <>
                    {' · '}
                    {t('analysis.results.mean')}: {fmtNum(lang, item.mean ?? null, 1)}
                  </>
                ) : null}
              </p>
              <BarTable
                max={item.base || undefined}
                headers={[item.label, '%']}
                rows={item.rows.map((r) => ({
                  key: String(r.code),
                  label: r.label,
                  value: r.count,
                  display:
                    r.percent === null
                      ? `(${r.count})`
                      : `${fmtPct(lang, r.percent / 100)} (${r.count})`,
                  muted: 'missing' in r && r.missing,
                }))}
              />
            </>
          )}
        </section>
      ))}
    </div>
  );
}
