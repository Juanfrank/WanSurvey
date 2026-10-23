import { Inject, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import {
  evaluate,
  truthy,
  type CompiledQuestionnaire,
  type Scope,
  type Value,
} from '@wansurvey/logic';
import { projectSettings } from '@wansurvey/schema';
import { sql } from 'drizzle-orm';
import { Observable } from 'rxjs';
import { Database, type Tx } from '../db/database.js';
import { BUS, projectChannel, type Bus } from '../jobs/bus.js';

/** Minutes without activity after which an interviewer no longer shows as working. */
const ACTIVE_MINUTES = 5;
const HEARTBEAT_MS = 15_000;
/** Figures that are not announced (case outcomes, invitations) are re-read this often. */
const REFRESH_MS = 60_000;
/** Bursts of changes produce one snapshot. */
/** How long a computed snapshot is served to other viewers of the same project. */
const SHARE_MS = 1_000;
/** Bursts of changes (a wave of submissions) produce one snapshot per this window. */
const DEBOUNCE_MS = 1_000;

/** Variables from saved answers, enough to tell which quota cell an interview is in. */
function answersScope(answers: Record<string, unknown>, mode: string): Scope {
  return {
    get: (name) => (Object.hasOwn(answers, name) ? (answers[name] as Value) : null),
    namespace: () => undefined,
    rowIndex: () => null,
    rowScope: () => null,
    label: () => null,
    mode,
    today: new Date().toISOString().slice(0, 10),
  };
}

export interface LiveSnapshot {
  at: string;
  target: number | null;
  completes: number;
  byMode: Record<string, number>;
  byDay: { day: string; completes: number }[];
  quotas: { id: string; name: string; max: number; count: number }[];
  field: {
    cases: number;
    byStatus: Record<string, number>;
    byDisposition: Record<string, number>;
    callbacksDue: number;
  };
  funnel: {
    total: number;
    sent: number;
    opened: number;
    started: number;
    completed: number;
    bounced: number;
  } | null;
  active: {
    userId: string;
    name: string;
    mode: string;
    caseId: string | null;
    externalId: string | null;
    lastAt: string;
  }[];
}

/**
 * The live dashboard (M2): a snapshot of fieldwork, sent over Server-Sent Events when the
 * stats job announces a change, re-read every minute, with a heartbeat that keeps proxies
 * from closing the connection.
 */
@Injectable()
export class LiveService {
  private readonly logger = new Logger('Live');

  constructor(
    private readonly database: Database,
    @Inject(BUS) private readonly bus: Bus,
  ) {}

  async snapshot(tx: Tx, projectId: string): Promise<LiveSnapshot> {
    const [p] = await tx.execute<{ settings: unknown; tz: string }>(
      sql`select settings, timezone as tz from projects where id = ${projectId}`,
    );
    const target = projectSettings(p?.settings).fieldwork.targetCompletes;

    const modes = await tx.execute<{ mode: string; n: number }>(sql`
      select mode, sum(completes)::int as n from stats_daily where project_id = ${projectId} group by 1`);
    const byMode = Object.fromEntries(modes.map((r) => [r.mode, r.n]));
    const completes = modes.reduce((a, r) => a + r.n, 0);

    const days = await tx.execute<{ day: string; n: number }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, sum(completes)::int as n from stats_daily
      where project_id = ${projectId} and day > (now() at time zone ${p?.tz ?? 'UTC'})::date - 30
      group by 1 order by 1`);

    // Quota cells of the latest version of each questionnaire, counted over the data.
    const versions = await tx.execute<{ compiled: CompiledQuestionnaire }>(sql`
      select distinct on (v.questionnaire_id) v.compiled from questionnaire_versions v
      join questionnaires q on q.id = v.questionnaire_id
      where q.project_id = ${projectId} order by v.questionnaire_id, v.version desc`);
    const quotaDefs = versions.flatMap((v) => v.compiled.quotas ?? []);
    const quotas = quotaDefs.map((q) => ({ id: q.id, name: q.name, max: q.max, count: 0 }));
    if (quotaDefs.length) {
      const refs = [...new Set(quotaDefs.flatMap((q) => q.expr.refs))];
      const rows = await tx.execute<{ a: Record<string, unknown> | null; mode: string }>(sql`
        select (select jsonb_object_agg(key, value) from jsonb_each(i.answers)
                where key in ${refs.length ? refs : ['']}) as a,
               i.mode
        from interviews i
        where i.project_id = ${projectId} and i.entry_pass = 1 and i.disposition = 'COMPLETE'
          and i.status in ('submitted', 'in_review', 'approved')`);
      for (const r of rows) {
        const scope = answersScope(r.a ?? {}, r.mode);
        quotaDefs.forEach((q, i) => {
          if (q.expr.ast && truthy(evaluate(q.expr.ast, scope))) quotas[i]!.count++;
        });
      }
    }

    const status = await tx.execute<{ status: string; disposition: string | null; n: number }>(sql`
      select status, disposition, count(*)::int as n from cases where project_id = ${projectId} group by 1, 2`);
    const byStatus: Record<string, number> = {};
    const byDisposition: Record<string, number> = {};
    for (const r of status) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
      if (r.disposition) byDisposition[r.disposition] = (byDisposition[r.disposition] ?? 0) + r.n;
    }
    const [due] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from cases where project_id = ${projectId}
        and status not in ('finalised', 'withdrawn') and next_contact_at is not null and next_contact_at <= now()`);

    const [f] = await tx.execute<{
      total: number;
      sent: number;
      opened: number;
      started: number;
      completed: number;
      bounced: number;
    }>(sql`
      select count(*)::int as total, count(sent_at)::int as sent, count(opened_at)::int as opened,
             count(started_at)::int as started, count(completed_at)::int as completed,
             count(*) filter (where bounce_type = 'hard')::int as bounced
      from invitations where project_id = ${projectId}`);

    const active = await tx.execute<{
      userId: string;
      name: string;
      mode: string;
      caseId: string | null;
      externalId: string | null;
      lastAt: Date;
    }>(sql`
      select distinct on (i.interviewer_id) i.interviewer_id as "userId", u.name, i.mode,
             i.case_id as "caseId", c.external_id as "externalId", i.updated_at as "lastAt"
      from interviews i join users u on u.id = i.interviewer_id
      left join cases c on c.id = i.case_id
      where i.project_id = ${projectId} and i.interviewer_id is not null
        and i.updated_at > now() - make_interval(mins => ${ACTIVE_MINUTES})
      order by i.interviewer_id, i.updated_at desc`);

    return {
      at: new Date().toISOString(),
      target,
      completes,
      byMode,
      byDay: days.map((d) => ({ day: d.day, completes: d.n })),
      quotas,
      field: {
        cases: status.reduce((a, r) => a + r.n, 0),
        byStatus,
        byDisposition,
        callbacksDue: due?.n ?? 0,
      },
      funnel: f && f.total ? f : null,
      active: active.map((a) => ({ ...a, lastAt: new Date(a.lastAt).toISOString() })),
    };
  }

  /** Snapshots being computed, and the last ones, per organisation and project. */
  private readonly inFlight = new Map<string, Promise<LiveSnapshot>>();
  private readonly recent = new Map<string, { at: number; snap: LiveSnapshot }>();

  /**
   * One snapshot shared by every open dashboard of a project in this process: a change wakes
   * all of them at once, and N viewers would otherwise run N identical queries. Requests that
   * arrive while one is being computed wait for it; a result serves for a second.
   */
  private shared(tenantId: string, projectId: string) {
    const key = `${tenantId}:${projectId}`;
    const r = this.recent.get(key);
    if (r && Date.now() - r.at < SHARE_MS) return Promise.resolve(r.snap);
    let p = this.inFlight.get(key);
    if (!p) {
      p = this.database
        .withTenant(tenantId, (tx) => this.snapshot(tx, projectId))
        .then((snap) => {
          this.recent.set(key, { at: Date.now(), snap });
          return snap;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, p);
    }
    return p;
  }

  /** The SSE stream: a snapshot now, after each announced change, and every minute. */
  stream(tenantId: string, projectId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      const send = async () => {
        timer = null;
        try {
          const snap = await this.shared(tenantId, projectId);
          if (!closed) sub.next({ type: 'snapshot', data: snap });
        } catch (e) {
          // The details go to the log; the dashboard only learns that this update failed.
          this.logger.warn(`Live snapshot failed for ${projectId}: ${(e as Error).message}`);
          if (!closed) sub.next({ type: 'error', data: { code: 'SNAPSHOT_FAILED' } });
        }
      };
      const soon = () => {
        if (!timer) timer = setTimeout(() => void send(), DEBOUNCE_MS);
      };
      void send();
      const off = this.bus.subscribe(projectChannel(projectId), soon);
      const refresh = setInterval(soon, REFRESH_MS);
      const beat = setInterval(
        () => sub.next({ type: 'heartbeat', data: { at: new Date().toISOString() } }),
        HEARTBEAT_MS,
      );
      return () => {
        closed = true;
        off();
        clearInterval(refresh);
        clearInterval(beat);
        if (timer) clearTimeout(timer);
      };
    });
  }
}
