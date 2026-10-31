import { Inject, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import { evaluate, truthy, type Scope, type Value } from '@wansurvey/logic';
import { projectSettings } from '@wansurvey/schema';
import { Observable } from 'rxjs';
import { AuditService } from '../audit/audit.service.js';
import type { Tx } from '../db/database.js';
import { LIVE_REPO, PgLiveTx, type LiveRepo, type LiveTx } from './live-repo.js';
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

/**
 * Variables from saved answers and the sample fields the interview ran with, enough to tell
 * which quota cell an interview is in.
 */
function answersScope(
  answers: Record<string, unknown>,
  sample: Record<string, unknown>,
  mode: string,
): Scope {
  return {
    // Unknown names stay undefined, so `case.x` and `mode` resolve as in the interview.
    get: (name) => (Object.hasOwn(answers, name) ? (answers[name] as Value) : undefined),
    namespace: (ns) => (ns === 'case' ? sample : undefined),
    rowIndex: () => null,
    rowScope: () => null,
    label: () => null,
    mode,
    today: new Date().toISOString().slice(0, 10),
  };
}

/** Sample fields an expression reads (`case.region`). */
function caseFields(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: string; object?: { type?: string; name?: string }; property?: string };
  if (n.type === 'member' && n.object?.type === 'var' && n.object.name === 'case' && n.property)
    out.push(n.property);
  for (const v of Object.values(node)) if (v && typeof v === 'object') caseFields(v, out);
  return out;
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
    @Inject(LIVE_REPO) private readonly repo: LiveRepo,
    @Inject(BUS) private readonly bus: Bus,
    private readonly audit: AuditService,
  ) {}

  /** One snapshot in its own transaction (the endpoint behind the dashboard's first paint). */
  snapshotOf(tenantId: string, projectId: string) {
    return this.repo.inTenant(tenantId, (t) => this.snapshot(t, projectId));
  }

  async snapshot(tx: Tx | LiveTx, projectId: string, tenantId = ''): Promise<LiveSnapshot> {
    const t: LiveTx = 'activeInterviewers' in tx ? tx : new PgLiveTx(tx, tenantId, this.audit);
    const p = await t.project(projectId);
    const target = projectSettings(p?.settings).fieldwork.targetCompletes;

    const modes = await t.modeTotals(projectId);
    const byMode = Object.fromEntries(modes.map((r) => [r.mode, r.n]));
    const completes = modes.reduce((a, r) => a + r.n, 0);

    const days = await t.recentDays(projectId, p?.timezone ?? 'UTC');

    // Quota cells of the latest version of each questionnaire, each counted over the
    // interviews of its own questionnaire.
    const versions = await t.latestVersions(projectId);
    const quotaDefs = versions.flatMap((v) =>
      (v.compiled.quotas ?? []).map((quota) => ({ ...quota, qid: v.qid })),
    );
    const quotas = quotaDefs.map((q) => ({ id: q.id, name: q.name, max: q.max, count: 0 }));
    if (quotaDefs.length) {
      const refs = [...new Set(quotaDefs.flatMap((q) => q.expr.refs))];
      const fields = [...new Set(quotaDefs.flatMap((q) => caseFields(q.expr.ast)))];
      const rows = await t.quotaRows(projectId, refs, fields);
      for (const r of rows) {
        const scope = answersScope(r.a ?? {}, r.c ?? {}, r.mode);
        quotaDefs.forEach((q, i) => {
          if (q.qid === r.qid && q.expr.ast && truthy(evaluate(q.expr.ast, scope)))
            quotas[i]!.count++;
        });
      }
    }

    const status = await t.caseStatuses(projectId);
    const byStatus: Record<string, number> = {};
    const byDisposition: Record<string, number> = {};
    for (const r of status) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
      if (r.disposition) byDisposition[r.disposition] = (byDisposition[r.disposition] ?? 0) + r.n;
    }
    const due = await t.callbacksDue(projectId);
    const f = await t.funnel(projectId);
    const active = await t.activeInterviewers(projectId, ACTIVE_MINUTES);

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
        callbacksDue: due,
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
      p = this.repo
        .inTenant(tenantId, (t) => this.snapshot(t, projectId))
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
