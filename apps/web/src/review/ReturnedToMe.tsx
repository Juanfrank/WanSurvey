import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { smallBtn } from '../designer/fields.js';
import { localiseError, modeLabel } from '../i18n-messages.js';
import { deviceId, keepOnDevice, type InterviewPayload } from '../interview/useInterview.js';
import { FLAG_KINDS, minutes } from './ReviewTab.js';

interface Returned {
  id: string;
  externalId: string | null;
  mode: string;
  reviewer: string | null;
  comment: string | null;
  /** Comments on single questions not yet dealt with. */
  questions?: { variable: string; body: string }[];
}

interface OwnQuality {
  submitted: number;
  approved: number;
  rejected: number;
  returned: number;
  flagged: number;
  flags: Partial<Record<(typeof FLAG_KINDS)[number], number>>;
  medianMs: number | null;
  teamMedianMs: number | null;
}

/**
 * What review says about the caller's work: the interviews sent back to fix and resubmit (R1),
 * and their own quality signals.
 */
export function ReturnedToMe({ projectId }: { projectId: string }) {
  return (
    <>
      <Returned projectId={projectId} />
      <MyQuality projectId={projectId} />
    </>
  );
}

function Returned({ projectId }: { projectId: string }) {
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
            <span>{modeLabel(t, r.mode)}</span>
            {r.comment ? <span className="italic">“{r.comment}”</span> : null}
            <span className="text-slate-600">{r.reviewer}</span>
            <button type="button" className={smallBtn} onClick={() => void fix(r.id)}>
              {t('review.returned.fix', { id: r.externalId ?? '' })}
            </button>
            {r.questions?.length ? (
              <ul className="basis-full pl-4 text-slate-800" data-testid="returned-questions">
                {r.questions.map((c, i) => (
                  <li key={i}>
                    <span className="mr-1 font-mono text-xs">{c.variable}</span> {c.body}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <p role="alert" className="empty:hidden text-red-ink-800">
        {error}
      </p>
    </section>
  );
}

/** The caller's own quality signals, as a reviewer sees them, for early feedback. */
function MyQuality({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['review-mine', projectId],
    queryFn: () => api<OwnQuality>(`/projects/${projectId}/review/mine`),
  });
  const d = q.data;
  if (!d?.submitted) return null;
  const flags = FLAG_KINDS.filter((k) => d.flags[k]);
  return (
    <section
      aria-labelledby="my-quality-title"
      className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm"
      data-testid="my-quality"
    >
      <h2 id="my-quality-title" className="font-semibold">
        {t('review.mine.title')}
      </h2>
      <p className="mb-2 text-slate-700">{t('review.mine.help')}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <dt className="text-xs text-slate-600">{t('review.mine.approved')}</dt>
          <dd className="tabular-nums font-medium" data-key="approved">
            {t('review.mine.ofSubmitted', { n: d.approved, of: d.submitted })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('review.mine.returned')}</dt>
          <dd className="tabular-nums font-medium" data-key="returned">
            {d.returned}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('review.mine.rejected')}</dt>
          <dd className="tabular-nums font-medium" data-key="rejected">
            {d.rejected}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('review.mine.length')}</dt>
          <dd className="tabular-nums font-medium" data-key="length">
            {d.medianMs === null ? '—' : minutes(d.medianMs)}
            {d.teamMedianMs !== null ? (
              <span className="ml-1 text-xs font-normal text-slate-600">
                {t('review.mine.team', { time: minutes(d.teamMedianMs) })}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('review.mine.flagged')}</dt>
          <dd className="font-medium" data-key="flagged">
            <span className="tabular-nums">{d.flagged}</span>
            {flags.map((k) => (
              <span
                key={k}
                className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-ink-900"
                data-flag={k}
              >
                {t(`review.flags.${k}`)} · {d.flags[k]}
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </section>
  );
}
