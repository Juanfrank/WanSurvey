import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useCan } from '../designer/hooks.js';
import { Notice } from '../routes/ui.js';

/**
 * How long the project keeps personal data, on its overview: the period and what happens when it
 * ends, or a warning when there is none. Who configures the project also sees how many cases
 * reach the period tonight, and a link to change it.
 */
export function RetentionNotice({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const canConfigure = useCan('projects.update', projectId);
  // The project page's own query: the same cache entry.
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () =>
      api<{ settings?: { retention?: { anonymiseAfterDays: number | null } } }>(
        `/projects/${projectId}`,
      ),
  });
  const days = project.data?.settings?.retention?.anonymiseAfterDays ?? null;
  const preview = useQuery({
    queryKey: ['retention-preview', projectId, days],
    queryFn: () =>
      api<{ due: number; more: boolean }>(
        `/projects/${projectId}/privacy/retention-preview?days=${days}`,
      ),
    enabled: canConfigure && days !== null,
  });
  if (!project.data) return null;
  const change = canConfigure ? (
    <Link
      to="/projects/$projectId"
      params={{ projectId }}
      search={{ tab: 'settings', topic: 'privacy' }}
      className="font-medium underline"
    >
      {t('analysis.retention.change')}
    </Link>
  ) : null;
  return (
    <section aria-labelledby="retention-title" data-testid="retention-notice">
      <h2 id="retention-title" className="sr-only">
        {t('analysis.retention.title')}
      </h2>
      <Notice tone={days === null ? 'warning' : 'info'}>
        <p>
          <strong>{t('analysis.retention.title')}: </strong>
          {days === null ? (
            <>
              {t('analysis.retention.none')} {t('analysis.retention.noneHelp')}
            </>
          ) : (
            <>
              {t('analysis.retention.days', { count: days })} {t('analysis.retention.then')}
            </>
          )}
        </p>
        {preview.data || change ? (
          <p className="mt-1">
            {preview.data
              ? preview.data.due === 0
                ? t('analysis.retention.tonightNone')
                : t(
                    preview.data.more
                      ? 'analysis.retention.tonightMore'
                      : 'analysis.retention.tonight',
                    { count: preview.data.due },
                  )
              : null}
            {preview.data && change ? ' · ' : null}
            {change}
          </p>
        ) : null}
      </Notice>
    </section>
  );
}
