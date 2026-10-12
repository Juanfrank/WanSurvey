import type { AnswerOption, Code, LocalizedText } from '@wansurvey/schema';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toLiteral } from './ConditionBuilder.js';
import { inputCls, smallBtn, useShownLanguages } from './fields.js';

type Row = { code: Code; label: LocalizedText } & Partial<
  Pick<AnswerOption, 'exclusive' | 'otherSpecify' | 'fixedPosition'>
>;

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
}: {
  label: string;
  rows: Row[];
  languages: string[];
  onChange(rows: Row[]): void;
  /** Show exclusive / other-specify / fixed flags (not for grid rows). */
  flags?: boolean;
}) {
  const { t } = useTranslation();
  const table = useRef<HTMLTableElement>(null);
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
                {shown.map((l, li) => (
                  <td key={l} className="py-1 pr-2">
                    <input
                      type="text"
                      className={inputCls}
                      aria-label={t('designer.opt.labelN', { n: i + 1, lang: l })}
                      value={r.label[l] ?? ''}
                      onChange={(e) => set(i, { label: { ...r.label, [l]: e.target.value } })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && i === rows.length - 1 && li === shown.length - 1) {
                          e.preventDefault();
                          add();
                        }
                      }}
                    />
                  </td>
                ))}
                {flags ? (
                  <td className="py-1 pr-2">
                    <div className="flex flex-col gap-0.5 whitespace-nowrap text-xs">
                      {(['exclusive', 'otherSpecify', 'fixedPosition'] as const).map((f) => (
                        <label key={f} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={!!r[f]}
                            onChange={(e) => set(i, { [f]: e.target.checked || undefined })}
                          />
                          {t(`designer.opt.${f}`)}
                        </label>
                      ))}
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
        <p className="text-xs text-red-800">
          {t('designer.opt.duplicate', { codes: [...duplicates].join(', ') })}
        </p>
      ) : null}
      <div>
        <button type="button" className={smallBtn} onClick={add}>
          {t('designer.opt.add')}
        </button>
        <span className="ml-2 text-xs text-slate-600">{t('designer.opt.keys')}</span>
      </div>
    </div>
  );
}
