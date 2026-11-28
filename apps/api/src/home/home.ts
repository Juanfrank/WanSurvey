import type { Permission } from '@wansurvey/schema';
import { can, type MembershipGrant } from '../common/auth-context.js';

/** What the home page shows of one project, each part only to those allowed to see it. */
export interface HomeProject {
  id: string;
  /** Fieldwork at a glance (the dashboard's figures): `dashboards.read`. */
  field: {
    completes: number;
    cases: number;
    unassigned: number;
    callbacksDue: number;
    activeNow: number;
    /** When an interview of the project last changed (started, saved, submitted, reviewed). */
    lastActivityAt: string | null;
  } | null;
  /** The review queue: `interviews.review` or `interviews.approve`. */
  review: { toReview: number; tooFast: number } | null;
  /** The caller's own work: `interviews.conduct` or `dataentry.key`. */
  mine: {
    open: number;
    callbacksDue: number;
    nextCallbackAt: string | null;
    returned: number;
  } | null;
}

export interface HomeData {
  projectIds: string[];
  completes: { projectId: string; n: number }[];
  field: { projectId: string; cases: number; unassigned: number; callbacksDue: number }[];
  active: { projectId: string; n: number }[];
  lastActivity: { projectId: string; at: Date }[];
  review: { projectId: string; toReview: number; tooFast: number }[];
  mine: {
    projectId: string;
    open: number;
    callbacksDue: number;
    nextCallbackAt: Date | null;
    returned: number;
  }[];
}

const FIELD: Permission[] = ['dashboards.read'];
const REVIEW: Permission[] = ['interviews.review', 'interviews.approve'];
const MINE: Permission[] = ['interviews.conduct', 'dataentry.key'];

const any = (m: MembershipGrant[], ps: Permission[], projectId: string | 'any') =>
  ps.some((p) => can(m, p, projectId));

/** Which parts of the home page a person may see in some project (the queries to run). */
export function homeParts(m: MembershipGrant[]) {
  return {
    field: any(m, FIELD, 'any'),
    review: any(m, REVIEW, 'any'),
    mine: any(m, MINE, 'any'),
  };
}

/** Whether a person sees a project at all (the rule of the project list). */
export function seesProject(m: MembershipGrant[], projectId: string) {
  return can(m, 'projects.read', projectId);
}

/** The per-project summary, keeping to what each membership allows. */
export function homeProjects(m: MembershipGrant[], d: HomeData): HomeProject[] {
  const ids = new Set(d.projectIds);
  const by = <T extends { projectId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.projectId, r]));
  const completes = by(d.completes);
  const field = by(d.field);
  const active = by(d.active);
  const last = by(d.lastActivity);
  const review = by(d.review);
  const mine = by(d.mine);
  return [...ids]
    .filter((id) => seesProject(m, id))
    .sort()
    .map((id) => {
      const f = field.get(id);
      const r = review.get(id);
      const o = mine.get(id);
      return {
        id,
        field: any(m, FIELD, id)
          ? {
              completes: completes.get(id)?.n ?? 0,
              cases: f?.cases ?? 0,
              unassigned: f?.unassigned ?? 0,
              callbacksDue: f?.callbacksDue ?? 0,
              activeNow: active.get(id)?.n ?? 0,
              lastActivityAt: last.get(id) ? new Date(last.get(id)!.at).toISOString() : null,
            }
          : null,
        review: any(m, REVIEW, id)
          ? { toReview: r?.toReview ?? 0, tooFast: r?.tooFast ?? 0 }
          : null,
        mine: any(m, MINE, id)
          ? {
              open: o?.open ?? 0,
              callbacksDue: o?.callbacksDue ?? 0,
              nextCallbackAt: o?.nextCallbackAt ? new Date(o.nextCallbackAt).toISOString() : null,
              returned: o?.returned ?? 0,
            }
          : null,
      };
    });
}
