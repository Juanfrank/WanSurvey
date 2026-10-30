import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';

/**
 * Interviews on SQL Server (Kysely): start or resume on a case, numbered changes from a device,
 * the snapshot, submission and the history, as `interviews.service.ts` does them on PostgreSQL
 * with Drizzle (docs/roadmap.md). Takes the transaction of `MssqlDatabase.withTenant`.
 *
 * Idempotent replays rely on IGNORE_DUP_KEY unique indexes (mssql/0005): a change number sent
 * twice is dropped by the database, whatever the interleaving of two requests.
 */
export type InterviewRow = Omit<
  Selectable<MssqlSchema['interviews']>,
  'context' | 'state' | 'answers' | 'flags'
> & {
  context: Record<string, unknown>;
  state: Record<string, unknown>;
  answers: Record<string, unknown>;
  flags: Record<string, unknown>;
};

const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));
const toRow = (r: Selectable<MssqlSchema['interviews']>): InterviewRow => ({
  ...r,
  context: parse(r.context),
  state: parse(r.state),
  answers: parse(r.answers),
  flags: parse(r.flags),
});
const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** A stable text of a JSON value, to compare two values whatever their key order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );

export interface NewInterview {
  id: string;
  tenantId: string;
  projectId: string;
  caseId: string | null;
  questionnaireVersionId: string;
  mode: string;
  interviewerId: string | null;
  language: string;
  context: Record<string, unknown>;
  deviceId: string;
  entryPass?: number;
}

export interface AnswerOp {
  seq: number;
  variable: string;
  oldValue?: unknown;
  newValue?: unknown;
  at: string;
  byUserId?: string | null;
  source: string;
  reason?: string | null;
}

export interface ParadataOp {
  seq: number;
  type: string;
  at: string;
  monotonicMs?: number | null;
  payload?: unknown;
}

export class InterviewsStore {
  /**
   * Starts an interview with the id the device chose. A second open interview on the same case
   * fails with SQL Server error 2601 (the unique index of mssql/0005); an id in use, with 2627.
   */
  async start(tx: MssqlTx, v: NewInterview): Promise<InterviewRow> {
    await tx
      .insertInto('interviews')
      .values({
        id: v.id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        case_id: v.caseId,
        questionnaire_version_id: v.questionnaireVersionId,
        mode: v.mode,
        interviewer_id: v.interviewerId,
        language: v.language,
        context: JSON.stringify(v.context),
        device_id: v.deviceId,
        entry_pass: v.entryPass ?? 1,
        state: '{}',
        answers: '{}',
        flags: '{}',
        ended_at: null,
        submitted_at: null,
        reviewed_by: null,
        reviewed_at: null,
        disposition: null,
        position: null,
        state_device: null,
      })
      .execute();
    return (await this.get(tx, v.id))!;
  }

  async get(tx: MssqlTx, id: string): Promise<InterviewRow | undefined> {
    const r = await tx.selectFrom('interviews').selectAll().where('id', '=', id).executeTakeFirst();
    return r && toRow(r);
  }

  /** Row lock for the rest of the transaction: syncs, submits and reviews of one interview queue up. */
  async lock(tx: MssqlTx, id: string): Promise<InterviewRow | undefined> {
    const res = await sql<Selectable<MssqlSchema['interviews']>>`
      SELECT * FROM dbo.interviews WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`.execute(tx);
    const r = res.rows[0];
    return r && toRow(r);
  }

  async openForCase(tx: MssqlTx, caseId: string): Promise<InterviewRow | undefined> {
    const r = await tx
      .selectFrom('interviews')
      .selectAll()
      .where('case_id', '=', caseId)
      .where('status', '=', 'in_progress')
      .executeTakeFirst();
    return r && toRow(r);
  }

  /** Resuming: the person holding the case now works it, on this device. */
  async resume(
    tx: MssqlTx,
    id: string,
    interviewerId: string | null,
    deviceId: string,
  ): Promise<InterviewRow> {
    await tx
      .updateTable('interviews')
      .set({
        interviewer_id: interviewerId,
        device_id: deviceId,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
    return (await this.get(tx, id))!;
  }

  /** Notes the device and returns the last change number it has acknowledged (0 for a new one). */
  async touchDevice(
    tx: MssqlTx,
    v: { tenantId: string; interviewId: string; deviceId: string },
  ): Promise<number> {
    const res = await sql<{ last_seq: number }>`
      BEGIN TRY
        INSERT INTO dbo.interview_devices (tenant_id, interview_id, device_id)
        VALUES (${v.tenantId}, ${v.interviewId}, ${v.deviceId});
      END TRY
      BEGIN CATCH
        IF ERROR_NUMBER() IN (2601, 2627)
          UPDATE dbo.interview_devices SET updated_at = SYSDATETIMEOFFSET()
          WHERE interview_id = ${v.interviewId} AND device_id = ${v.deviceId};
        ELSE
          THROW;
      END CATCH;
      SELECT last_seq FROM dbo.interview_devices
      WHERE interview_id = ${v.interviewId} AND device_id = ${v.deviceId}`.execute(tx);
    return res.rows[0]?.last_seq ?? 0;
  }

  async deviceSeq(tx: MssqlTx, interviewId: string, deviceId: string): Promise<number | undefined> {
    const r = await tx
      .selectFrom('interview_devices')
      .select('last_seq')
      .where('interview_id', '=', interviewId)
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    return r?.last_seq;
  }

  /** Appends answer changes; a number already stored is dropped by the database. */
  async appendAnswers(
    tx: MssqlTx,
    v: { tenantId: string; interviewId: string; deviceId: string; ops: AnswerOp[] },
  ): Promise<void> {
    for (const part of chunks(v.ops, 2000)) {
      if (!part.length) continue;
      const rows = part.map((o) => ({
        id: randomUUID(),
        seq: o.seq,
        variable: o.variable,
        oldValue:
          o.oldValue === undefined || o.oldValue === null ? null : JSON.stringify(o.oldValue),
        newValue:
          o.newValue === undefined || o.newValue === null ? null : JSON.stringify(o.newValue),
        at: o.at,
        byUserId: o.byUserId ?? null,
        source: o.source,
        reason: o.reason ?? null,
      }));
      await sql`
        INSERT INTO dbo.interview_answer_events (id, tenant_id, interview_id, device_id, seq,
          variable, old_value, new_value, at, by_user_id, source, reason)
        SELECT j.id, ${v.tenantId}, ${v.interviewId}, ${v.deviceId}, j.seq, j.variable, j.oldValue,
          j.newValue, j.at, j.byUserId, j.source, j.reason
        FROM OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, seq int, variable nvarchar(450), oldValue nvarchar(max),
          newValue nvarchar(max), at datetimeoffset(3), byUserId uniqueidentifier,
          source nvarchar(32), reason nvarchar(450)
        ) j`.execute(tx);
    }
  }

  async appendParadata(
    tx: MssqlTx,
    v: { tenantId: string; interviewId: string; deviceId: string; ops: ParadataOp[] },
  ): Promise<void> {
    for (const part of chunks(v.ops, 2000)) {
      if (!part.length) continue;
      const rows = part.map((o) => ({
        id: randomUUID(),
        seq: o.seq,
        type: o.type,
        at: o.at,
        monotonicMs: o.monotonicMs ?? null,
        payload: JSON.stringify(o.payload ?? {}),
      }));
      await sql`
        INSERT INTO dbo.interview_paradata (id, tenant_id, interview_id, device_id, seq, type, at,
          monotonic_ms, payload)
        SELECT j.id, ${v.tenantId}, ${v.interviewId}, ${v.deviceId}, j.seq, j.type, j.at,
          j.monotonicMs, j.payload
        FROM OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, seq int, type nvarchar(64), at datetimeoffset(3),
          monotonicMs float, payload nvarchar(max)
        ) j`.execute(tx);
    }
  }

  /**
   * The end of a sync: the interview's snapshot and times (when `touch`; only the fields sent) and
   * the device's acknowledged number. A new snapshot bumps the state's version and keeps the codes
   * given to "other" texts (`<VAR>_CODE`, not in the snapshot) whose text is unchanged. Call it
   * with the interview locked (`lock`).
   */
  async finishSync(
    tx: MssqlTx,
    v: {
      id: string;
      device: string;
      seq: number;
      touch: boolean;
      hasState: boolean;
      state?: Record<string, unknown> | null;
      position?: string | null;
      activeMs?: number | null;
      totalMs?: number | null;
    },
  ): Promise<void> {
    if (v.touch) {
      const set: Record<string, unknown> = { updated_at: sql<Date>`SYSDATETIMEOFFSET()` };
      if (v.hasState && v.state) {
        const current = await this.get(tx, v.id);
        const next = (v.state.answers ?? {}) as Record<string, unknown>;
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(current?.answers ?? {})) {
          if (!key.endsWith('_CODE')) continue;
          const other = `${key.slice(0, -5)}_OTHER`;
          if (
            other in next &&
            other in (current?.answers ?? {}) &&
            canon(next[other]) === canon(current!.answers[other])
          )
            kept[key] = value;
        }
        set.state = JSON.stringify(v.state);
        set.answers = JSON.stringify({ ...kept, ...next });
        set.state_version = sql<number>`state_version + 1`;
        set.state_device = v.device;
        set.position = v.position ?? null;
      }
      if (v.activeMs !== undefined && v.activeMs !== null) set.active_ms = v.activeMs;
      if (v.totalMs !== undefined && v.totalMs !== null) set.total_ms = v.totalMs;
      await tx.updateTable('interviews').set(set).where('id', '=', v.id).execute();
    }
    await tx
      .updateTable('interview_devices')
      .set({ last_seq: v.seq, updated_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('interview_id', '=', v.id)
      .where('device_id', '=', v.device)
      .execute();
  }

  /** Marks the interview submitted (the caller has already checked that it can be). */
  async markSubmitted(
    tx: MssqlTx,
    id: string,
    v: { disposition: string; flags?: Record<string, unknown>; sampled?: boolean },
  ): Promise<void> {
    await tx
      .updateTable('interviews')
      .set({
        status: 'submitted',
        disposition: v.disposition,
        ended_at: sql<Date>`COALESCE(ended_at, SYSDATETIMEOFFSET())`,
        submitted_at: sql<Date>`SYSDATETIMEOFFSET()`,
        submissions: sql<number>`submissions + 1`,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
        ...(v.flags ? { flags: JSON.stringify(v.flags) } : {}),
        ...(v.sampled !== undefined ? { sampled: v.sampled } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  // History

  async answerHistory(tx: MssqlTx, interviewId: string) {
    const rows = await tx
      .selectFrom('interview_answer_events')
      .select([
        'device_id',
        'seq',
        'variable',
        'old_value',
        'new_value',
        'at',
        'source',
        'reason',
        'received_at',
      ])
      .where('interview_id', '=', interviewId)
      .orderBy('at')
      .orderBy('device_id')
      .orderBy('seq')
      .execute();
    return rows.map((r) => ({
      ...r,
      old_value: parse<unknown>(r.old_value),
      new_value: parse<unknown>(r.new_value),
    }));
  }

  async paradata(tx: MssqlTx, interviewId: string) {
    const rows = await tx
      .selectFrom('interview_paradata')
      .select(['device_id', 'seq', 'type', 'at', 'monotonic_ms', 'payload'])
      .where('interview_id', '=', interviewId)
      .orderBy('at')
      .orderBy('device_id')
      .orderBy('seq')
      .execute();
    return rows.map((r) => ({ ...r, payload: parse<unknown>(r.payload) }));
  }
}
