import type { AnswerOption, Code, LocalizedText } from '@wansurvey/schema';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toLiteral } from './ConditionBuilder.js';
import { inputCls, smallBtn, useShownLanguages, useSourceLanguage } from './fields.js';
import { PipeField } from './PipeAssist.js';

type Row = { code: Code; label: LocalizedText } & Partial<
  Pick<AnswerOption, 'exclusive' | 'otherSpecify' | 'fixedPosition'>
>;

/** The flags of an option and the sign on their toggle. */
const FLAGS = [
  ['exclusive', '⊘'],
  ['otherSpecify', '✎'],
  ['fixedPosition', '⇥'],
] as const;

function nextCode(rows: Row[]): Code {
  const nums = rows.map((r) => r.code).filter((c): c is number => typeof c === 'number');
  return nums.length ? Math.max(...nums.filter((n) => n >= 0), 0) + 1 : rows.length + 1;
}

/**
 * Codes and labels per language, in order. Alt+↑/↓ in a row moves it; Enter in the last label
 * adds a new option. Used for options, grid rows and answer sets.
 */
export function OptionsEditor({
  label,
  rows,
  languages,
  onChange,
  flags = true,
  addLabel,
}: {
  label: string;
  rows: Row[];
  languages: string[];
  onChange(rows: Row[]): void;
  /** Show exclusive / other-specify / fixed flags (not for grid rows). */
  flags?: boolean;
  /** Text of the add button (default "Add option"). */
  addLabel?: string;
}) {
  const { t } = useTranslation();
  const table = useRef<HTMLTableElement>(null);
  const uid = useId();
  // The same rule as the analyzer's empty_option_label / empty_row_label: no text in any language.
  const unlabelled = (r: Row) => !Object.values(r.label ?? {}).some((v) => v.trim() !== '');
  const duplicates = new Set(
    rows.map((r) => String(r.code)).filter((c, i, all) => all.indexOf(c) !== i),
  );

  const set = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, j) => (j === i ? ({ ...r, ...patch } as Row) : r)));
  const moveRow = (i: number, delta: number) => {
    const to = i + delta;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [r] = next.splice(i, 1);
    next.splice(to, 0, r!);
    onChange(next);
    requestAnimationFrame(() => {
      table.current
        ?.querySelector<HTMLInputElement>(`tbody tr:nth-child(${to + 1}) input`)
        ?.focus();
    });
  };
  const shown = useShownLanguages(languages);
  // Translating: the default language's label, read-only, beside each one.
  const source = useSourceLanguage(languages);
  const add = () => {
    onChange([
      ...rows,
      { code: nextCode(rows), label: Object.fromEntries(languages.map((l) => [l, ''])) },
    ]);
    requestAnimationFrame(() => {
      table.current?.querySelector<HTMLInputElement>('tbody tr:last-child input')?.focus();
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="overflow-x-auto">
        <table ref={table} className="w-full min-w-[28rem] text-sm">
          <caption className="mb-1 text-left text-sm font-medium text-slate-700">{label}</caption>
          <thead>
            <tr className="text-left text-xs text-slate-600">
              <th scope="col" className="w-20 pb-1 font-medium">
                {t('designer.opt.code')}
              </th>
              {source ? (
                <th scope="col" className="pb-1 font-medium">
                  {t('designer.sourceText', { lang: source })}
                </th>
              ) : null}
              {shown.map((l) => (
                <th key={l} scope="col" className="pb-1 font-medium">
                  {t('designer.opt.label')} ({l})
                </th>
              ))}
              {flags ? (
                <th scope="col" className="pb-1 font-medium">
                  {t('designer.opt.flags')}
                </th>
              ) : null}
              <th scope="col" className="pb-1">
                <span className="sr-only">{t('designer.opt.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                className="align-top"
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    e.stopPropagation();
                    moveRow(i, e.key === 'ArrowUp' ? -1 : 1);
                  }
                }}
              >
                <td className="py-1 pr-2">
                  <input
                    type="text"
                    className={`${inputCls} font-mono`}
                    aria-label={t('designer.opt.codeN', { n: i + 1 })}
                    aria-invalid={duplicates.has(String(r.code)) ? true : undefined}
                    value={String(r.code)}
                    onChange={(e) => set(i, { code: toLiteral(e.target.value) })}
                  />
                </td>
                {source ? (
                  <td className="py-2 pr-2 text-slate-700" data-testid="source-label">
                    {r.label[source]?.trim() || (
                      <span className="italic text-slate-500">{t('designer.sourceEmpty')}</span>
                    )}
                  </td>
                ) : null}
                {shown.map((l, li) => (
                  <td key={l} className="py-1 pr-2">
                    <PipeField
                      className={inputCls}
                      aria-label={t('designer.opt.labelN', { n: i + 1, lang: l })}
                      aria-invalid={unlabelled(r) ? true : undefined}
                      aria-describedby={unlabelled(r) ? `${uid}-nolabel-${i}` : undefined}
                      value={r.label[l] ?? ''}
                      onChange={(e) => set(i, { label: { ...r.label, [l]: e.target.value } })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && i === rows.length - 1 && li === shown.length - 1) {
                          e.preventDefault();
                          add();
                        }
                      }}
                    />
                    {unlabelled(r) && li === 0 ? (
                      <p
                        id={`${uid}-nolabel-${i}`}
                        className="mt-0.5 text-xs text-red-ink-800"
                        data-testid="option-no-label"
                      >
                        {t('designer.opt.noLabel', { n: String(r.code) })}
                      </p>
                    ) : null}
                  </td>
                ))}
                {flags ? (
                  <td className="py-1 pr-2">
                    {/* One line of toggles (an icon each, named and titled), not three
                    checkboxes stacked under each other. */}
                    <div className="flex gap-1 whitespace-nowrap" data-testid="option-flags">
                      {FLAGS.map(([f, icon]) => {
                        const name = t('designer.opt.flagN', {
                          flag: t(`designer.opt.${f}`),
                          n: i + 1,
                        });
                        return (
                          <button
                            key={f}
                            type="button"
                            aria-pressed={!!r[f]}
                            aria-label={name}
                            title={name}
                            className={`flex size-8 items-center justify-center rounded-md border text-sm ${
                              r[f]
                                ? 'border-indigo-600 bg-indigo-50 font-semibold text-indigo-ink-700'
                                : 'border-slate-200 text-slate-600 hover:border-slate-400'
                            }`}
                            onClick={() => set(i, { [f]: r[f] ? undefined : true })}
                          >
                            <span aria-hidden="true">{icon}</span>
                          </button>
                        );
                      })}
                    </div>
                  </td>
                ) : null}
                <td className="whitespace-nowrap py-1">
                  <button
                    type="button"
                    className={smallBtn}
                    aria-label={t('designer.opt.up', { n: i + 1 })}
                    disabled={i === 0}
                    onClick={() => moveRow(i, -1)}
                  >
                    ↑
                  </button>{' '}
                  <button
                    type="button"
                    className={smallBtn}
                    aria-label={t('designer.opt.down', { n: i + 1 })}
                    disabled={i === rows.length - 1}
                    onClick={() => moveRow(i, 1)}
                  >
                    ↓
                  </button>{' '}
                  <button
                    type="button"
                    className={smallBtn}
                    aria-label={t('designer.opt.remove', { n: i + 1 })}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {duplicates.size ? (
        <p className="text-xs text-red-ink-800">
          {t('designer.opt.duplicate', { codes: [...duplicates].join(', ') })}
        </p>
      ) : null}
      <div>
        <button type="button" className={smallBtn} onClick={add}>
          {addLabel ?? t('designer.opt.add')}
        </button>
        <span className="ml-2 text-xs text-slate-600">{t('designer.opt.keys')}</span>
      </div>
    </div>
  );
}
