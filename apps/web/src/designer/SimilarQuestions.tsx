import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';

interface Match {
  score: number;
  text: string;
  variable: string | null;
  origin: { kind: 'questionnaire' | 'library'; id: string; name: string; projectId: string | null };
}

/**
 * Questions already written like this one, in the organisation's other questionnaires and its
 * library: to avoid asking the same thing twice and to use the wording that is already in use.
 * Looked up only when asked for.
 */
export function SimilarQuestions({ text, lang }: { text: string; lang: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wording = text.trim();
  if (wording.length < 3) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="similar">
      <button
        type="button"
        className="self-start text-indigo-ink-700 underline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t('designer.similar.button')}
      </button>
      {open ? <SimilarResults wording={wording} lang={lang} /> : null}
    </div>
  );
}

/** The matches; the route (project and questionnaire) is read only once they are asked for. */
function SimilarResults({ wording, lang }: { wording: string; lang: string }) {
  const { t } = useTranslation();
  const { projectId, qid } = useParams({ strict: false }) as { projectId?: string; qid?: string };
  const found = useQuery({
    queryKey: ['similar', projectId, qid, lang, wording],
    queryFn: () =>
      api<Match[]>(`/projects/${projectId}/questionnaires/similar`, {
        method: 'POST',
        body: { text: wording, language: lang, ...(qid ? { questionnaireId: qid } : {}) },
      }),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  if (!projectId) return null;
  if (found.isLoading) return <p role="status">{t('designer.similar.loading')}</p>;
  if (!found.data?.length) return <p role="status">{t('designer.similar.none')}</p>;
  return (
    <ul className="flex flex-col gap-1.5" aria-label={t('designer.similar.button')}>
      {found.data.map((m, i) => (
        <li key={i} className="rounded-md border border-slate-200 bg-white p-2">
          <p>{m.text}</p>
          <p className="text-xs text-slate-600">
            {m.origin.kind === 'library'
              ? t('designer.similar.fromLibrary', { name: m.origin.name })
              : t('designer.similar.fromQuestionnaire', { name: m.origin.name })}
            {m.variable ? ` · ${m.variable}` : ''} ·{' '}
            {t('designer.similar.score', { pct: Math.round(m.score * 100) })}
          </p>
        </li>
      ))}
    </ul>
  );
}
