import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';

interface Area {
  pageId: string;
  /** Fractions of the scanned page. */
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ScanInfo {
  projectId: string;
  pages: { id: string; width: number; height: number }[];
  questions: Record<
    string,
    { reading: 'marks' | 'manual'; issue: { kind: string; detail?: string } | null; areas: Area[] }
  >;
}

/**
 * The second round of a scanned form: beside the question being keyed, the cut-out of the
 * scanned page where it is, and why it was left (handwriting, several marks…).
 */
export function ScanPanel({
  interviewId,
  currentKey,
}: {
  interviewId: string;
  currentKey: string | null;
}) {
  const { t } = useTranslation();
  const info = useQuery({
    queryKey: ['interview-scan', interviewId],
    queryFn: () => api<ScanInfo>(`/interviews/${interviewId}/scan`),
    retry: false,
    staleTime: Infinity,
  });
  if (!info.data || !currentKey) return null;
  // Questions in a roster are shown as the roster's area.
  const name = currentKey.replace(/\[.*$/, '');
  const q = info.data.questions[name];
  const projectId = info.data.projectId;
  return (
    <section
      aria-labelledby="scan-panel"
      className="flex flex-col gap-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 text-sm"
      data-testid="scan-panel"
    >
      <h2 id="scan-panel" className="font-semibold">
        {t('papi.scans.panel')}
      </h2>
      {q?.issue ? (
        <p data-testid="scan-reason">
          {t('papi.scans.reason', {
            reason: t(`papi.scans.kinds.${q.issue.kind}`),
          })}
          {q.issue.detail ? <span className="text-slate-600"> · {q.issue.detail}</span> : null}
        </p>
      ) : null}
      {q?.areas.length ? (
        q.areas.map((a, i) => {
          const page = info.data.pages.find((p) => p.id === a.pageId);
          if (!page || a.w <= 0 || a.h <= 0) return null;
          const src = `/api/v1/projects/${projectId}/papi/scans/pages/${a.pageId}`;
          return (
            <div
              key={i}
              className="relative w-full overflow-hidden rounded border border-slate-300 bg-white"
              style={{ aspectRatio: `${a.w * page.width} / ${a.h * page.height}` }}
            >
              <img
                src={src}
                alt=""
                className="absolute max-w-none"
                style={{
                  width: `${100 / a.w}%`,
                  left: `${(-a.x / a.w) * 100}%`,
                  top: `${(-a.y / a.h) * 100}%`,
                }}
              />
            </div>
          );
        })
      ) : (
        <p className="text-slate-600">{t('papi.scans.panelEmpty')}</p>
      )}
    </section>
  );
}
