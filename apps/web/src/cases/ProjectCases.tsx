import { useQuery } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { subTabCls } from '../routes/tabs.js';
import { api } from '../api.js';
import { useCan } from '../designer/hooks.js';
import { CasesTab } from './CasesTab.js';
import { SamplingTab } from './SamplingTab.js';
import { QuestionnaireScope } from './scope.js';

export type CasesSub = 'list' | 'sampling';

const pillCls =
  'rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50 aria-pressed:text-indigo-ink-700';

/**
 * The project's cases, per questionnaire (each has its own sample, cases and rules): a
 * switch between the questionnaires (kept in `?q=`), then the sampling selector and the list.
 */
export function ProjectCases({
  projectId,
  sub,
  onSub,
}: {
  projectId: string;
  sub: CasesSub;
  onSub(s: CasesSub): void;
}) {
  const { t } = useTranslation();
  const canAll = useCan('cases.read_all', projectId);
  const canOwn = useCan('cases.read_assigned', projectId);
  const canList = canAll || canOwn;
  const canImport = useCan('cases.import', projectId);
  const canQuestionnaires = useCan('questionnaires.read', projectId);
  const search = useSearch({ strict: false }) as { q?: string };
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; createdAt: string }[]>(
        `/projects/${projectId}/questionnaires`,
      ),
    enabled: canQuestionnaires,
  });
  // Oldest first, as the API takes the project's first questionnaire by default.
  const qs = [...(list.data ?? [])].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  // Without the questionnaire list (interviewers), every case of theirs is shown.
  const current = qs.find((q) => q.id === search.q)?.id ?? qs[0]?.id;
  const pick = (q: string) =>
    void navigate({
      to: '.',
      search: (s: Record<string, unknown>) => ({ ...s, q }),
      replace: true,
    });

  // The sample is chosen before the list of cases it makes.
  const subs: CasesSub[] = [
    ...(canImport ? (['sampling'] as const) : []),
    ...(canList ? (['list'] as const) : []),
  ];
  const active = subs.includes(sub) ? sub : (subs.at(-1) ?? 'list');
  // Wait for the questionnaires, so the views do not start over when they arrive.
  if (canQuestionnaires && list.isPending) return <p aria-busy="true">…</p>;
  if (canQuestionnaires && list.isSuccess && !qs.length)
    return <p className="text-sm text-slate-600">{t('cases.tabs.noQuestionnaire')}</p>;

  return (
    <QuestionnaireScope.Provider value={current}>
      <div className="flex flex-col gap-4">
        {qs.length > 1 ? (
          <div
            role="group"
            aria-label={t('cases.tabs.questionnaire')}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-sm font-medium text-slate-600">
              {t('cases.tabs.questionnaire')}
            </span>
            {qs.map((q) => (
              <button
                key={q.id}
                type="button"
                aria-pressed={q.id === current}
                className={pillCls}
                onClick={() => pick(q.id)}
              >
                {q.name}
              </button>
            ))}
          </div>
        ) : null}
        {subs.length > 1 ? (
          <Tabs.Root
            value={active}
            onValueChange={(v) => onSub(v as CasesSub)}
            className="flex flex-col gap-4"
          >
            <Tabs.List aria-label={t('cases.tabs.casesSections')} className="flex flex-wrap gap-1">
              {subs.map((x) => (
                <Tabs.Trigger key={x} value={x} className={subTabCls}>
                  {t(`cases.tabs.${x}`)}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            {/* Keyed by questionnaire, so each one's forms start from its own data. */}
            <Tabs.Content value="sampling">
              <SamplingTab key={current} projectId={projectId} />
            </Tabs.Content>
            <Tabs.Content value="list">
              <CasesTab key={current} projectId={projectId} />
            </Tabs.Content>
          </Tabs.Root>
        ) : active === 'sampling' ? (
          <SamplingTab key={current} projectId={projectId} />
        ) : (
          <CasesTab key={current} projectId={projectId} />
        )}
      </div>
    </QuestionnaireScope.Provider>
  );
}
