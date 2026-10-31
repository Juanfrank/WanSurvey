import { Injectable } from '@nestjs/common';
import { DISPOSITIONS, type Disposition } from '@wansurvey/schema';
import { z } from 'zod';
import { can, type AuthContext } from '../common/auth-context.js';
import { type MetricsTx } from './metrics-repo.js';
import {
  addDisposition,
  emptyCounts,
  interviewerMetrics,
  rankTeam,
  type InterviewerInput,
} from './metrics.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const MetricsQuery = z.object({
  from: Day.optional(),
  to: Day.optional(),
  mode: z.enum(['CATI', 'CAPI', 'CAWI', 'PAPI']).optional(),
});
export type MetricsQuery = z.infer<typeof MetricsQuery>;

const aaporOf = (d: string | null) =>
  d && d in DISPOSITIONS ? DISPOSITIONS[d as Disposition].aapor : null;

/**
 * Interviewer metrics for a period (M4): gathered with a few grouped queries, then computed
 * by the pure formulas in `metrics.ts`. People with `metrics.team` see everyone, ranked, with
 * outliers marked (M5); interviewers with `metrics.own` see only themselves.
 */
@Injectable()
export class MetricsService {
  async interviewers(tx: MetricsTx, ctx: AuthContext, projectId: string, q: MetricsQuery) {
    const team = can(ctx.memberships, 'metrics.team', projectId);
    const t = tx;
    const tz = (await t.project(projectId))?.timezone ?? 'UTC';
    const f = {
      projectId,
      from: q.from,
      to: q.to,
      mode: q.mode,
      userId: team ? undefined : ctx.userId,
      timezone: tz,
    };

    const inputs = new Map<string, InterviewerInput>();
    const get = (id: string, name = '') => {
      let x = inputs.get(id);
      if (!x) {
        x = {
          interviewerId: id,
          name,
          completesByDay: {},
          submitted: 0,
          approved: 0,
          rejected: 0,
          completeLengthsMs: [],
          items: 0,
          itemsNonResponse: 0,
          speeding: 0,
          straightlining: 0,
          backMoves: 0,
          dials: 0,
          cases: emptyCounts(),
          syncLatencyS: [],
        };
        inputs.set(id, x);
      }
      if (name && !x.name) x.name = name;
      return x;
    };

    const daily = await t.statsDaily(f);
    for (const r of daily) {
      const x = get(r.id);
      if (r.completes) x.completesByDay[r.day] = r.completes;
      x.submitted += r.submitted;
      x.approved += r.approved;
      x.rejected += r.rejected;
    }

    const completes = await t.completeInterviews(f);
    for (const r of completes) {
      const x = get(r.id);
      x.completeLengthsMs.push(r.active_ms);
      x.items += r.items;
      x.itemsNonResponse += r.specials;
      if (r.speeding) x.speeding++;
      if (r.straight) x.straightlining++;
      x.backMoves += r.back;
    }

    if (!q.mode || q.mode === 'CATI') {
      const dials = await t.dialCounts(f);
      for (const r of dials) get(r.id).dials = r.n;
    }

    // Cases each interviewer worked in the period (a call or an interview), at their current
    // disposition.
    const worked = await t.workedCases(f);
    for (const r of worked) addDisposition(get(r.id).cases, aaporOf(r.disposition));

    if (!q.mode || q.mode === 'CAPI') {
      const latency = await t.syncLatency(f);
      for (const r of latency)
        if (r.s !== null) get(r.id).syncLatencyS = [Math.max(0, Number(r.s))];
    }

    if (inputs.size) {
      const names = await t.userNames([...inputs.keys()]);
      for (const r of names) get(r.id, r.name);
    }
    const rows = [...inputs.values()].map(interviewerMetrics);
    return { team, interviewers: team ? rankTeam(rows) : rows };
  }
}
