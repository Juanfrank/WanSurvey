import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { PaperForm, pick } from '@wansurvey/renderer';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Button } from '../routes/ui.js';
import { QrCode } from './QrCode.js';

interface Forms {
  questionnaire: { id: string; name: string };
  version: number;
  compiled: CompiledQuestionnaire;
  cases: { id: string; externalId: string; sample: Record<string, unknown> }[];
}

/**
 * Printable paper forms (P1): per case a cover with the case id, its QR code and the case
 * data, then the questionnaire with codes beside the options and routing as instructions.
 * The browser prints it or saves it as PDF.
 */
export function PrintPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const search = useSearch({ strict: false }) as {
    filter?: string;
    limit?: number;
    caseIds?: string;
  };
  const { t } = useTranslation();
  const forms = useQuery({
    queryKey: ['papi-forms', projectId, search],
    queryFn: () => {
      const q = new URLSearchParams();
      if (search.filter) q.set('filter', search.filter);
      if (search.limit) q.set('limit', String(search.limit));
      if (search.caseIds) q.set('caseIds', search.caseIds);
      return api<Forms>(`/projects/${projectId}/papi/forms?${q.toString()}`);
    },
  });
  const f = forms.data;
  const lang = f?.compiled.questionnaire.defaultLanguage ?? 'es';
  return (
    <div className="flex flex-col gap-6" data-testid="print">
      <div className="no-print flex flex-wrap items-center gap-3">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'paper' }}
          className="text-sm text-slate-600 hover:underline"
        >
          {t('papi.print.back')}
        </Link>
        <h1 className="text-2xl font-bold">{t('papi.print.title')}</h1>
        {f ? (
          <span className="text-sm text-slate-700">
            {f.questionnaire.name} · v{f.version} ·{' '}
            {t('papi.print.count', { count: f.cases.length })}
          </span>
        ) : null}
        <Button type="button" onClick={() => window.print()} disabled={!f?.cases.length}>
          {t('papi.print.print')}
        </Button>
      </div>
      {f && !f.cases.length ? <p>{t('papi.print.none')}</p> : null}
      {f?.cases.map((c) => (
        <article
          key={c.id}
          className="paper-form break-after-page rounded-xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:p-0 print:shadow-none"
          data-case={c.externalId}
          lang={lang}
        >
          <header className="mb-6 flex items-start justify-between gap-6 border-b-2 border-slate-800 pb-4">
            <div className="flex flex-col gap-2">
              <p className="text-lg font-semibold">{pick(f.compiled.questionnaire.title, lang)}</p>
              <p className="text-3xl font-bold tracking-wide">
                <span className="mr-2 text-base font-normal text-slate-600">
                  {t('papi.print.case')}
                </span>
                {c.externalId}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                {Object.entries(c.sample).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-slate-600">{k}</dt>
                    <dd>{v === null || v === undefined ? '—' : String(v)}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                {(['interviewer', 'date', 'duration'] as const).map((k) => (
                  <p key={k}>
                    {t(`papi.print.${k}`)}:{' '}
                    <span className="inline-block w-32 border-b border-slate-800">&nbsp;</span>
                  </p>
                ))}
              </div>
            </div>
            <QrCode value={c.externalId} label={t('papi.print.qr', { id: c.externalId })} />
          </header>
          <PaperForm compiled={f.compiled} lang={lang} />
        </article>
      ))}
    </div>
  );
}
