import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { deviceId, keepOnDevice, type InterviewPayload } from '../interview/useInterview.js';

interface Returned {
  id: string;
  externalId: string | null;
  mode: string;
  reviewer: string | null;
  comment: string | null;
}

/** Interviews a reviewer sent back to the caller, to fix and resubmit (R1). */
export function ReturnedToMe({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['returned', projectId],
    queryFn: () => api<Returned[]>(`/projects/${projectId}/review/returned`),
  });
  if (!list.data?.length) return null;
  const fix = async (id: string) => {
    try {
      // This device takes the interview over, then it opens like any other.
      const p = await api<InterviewPayload>(`/interviews/${id}/takeover`, {
        method: 'POST',
        body: { deviceId: await deviceId() },
      });
      await keepOnDevice(p);
      await navigate({
        to: '/projects/$projectId/interviews/$interviewId',
        params: { projectId, interviewId: id },
      });
    } catch (e) {
      setError(localiseError(t, e));
    }
  };
  return (
    <section
      aria-labelledby="returned-title"
      className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm"
      data-testid="returned"
    >
      <h2 id="returned-title" className="font-semibold">
        {t('review.returned.title')}
      </h2>
      <p className="mb-2 text-slate-700">{t('review.returned.help')}</p>
      <ul className="flex flex-col gap-2">
        {list.data.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-3"
            data-case={r.externalId ?? ''}
          >
            <span className="font-medium">{r.externalId}</span>
            <span>{r.mode}</span>
            {r.comment ? <span className="italic">“{r.comment}”</span> : null}
            <span className="text-slate-600">{r.reviewer}</span>
            <button type="button" className={smallBtn} onClick={() => void fix(r.id)}>
              {t('review.returned.fix', { id: r.externalId ?? '' })}
            </button>
          </li>
        ))}
      </ul>
      <p role="alert" className="empty:hidden text-red-800">
        {error}
      </p>
    </section>
  );
}
