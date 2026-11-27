import { useTranslation } from 'react-i18next';
import { BarTable, fmtNum, fmtPct } from './charts.js';

interface ItemHead {
  name: string;
  label: string;
  /** Computed by a formula, not asked. */
  computed?: boolean;
}

export type ToplineItem = ItemHead &
  (
    | {
        kind: 'single';
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
        base: number;
        rows: { code: string; label: string; count: number; percent: number | null }[];
      }
    | {
        kind: 'text';
        n: number;
        latest: string[];
        /** The commonest answers once spelling is evened out (older APIs: absent). */
        groups?: { text: string; count: number }[];
        distinct?: number;
      }
    | {
        kind: 'numeric';
        n: number;
        /** Don't know / refused, and no value (older APIs: absent). */
        specials?: number;
        blank?: number;
        mean: number | null;
        median: number | null;
        min: number | null;
        max: number | null;
      }
  );

/** One block per question: bars with counts and shares, or summary statistics. */
export function ToplineItems({ items }: { items: ToplineItem[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <div className="flex flex-col divide-y divide-slate-200" data-testid="topline">
      {items.map((item) => (
        <section
          key={item.name}
          className="break-inside-avoid py-4 first:pt-0 last:pb-0"
          aria-labelledby={`q-${item.name}`}
          data-variable={item.name}
        >
          <h3 id={`q-${item.name}`} className="font-medium">
            <span className="mr-2 font-mono text-xs text-slate-500">{item.name}</span>
            {item.computed && item.label === item.name ? null : item.label}
            {item.computed ? (
              <span
                className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700"
                data-testid="computed"
              >
                {t('analysis.results.computed')}
              </span>
            ) : null}
          </h3>
          {item.kind === 'text' ? (
            <div className="mt-1">
              <p className="text-slate-600">
                {t('analysis.results.written', { count: item.n })}
                {item.distinct !== undefined && item.n
                  ? ` · ${t('analysis.results.distinct', { count: item.distinct })}`
                  : ''}
              </p>
              {item.groups?.length ? (
                <div data-testid={`answers-${item.name}`}>
                  <BarTable
                    max={item.n || undefined}
                    headers={[t('analysis.results.answer'), '%']}
                    rows={item.groups.map((g) => ({
                      key: g.text,
                      label: g.text,
                      value: g.count,
                      display: `${fmtPct(lang, item.n ? g.count / item.n : null)} (${g.count})`,
                    }))}
                  />
                </div>
              ) : item.latest.length ? (
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
              {item.groups && item.distinct !== undefined && item.distinct > item.groups.length ? (
                <p className="mt-1 text-slate-600">
                  {t('analysis.results.moreAnswers', {
                    count: item.distinct - item.groups.length,
                  })}
                </p>
              ) : null}
            </div>
          ) : item.kind === 'numeric' ? (
            <>
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
              {item.specials || item.blank ? (
                <p className="mt-1 text-slate-600" data-testid={`missing-${item.name}`}>
                  {[
                    item.specials ? t('analysis.results.specialsN', { count: item.specials }) : '',
                    item.blank ? t('analysis.results.blankN', { count: item.blank }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
            </>
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
      <p className="pt-4 text-xs text-slate-500">{t('analysis.results.rounding')}</p>
    </div>
  );
}
