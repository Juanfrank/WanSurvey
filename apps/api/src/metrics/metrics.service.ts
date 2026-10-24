import { Injectable } from '@nestjs/common';
import { DISPOSITIONS, type Disposition } from '@wansurvey/schema';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { can, type AuthContext } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import { users } from '../db/schema.js';
import {
  addDisposition,
  emptyCounts,
  interviewerMetrics,
  rankTeam,
  type InterviewerInput,
} from './metrics.js';
import { COUNTED_SQL } from '../common/statuses.js';

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
  async interviewers(tx: Tx, ctx: AuthContext, projectId: string, q: MetricsQuery) {
    const team = can(ctx.memberships, 'metrics.team', projectId);
    const [p] = await tx.execute<{ tz: string }>(
      sql`select timezone as tz from projects where id = ${projectId}`,
    );
    const tz = p?.tz ?? 'UTC';
    const day = (col: string) => sql`(${sql.raw(col)} at time zone ${tz})::date`;
    const range = (col: string) =>
      sql`${q.from ? sql`and ${day(col)} >= ${q.from}::date` : sql``} ${q.to ? sql`and ${day(col)} <= ${q.to}::date` : sql``}`;
    const mode = (col: string) => (q.mode ? sql`and ${sql.raw(col)} = ${q.mode}` : sql``);
    const who = (col: string) => (team ? sql`` : sql`and ${sql.raw(col)} = ${ctx.userId}`);

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

    const daily = await tx.execute<{
      id: string;
      day: string;
      submitted: number;
      completes: number;
      approved: number;
      rejected: number;
    }>(sql`
      select interviewer_id as id, to_char(day, 'YYYY-MM-DD') as day, sum(submitted)::int as submitted,
             sum(completes)::int as completes, sum(approved)::int as approved, sum(rejected)::int as rejected
      from stats_daily
      where project_id = ${projectId} and interviewer_id is not null
        ${q.from ? sql`and day >= ${q.from}::date` : sql``} ${q.to ? sql`and day <= ${q.to}::date` : sql``}
        ${mode('mode')} ${who('interviewer_id')}
      group by 1, 2`);
    for (const r of daily) {
      const x = get(r.id);
      if (r.completes) x.completesByDay[r.day] = r.completes;
      x.submitted += r.submitted;
      x.approved += r.approved;
      x.rejected += r.rejected;
    }

    const completes = await tx.execute<{
      id: string;
      active_ms: number;
      items: number;
      specials: number;
      speeding: boolean;
      straight: boolean;
      back: number;
    }>(sql`
      select i.interviewer_id as id, i.active_ms,
             (select count(*)::int from jsonb_each(i.answers)) as items,
             (select count(*)::int from jsonb_each(i.answers) e
               where jsonb_typeof(e.value) = 'object' and e.value ? '$special') as specials,
             i.flags ? 'speeding' as speeding, i.flags ? 'straightlining' as straight,
             (select count(*)::int from interview_paradata pd
               where pd.interview_id = i.id and pd.type = 'navigate_back') as back
      from interviews i
      where i.project_id = ${projectId} and i.interviewer_id is not null and i.entry_pass = 1
        and i.status in ${COUNTED_SQL} and i.disposition = 'COMPLETE'
        ${range('i.submitted_at')} ${mode('i.mode')} ${who('i.interviewer_id')}`);
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
      const dials = await tx.execute<{ id: string; n: number }>(sql`
        select interviewer_id as id, count(*)::int as n from call_attempts
        where project_id = ${projectId} ${range('started_at')} ${who('interviewer_id')}
        group by 1`);
      for (const r of dials) get(r.id).dials = r.n;
    }

    // Cases each interviewer worked in the period (a call or an interview), at their current
    // disposition.
    const worked = await tx.execute<{ id: string; disposition: string | null }>(sql`
      select w.id, c.disposition from (
        select interviewer_id as id, case_id from call_attempts
          where project_id = ${projectId} ${range('started_at')} ${who('interviewer_id')}
            ${q.mode && q.mode !== 'CATI' ? sql`and false` : sql``}
        union
        select interviewer_id, case_id from interviews
          where project_id = ${projectId} and interviewer_id is not null and case_id is not null
            and entry_pass = 1 ${range('started_at')} ${mode('mode')} ${who('interviewer_id')}
      ) w join cases c on c.id = w.case_id`);
    for (const r of worked) addDisposition(get(r.id).cases, aaporOf(r.disposition));

    if (!q.mode || q.mode === 'CAPI') {
      const latency = await tx.execute<{ id: string; s: number | null }>(sql`
        select i.interviewer_id as id,
               percentile_cont(0.5) within group (order by extract(epoch from e.received_at - e.at)) as s
        from interview_answer_events e join interviews i on i.id = e.interview_id
        where i.project_id = ${projectId} and i.mode = 'CAPI' and i.interviewer_id is not null
          and e.received_at is not null ${range('e.at')} ${who('i.interviewer_id')}
        group by 1`);
      for (const r of latency)
        if (r.s !== null) get(r.id).syncLatencyS = [Math.max(0, Number(r.s))];
    }

    if (inputs.size) {
      const names = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, [...inputs.keys()]));
      for (const r of names) get(r.id, r.name);
    }
    const rows = [...inputs.values()].map(interviewerMetrics);
    return { team, interviewers: team ? rankTeam(rows) : rows };
  }
}
