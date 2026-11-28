import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { roleHasPermission, type Permission, type Role } from '@wansurvey/schema';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectLogo } from './ProjectLogo.js';
import { api, type Me } from '../api.js';
import { dateTime, number } from '../format.js';
import { useMe } from './AppLayout.js';
import { Card, QueryState } from './ui.js';

interface ProjectRow {
  id: string;
  name: string;
  code: string;
  status: string;
  modesEnabled?: string[];
  settings?: {
    fieldwork?: {
      targetCompletes?: number | null;
      startsOn?: string | null;
      endsOn?: string | null;
    };
  };
}

/** `GET /home`: per project, only the parts the caller's roles allow. */
export interface HomeSummary {
  projects: {
    id: string;
    field: {
      completes: number;
      cases: number;
      unassigned: number;
      callbacksDue: number;
      activeNow: number;
      /** When an interview of the project last changed. */
      lastActivityAt?: string | null;
    } | null;
    review: { toReview: number; tooFast: number } | null;
    mine: {
      open: number;
      callbacksDue: number;
      nextCallbackAt: string | null;
      returned: number;
    } | null;
  }[];
  dueCallbacks: { projectId: string; caseId: string; externalId: string | null; at: string }[];
}

interface Goal {
  userId: string | null;
  target: number;
  completes: number;
  expectedByToday: number;
  periodCompletes: number;
  periodTarget: number;
  state: 'upcoming' | 'on_track' | 'behind' | 'met' | 'missed' | 'rest';
}

interface Member {
  status: 'active' | 'invited' | 'deactivated';
  totpEnabled: boolean;
  awaitingRole: boolean;
}

/** Whether a membership of the signed-in person allows something in a project. */
export function canIn(me: Me | undefined, permission: Permission, projectId: string) {
  return !!me?.memberships.some(
    (m) =>
      (m.permissions
        ? m.permissions.includes(permission)
        : roleHasPermission(m.role as Role, permission)) &&
      (m.projectId === null || m.projectId === projectId),
  );
}

/** Whether any membership allows something, anywhere. */
const canAnywhere = (me: Me | undefined, permission: Permission) =>
  !!me?.memberships.some((m) =>
    m.permissions
      ? m.permissions.includes(permission)
      : roleHasPermission(m.role as Role, permission),
  );

/** The goal in force today: a running one, else the next to start, else the latest. */
export function currentGoal(goals: Goal[]): Goal | undefined {
  return (
    goals.find((g) => g.state === 'on_track' || g.state === 'behind' || g.state === 'rest') ??
    goals.find((g) => g.state === 'upcoming') ??
    goals.at(-1)
  );
}

/** Whether someone works cases in a project through a field role (not as owner or admin). */
function worksCases(me: Me | undefined, projectId: string) {
  return !!me?.memberships.some(
    (m) =>
      m.role !== 'owner' &&
      m.role !== 'admin' &&
      (m.projectId === null || m.projectId === projectId) &&
      (['interviews.conduct', 'dataentry.key'] as const).some((p) =>
        m.permissions ? m.permissions.includes(p) : roleHasPermission(m.role as Role, p),
      ),
  );
}

const GOAL_CLS: Record<Goal['state'], string> = {
  upcoming: 'bg-slate-100 text-slate-800',
  rest: 'bg-slate-100 text-slate-800',
  on_track: 'bg-emerald-100 text-emerald-ink-900',
  met: 'bg-emerald-100 text-emerald-ink-900',
  behind: 'bg-amber-100 text-amber-ink-900',
  missed: 'bg-red-100 text-red-ink-900',
};

/**
 * Home, by role: what an administrator has pending (people without a role, invitations), the
 * interviewer's day (returned interviews, callbacks due, cases to do and their goal), and the
 * projects with their fieldwork, review queue and team pace for those who run them.
 */
export function HomePage() {
  const { t } = useTranslation();
  const me = useMe();
  const tenantId = me.data?.tenantId;
  const projects = useQuery({
    queryKey: ['projects', tenantId],
    queryFn: () => api<ProjectRow[]>('/projects'),
    enabled: !!me.data,
  });
  const summary = useQuery({
    queryKey: ['home', tenantId],
    queryFn: () => api<HomeSummary>('/home'),
    enabled: !!me.data,
    refetchInterval: 60_000,
  });
  const isAdmin = !!me.data?.permissions.includes('users.manage');
  const members = useQuery({
    // The users page's list, so both share it.
    queryKey: ['team', tenantId],
    queryFn: () => api<Member[]>('/users'),
    enabled: isAdmin,
  });
  const byId = new Map((summary.data?.projects ?? []).map((p) => [p.id, p]));
  const rows = projects.data ?? [];
  // Goals: one's own where one works cases, the team's where one follows the team.
  const goalProjects = rows.filter(
    (p) =>
      p.status === 'active' &&
      ((byId.get(p.id)?.mine && canIn(me.data, 'metrics.own', p.id)) ||
        (byId.get(p.id)?.field && canIn(me.data, 'metrics.team', p.id))),
  );
  const goalQueries = useQueries({
    queries: goalProjects.map((p) => ({
      queryKey: ['goals', p.id],
      queryFn: () => api<Goal[]>(`/projects/${p.id}/goals`),
    })),
  });
  const goals = new Map(goalProjects.map((p, i) => [p.id, goalQueries[i]?.data ?? []]));
  const myId = me.data?.user.id;
  const myGoal = (id: string) =>
    currentGoal((goals.get(id) ?? []).filter((g) => g.userId === myId));
  const teamGoal = (id: string) =>
    currentGoal((goals.get(id) ?? []).filter((g) => g.userId === null));

  // The day of those who work cases; owners and admins (who may) only where they have some.
  const working = rows.filter((p) => {
    const m = byId.get(p.id)?.mine;
    if (!m || p.status === 'closed' || p.status === 'archived') return false;
    return worksCases(me.data, p.id) || m.open + m.callbacksDue + m.returned > 0;
  });
  const portfolio = rows.some((p) => byId.get(p.id)?.field || byId.get(p.id)?.review);
  // The preview is for those who write or review questionnaires, not for interviewers.
  const canPreview =
    canAnywhere(me.data, 'questionnaires.edit') || canAnywhere(me.data, 'questionnaires.comment');
  const name = me.data?.user.firstName || me.data?.user.name || '';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('home.welcome', { name })}</h1>
      {isAdmin && members.data ? <AdminPending members={members.data} /> : null}
      {working.length ? (
        <MyDay
          projects={working}
          summary={summary.data!}
          goal={myGoal}
          canCall={(id) => {
            const modes = rows.find((p) => p.id === id)?.modesEnabled ?? [];
            return (
              canIn(me.data, 'interviews.conduct', id) && (!modes.length || modes.includes('CATI'))
            );
          }}
        />
      ) : null}
      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('home.projects')}</h2>
        <QueryState query={projects} isEmpty={!rows.length} empty={t('home.noProjects')}>
          {portfolio ? (
            <Portfolio
              projects={rows}
              byId={byId}
              teamGoal={teamGoal}
              seesCases={(id) => canIn(me.data, 'cases.read_all', id)}
            />
          ) : (
            <ProjectList projects={rows} />
          )}
        </QueryState>
      </Card>
      {canPreview ? (
        <p className="text-sm text-slate-600">
          {t('home.intro')}{' '}
          <Link to="/preview" className="font-medium text-indigo-ink-700 hover:underline">
            {t('home.openPreview')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** A figure with its label, linked to where it is worked on. */
function Tile({ label, value, children }: { label: string; value: number; children?: ReactNode }) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-3 ${value ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'}`}
    >
      <span className="text-2xl font-bold tabular-nums">{number(value)}</span>
      <span className="text-sm text-slate-700">{label}</span>
      {children}
    </div>
  );
}

function AdminPending({ members }: { members: Member[] }) {
  const { t } = useTranslation();
  const awaiting = members.filter((m) => m.awaitingRole).length;
  const invited = members.filter((m) => m.status === 'invited').length;
  const noTwoFactor = members.filter((m) => m.status === 'active' && !m.totpEnabled).length;
  const link = (
    <Link to="/admin/users" className="text-sm font-medium text-indigo-ink-700 hover:underline">
      {t('home.admin.open')}
    </Link>
  );
  return (
    <Card>
      <section aria-labelledby="home-admin">
        <h2 id="home-admin" className="mb-3 text-lg font-semibold">
          {t('home.admin.title')}
        </h2>
        {!awaiting && !invited && !noTwoFactor ? (
          <p className="mb-3 text-slate-600">{t('home.admin.none')}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile label={t('home.admin.awaiting')} value={awaiting}>
            {awaiting ? link : null}
          </Tile>
          <Tile label={t('home.admin.invited')} value={invited}>
            {invited ? link : null}
          </Tile>
          <Tile label={t('home.admin.noTwoFactor')} value={noTwoFactor}>
            {noTwoFactor ? link : null}
          </Tile>
        </div>
      </section>
    </Card>
  );
}

function GoalBadge({ goal, own }: { goal: Goal; own: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      {own ? (
        <span>{t('home.day.goal', { done: goal.completes, target: goal.target })}</span>
      ) : (
        <span className="tabular-nums">
          {goal.completes} / {goal.target}
        </span>
      )}
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${GOAL_CLS[goal.state]}`}>
        {t(`home.day.goalState.${goal.state}`, { expected: goal.expectedByToday })}
      </span>
      {own && goal.periodTarget !== goal.target ? (
        <span className="text-slate-600">
          {t('home.day.goalPeriod', { done: goal.periodCompletes, target: goal.periodTarget })}
        </span>
      ) : null}
    </span>
  );
}

function MyDay({
  projects,
  summary,
  goal,
  canCall,
}: {
  projects: ProjectRow[];
  summary: HomeSummary;
  goal: (projectId: string) => Goal | undefined;
  canCall: (projectId: string) => boolean;
}) {
  const { t } = useTranslation();
  const mine = (id: string) => summary.projects.find((p) => p.id === id)?.mine;
  const total = (k: 'returned' | 'callbacksDue' | 'open') =>
    projects.reduce((a, p) => a + (mine(p.id)?.[k] ?? 0), 0);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const due = summary.dueCallbacks.filter((c) => names.has(c.projectId));
  return (
    <Card>
      <section aria-labelledby="home-day">
        <h2 id="home-day" className="mb-3 text-lg font-semibold">
          {t('home.day.title')}
        </h2>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Tile label={t('home.day.returned')} value={total('returned')} />
          <Tile label={t('home.day.callbacksDue')} value={total('callbacksDue')} />
          <Tile label={t('home.day.open')} value={total('open')} />
        </div>
        <h3 className="mb-2 font-semibold">{t('home.day.forToday')}</h3>
        {due.length ? (
          <ul className="mb-4 divide-y divide-slate-100" data-testid="home-due">
            {due.map((c) => (
              <li key={c.caseId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{names.get(c.projectId)}</span>
                  <span className="text-slate-600">
                    {' · '}
                    {t('home.day.callbackDue', {
                      id: c.externalId ?? c.caseId.slice(0, 8),
                      at: dateTime(c.at),
                    })}
                  </span>
                </span>
                {canCall(c.projectId) ? (
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: c.projectId }}
                    search={{ tab: 'calls', call: c.caseId }}
                    className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1 text-sm font-semibold text-on-fill hover:bg-indigo-500"
                  >
                    {t('home.day.call')}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-slate-600">{t('home.day.forTodayEmpty')}</p>
        )}
        <ul className="divide-y divide-slate-100">
          {projects.map((p) => {
            const m = mine(p.id)!;
            const g = goal(p.id);
            return (
              <li key={p.id} className="flex flex-col gap-1 py-2" data-testid="home-day-project">
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-sm text-slate-600">
                    {t('home.day.returned')}: {m.returned} · {t('home.day.callbacksDue')}:{' '}
                    {m.callbacksDue} · {t('home.day.open')}: {m.open}
                  </span>
                  {m.nextCallbackAt ? (
                    <span className="text-sm text-slate-600">
                      {t('home.day.nextCallback', { at: dateTime(m.nextCallbackAt) })}
                    </span>
                  ) : null}
                </span>
                {g ? <GoalBadge goal={g} own /> : null}
                <span className="flex gap-4 text-sm">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: p.id }}
                    search={{ tab: 'cases' }}
                    className="text-indigo-ink-700 hover:underline"
                  >
                    {t('home.day.openCases')}
                  </Link>
                  {canCall(p.id) ? (
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      search={{ tab: 'calls' }}
                      className="text-indigo-ink-700 hover:underline"
                    >
                      {t('home.day.openCalls')}
                    </Link>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </Card>
  );
}

function ProjectName({ p }: { p: ProjectRow }) {
  return (
    <span className="flex items-center gap-3">
      <ProjectLogo project={p} className="h-6 w-auto max-w-[5rem]" />
      <Link
        to="/projects/$projectId"
        params={{ projectId: p.id }}
        className="text-indigo-ink-700 hover:underline"
      >
        {p.name}
      </Link>
    </span>
  );
}

function ProjectList({ projects }: { projects: ProjectRow[] }) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-slate-100">
      {projects.map((p) => (
        <li key={p.id} className="flex items-center justify-between py-2">
          <ProjectName p={p} />
          <span className="font-mono text-sm text-slate-500">
            {p.code} · {t(`app.projectStatus.${p.status}`, { defaultValue: p.status })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The projects with their fieldwork, for those who run or supervise them. */
function Portfolio({
  projects,
  byId,
  teamGoal,
  seesCases,
}: {
  projects: ProjectRow[];
  byId: Map<string, HomeSummary['projects'][number]>;
  teamGoal: (projectId: string) => Goal | undefined;
  seesCases: (projectId: string) => boolean;
}) {
  const { t, i18n } = useTranslation();
  const tab = (p: ProjectRow, to: string, value: number) => (
    <Link
      to="/projects/$projectId"
      params={{ projectId: p.id }}
      search={{ tab: to }}
      className={value ? 'font-semibold text-indigo-ink-700 hover:underline' : 'text-slate-600'}
    >
      {number(value)}
    </Link>
  );
  const th = 'px-3 py-2 text-right font-medium';
  /** A planned fieldwork date (a calendar day), written short in the reader's language. */
  const day = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(i18n.language, { dateStyle: 'medium' });
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm" data-testid="home-portfolio">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('home.portfolio.project')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('home.portfolio.fieldwork')}
            </th>
            <th scope="col" className={th}>
              {t('home.portfolio.progress')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('home.portfolio.pace')}
            </th>
            <th scope="col" className={th}>
              {t('home.portfolio.unassigned')}
            </th>
            <th scope="col" className={th}>
              {t('home.portfolio.callbacksDue')}
            </th>
            <th scope="col" className={th}>
              {t('home.portfolio.toReview')}
            </th>
            <th scope="col" className={th}>
              {t('home.portfolio.activeNow')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('home.portfolio.lastActivity')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {projects.map((p) => {
            const s = byId.get(p.id);
            const f = s?.field;
            const target = p.settings?.fieldwork?.targetCompletes ?? null;
            const goal = teamGoal(p.id);
            const { startsOn, endsOn } = p.settings?.fieldwork ?? {};
            return (
              <tr key={p.id}>
                <td className="px-3 py-2">
                  <ProjectName p={p} />
                  <span className="font-mono text-xs text-slate-500">
                    {p.code} · {t(`app.projectStatus.${p.status}`, { defaultValue: p.status })}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2" data-testid="home-fieldwork">
                  {startsOn || endsOn
                    ? t('home.portfolio.dates', {
                        from: startsOn ? day(startsOn) : '…',
                        to: endsOn ? day(endsOn) : '…',
                      })
                    : t('home.portfolio.noDates')}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {f ? (
                    <>
                      {target
                        ? t('home.portfolio.ofTarget', {
                            done: number(f.completes),
                            target: number(target),
                          })
                        : number(f.completes)}
                      {target ? (
                        <span
                          className="mt-1 block h-1.5 w-24 overflow-hidden rounded bg-slate-200 sm:ml-auto"
                          aria-hidden
                        >
                          <span
                            className="block h-full bg-indigo-600"
                            style={{ width: `${Math.min(100, (100 * f.completes) / target)}%` }}
                          />
                        </span>
                      ) : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2">
                  {goal ? <GoalBadge goal={goal} own={false} /> : t('home.portfolio.noGoal')}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {f
                    ? seesCases(p.id)
                      ? tab(p, 'cases', f.unassigned)
                      : number(f.unassigned)
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {f ? tab(p, 'dashboard', f.callbacksDue) : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {s?.review ? (
                    <>
                      {tab(p, 'review', s.review.toReview)}
                      {s.review.tooFast ? (
                        <span className="block text-xs text-amber-ink-900">
                          {t('home.portfolio.tooFast', { count: s.review.tooFast })}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {f ? tab(p, 'dashboard', f.activeNow) : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2" data-testid="home-last-activity">
                  {f
                    ? f.lastActivityAt
                      ? dateTime(f.lastActivityAt)
                      : t('home.portfolio.never')
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
