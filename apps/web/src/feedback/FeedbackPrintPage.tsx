import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { QrCode } from '../papi/QrCode.js';
import { Button } from '../routes/ui.js';
import { Face } from './Faces.js';
import type { FeedbackPoint } from './FeedbackSection.js';

const LAYOUTS = [4, 6, 8] as const;

/**
 * Feedback slips to print (F1): several small cards per sheet, with cutting lines. Each has the
 * question, the faces with a circle to fill, lines for a comment, and a QR code to answer on a
 * phone. Marked slips are keyed in the office with one click per slip.
 */
export function FeedbackPrintPage() {
  const { projectId, pointId } = useParams({ strict: false }) as {
    projectId: string;
    pointId: string;
  };
  const { t, i18n } = useTranslation();
  const [perPage, setPerPage] = useState<(typeof LAYOUTS)[number]>(8);
  const list = useQuery({
    queryKey: ['feedback', projectId],
    queryFn: () => api<FeedbackPoint[]>(`/projects/${projectId}/feedback`),
  });
  const p = list.data?.find((x) => x.id === pointId);
  const labels = p ? (t(`feedback.labels${p.faces}`, { returnObjects: true }) as string[]) : [];
  const question = p ? (p.question[i18n.language] ?? Object.values(p.question)[0] ?? '') : '';
  const rows = perPage / 2;
  return (
    <div className="flex flex-col gap-6" data-testid="feedback-print">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'questionnaires' }}
          className="text-sm text-slate-600 hover:underline"
        >
          ← {t('feedback.back')}
        </Link>
        <h1 className="text-2xl font-bold">{t('feedback.print')}</h1>
        {p ? <span className="text-sm text-slate-700">{p.name}</span> : null}
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('feedback.perPage')}</span>
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1"
            value={perPage}
            onChange={(e) => setPerPage(Number(e.target.value) as (typeof LAYOUTS)[number])}
          >
            {LAYOUTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" onClick={() => window.print()} disabled={!p}>
          {t('feedback.printNow')}
        </Button>
      </div>
      {p ? (
        <div
          className="mx-auto grid w-full max-w-[210mm] grid-cols-2 bg-white text-slate-900 print:max-w-none"
          style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: perPage }, (_, i) => (
            <article
              key={i}
              className="flex break-inside-avoid flex-col gap-2 border border-dashed border-slate-400 p-4 font-serif"
              style={{ height: `${277 / rows}mm` }}
              data-slip={i + 1}
            >
              <p className="text-xs uppercase tracking-wide text-slate-600">{p.name}</p>
              <p className="font-semibold leading-snug">{question}</p>
              <p className="text-[11px] italic">{t('feedback.slipFill')}</p>
              <div className="flex justify-around">
                {Array.from({ length: p.faces }, (_, k) => k + 1).map((s) => (
                  <span key={s} className="flex flex-col items-center gap-1">
                    <Face score={s} faces={p.faces} size={perPage === 8 ? 30 : 38} filled={false} />
                    <span
                      role="img"
                      aria-label={labels[s - 1]}
                      className="inline-block size-4 rounded-full border-[1.5px] border-slate-900"
                    />
                    <span className="text-[10px]">{labels[s - 1]}</span>
                  </span>
                ))}
              </div>
              {p.askComment && perPage <= 6 ? (
                <div className="flex flex-col gap-3 pt-1 text-[11px]">
                  <span>{t('feedback.slipComment')}</span>
                  <span className="block border-b border-slate-700" />
                  <span className="block border-b border-slate-700" />
                </div>
              ) : null}
              <div className="mt-auto flex items-end justify-between gap-2">
                <span className="text-[10px] italic">{t('feedback.slipScan')}</span>
                <QrCode value={p.url} label={p.url} size={perPage === 8 ? 56 : 72} />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p aria-busy="true">…</p>
      )}
    </div>
  );
}
