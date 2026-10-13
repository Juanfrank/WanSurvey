import {
  applyTexts,
  textsFromCsv,
  textsFromXliff,
  textsToCsv,
  textsToXliff,
  type ApplyResult,
} from '@wansurvey/logic';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Group, smallBtn } from './fields.js';
import type { Draft } from './tree.js';
import { FileInput } from '../routes/ui.js';

const PREVIEW_ROWS = 50;

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(file);
  });
}

function saveText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Sends texts to translators and back: a CSV with one column per language, or an XLIFF 2.0
 * file per target language. An import is previewed and applied as one change (Ctrl+Z undoes it).
 */
export function TranslationsPanel({ draft, change }: { draft: Draft; change(next: Draft): void }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<(ApplyResult & { file: string }) | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const source = draft.defaultLanguage;
  const targets = draft.languages.filter((l) => l !== source);

  const read = async (file: File) => {
    setError('');
    setDone('');
    setResult(null);
    try {
      const text = await readText(file);
      const rows = /\.(xlf|xliff)$/i.test(file.name)
        ? textsFromXliff(text).rows
        : textsFromCsv(text);
      setResult({ ...applyTexts(draft, rows), file: file.name });
    } catch (e) {
      setError(t('designer.translations.unreadable', { message: (e as Error).message }));
    }
  };

  return (
    <Group title={t('designer.translations.title')}>
      <p className="text-sm text-slate-600">{t('designer.translations.intro')}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={smallBtn}
          onClick={() => saveText(`${draft.id}-texts.csv`, textsToCsv(draft), 'text/csv')}
        >
          {t('designer.translations.exportCsv')}
        </button>
        {targets.map((l) => (
          <button
            key={l}
            type="button"
            className={smallBtn}
            onClick={() =>
              saveText(
                `${draft.id}-${source}-${l}.xlf`,
                textsToXliff(draft, source, l),
                'application/xliff+xml',
              )
            }
          >
            {t('designer.translations.exportXliff', { from: source, to: l })}
          </button>
        ))}
      </div>
      <FileInput
        label={t('designer.translations.import')}
        accept=".csv,.xlf,.xliff,text/csv,application/xliff+xml"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void read(f);
        }}
      />
      <div role="status" aria-live="polite" className="text-sm">
        {error ? <p className="text-red-ink-800">{error}</p> : null}
        {done ? <p>{done}</p> : null}
      </div>
      {result ? (
        <section
          aria-labelledby="tr-preview"
          className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
          data-testid="translation-preview"
        >
          <h3 id="tr-preview" className="font-semibold">
            {t('designer.translations.preview', { file: result.file })}
          </h3>
          <ul className="list-disc pl-5">
            <li>{t('designer.translations.changes', { count: result.changes.length })}</li>
            {result.unknownKeys.length ? (
              <li>
                {t('designer.translations.unknown', { count: result.unknownKeys.length })}{' '}
                <span className="font-mono text-xs">
                  {result.unknownKeys.slice(0, 10).join(', ')}
                </span>
              </li>
            ) : null}
            {result.ignoredLanguages.length ? (
              <li>
                {t('designer.translations.ignored', { langs: result.ignoredLanguages.join(', ') })}
              </li>
            ) : null}
            <li>{t('designer.translations.missing', { count: result.missing.length })}</li>
          </ul>
          {result.changes.length ? (
            <div className="max-h-72 overflow-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <caption className="sr-only">{t('designer.translations.changesTable')}</caption>
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th scope="col" className="px-2 py-1">
                      {t('designer.translations.key')}
                    </th>
                    <th scope="col" className="px-2 py-1">
                      {t('designer.translations.lang')}
                    </th>
                    <th scope="col" className="px-2 py-1">
                      {t('designer.translations.before')}
                    </th>
                    <th scope="col" className="px-2 py-1">
                      {t('designer.translations.after')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.changes.slice(0, PREVIEW_ROWS).map((c) => (
                    <tr key={`${c.key}:${c.lang}`}>
                      <td className="px-2 py-1 font-mono">{c.key}</td>
                      <td className="px-2 py-1">{c.lang}</td>
                      <td className="px-2 py-1 text-slate-600">{c.from || '—'}</td>
                      <td className="px-2 py-1">{c.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              className={smallBtn}
              disabled={!result.changes.length}
              onClick={() => {
                change(result.questionnaire);
                setDone(t('designer.translations.applied', { count: result.changes.length }));
                setResult(null);
              }}
            >
              {t('designer.translations.apply', { count: result.changes.length })}
            </button>
            <button type="button" className={smallBtn} onClick={() => setResult(null)}>
              {t('designer.translations.cancel')}
            </button>
          </div>
        </section>
      ) : null}
    </Group>
  );
}
