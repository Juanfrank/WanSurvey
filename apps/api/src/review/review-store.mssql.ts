import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import { idOrder } from '../db/mssql/order.js';
import { FLAG_KINDS } from './flags.js';

/**
 * Review on SQL Server (Kysely): the review queue, comments, the interview's review status and
 * the corrections a reviewer makes, and the coding of "other, specify" texts, for
 * `review.service.ts`. The rules (who may
 * move an interview where, how a correction re-runs the logic) stay in the service; this is the
 * data access. Takes the transaction of `MssqlDatabase.withTenant`.
 */
export const REVIEW_DEVICE = 'review';
/** Interviews that count as data: submitted and not (yet) rejected or sent back. */
export const COUNTED = ['submitted', 'in_review', 'approved'];

const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

export interface QueueFilter {
  projectId: string;
  status: string[];
  interviewerId?: string;
  mode?: string;
  /** Only interviews with this result (COMPLETE, SCREENED_OUT, REFUSAL…). */
  disposition?: string;
  /** Only interviews that carry this quality flag. */
  flag?: string;
  sampled?: boolean;
  /** Highest fraud-risk score first (ADR 0001) instead of newest first. */
  sort?: 'risk';
  /** Submission dates, inclusive, as YYYY-MM-DD. */
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface CorrectionEvent {
  key: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

export class ReviewStore {
  /** Interviews to review, newest submission first, with their flags and number of comments. */
  async queue(tx: MssqlTx, f: QueueFilter) {
    // A second paper entry is not reviewed on its own: it is folded into the first (the record
    // kept), which carries the differences between the two until they are resolved.
    const shared = sql`i.project_id = ${f.projectId} AND i.status IN (${sql.join(f.status)})
      AND i.entry_pass = 1
      ${f.mode ? sql`AND i.mode = ${f.mode}` : sql``}
      ${f.disposition ? sql`AND i.disposition = ${f.disposition}` : sql``}
      ${
        f.flag === 'doubleEntry'
          ? sql`AND EXISTS (SELECT 1 FROM entry_mismatches m WHERE m.first_interview_id = i.id)`
          : f.flag
            ? sql`AND EXISTS (SELECT 1 FROM OPENJSON(i.flags) WHERE [key] = ${f.flag})`
            : sql``
      }
      ${f.sampled !== undefined ? sql`AND i.sampled = ${f.sampled ? 1 : 0}` : sql``}
      ${f.from ? sql`AND i.submitted_at >= ${`${f.from}T00:00:00Z`}` : sql``}
      ${f.to ? sql`AND i.submitted_at <= ${`${f.to}T23:59:59.999Z`}` : sql``}`;
    const where = sql`${shared}
      ${f.interviewerId ? sql`AND i.interviewer_id = ${f.interviewerId}` : sql``}`;
    const total = await sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM interviews i WHERE ${where}`.execute(tx);
    const rows = await sql<{
      id: string;
      external_id: string | null;
      interviewer: string | null;
      interviewer_id: string | null;
      mode: string;
      status: string;
      disposition: string | null;
      submitted_at: Date | null;
      active_ms: number;
      flags: string;
      sampled: boolean;
      submissions: number;
      comments: number;
      second_clerk: string | null;
      open_differences: number;
    }>`
      SELECT i.id, c.external_id, u.name AS interviewer, i.interviewer_id, i.mode, i.status,
        i.disposition, i.submitted_at, i.active_ms, i.flags, i.sampled, i.submissions,
        (SELECT COUNT(*) FROM review_comments rc WHERE rc.interview_id = i.id) AS comments,
        (SELECT TOP (1) ISNULL(su.name, N'—') FROM interviews s
         LEFT JOIN users su ON su.id = s.interviewer_id
         WHERE s.case_id = i.case_id AND s.entry_pass = 2 AND s.submitted_at IS NOT NULL
         ORDER BY s.submitted_at DESC) AS second_clerk,
        (SELECT COUNT(*) FROM entry_mismatches m
         WHERE m.first_interview_id = i.id AND m.status = 'open') AS open_differences
      FROM interviews i
      LEFT JOIN cases c ON c.id = i.case_id
      LEFT JOIN users u ON u.id = i.interviewer_id
      WHERE ${where}
      ORDER BY ${
        f.sort === 'risk'
          ? sql`ISNULL(TRY_CAST(JSON_VALUE(i.flags, '$.risk') AS int), 0) DESC, i.submitted_at DESC, i.id`
          : sql`i.submitted_at DESC, i.id`
      }
      OFFSET ${(f.page - 1) * f.limit} ROWS FETCH NEXT ${f.limit} ROWS ONLY`.execute(tx);
    // Per interviewer, under the same filters (but any interviewer): how many interviews and
    // how many carry a quality flag, so the queue can be worked person by person.
    const people = await sql<{
      interviewer_id: string | null;
      name: string | null;
      n: number;
      flagged: number;
    }>`
      SELECT i.interviewer_id, u.name, COUNT(*) AS n, SUM(fl.flagged) AS flagged
      FROM interviews i
      LEFT JOIN users u ON u.id = i.interviewer_id
      OUTER APPLY (SELECT CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(i.flags)
        WHERE [key] IN (${sql.join([...FLAG_KINDS])})) THEN 1 ELSE 0 END AS flagged) fl
      WHERE ${shared} AND i.interviewer_id IS NOT NULL
      GROUP BY i.interviewer_id, u.name
      ORDER BY SUM(fl.flagged) DESC, COUNT(*) DESC, u.name`.execute(tx);
    return {
      total: total.rows[0]?.n ?? 0,
      interviewers: people.rows.map((r) => ({
        id: r.interviewer_id!.toLowerCase(),
        name: r.name,
        interviews: r.n,
        flagged: r.flagged,
      })),
      page: f.page,
      limit: f.limit,
      rows: rows.rows.map((r) => ({
        ...r,
        id: r.id.toLowerCase(),
        flags: parse<Record<string, unknown>>(r.flags),
      })),
    };
  }

  // Fraud-risk signals (ADR 0001)

  /** Time on each question of the latest counted interviews of a questionnaire version. */
  async dwellSample(tx: MssqlTx, versionId: string, excludeId: string, interviews: number) {
    const res = await sql<{ payload: string }>`
      SELECT p.payload FROM interview_paradata p
      WHERE p.type = 'leave_question' AND p.interview_id IN (
        SELECT TOP (${interviews}) i.id FROM interviews i
        WHERE i.questionnaire_version_id = ${versionId} AND i.id <> ${excludeId}
          AND i.status IN (${sql.join(COUNTED)})
        ORDER BY i.submitted_at DESC)`.execute(tx);
    return res.rows.flatMap((r) => {
      const p = parse<{ key?: string; ms?: number }>(r.payload);
      return typeof p?.key === 'string' && typeof p.ms === 'number'
        ? [{ key: p.key, ms: p.ms }]
        : [];
    });
  }

  /** Start positions of an interviewer's other recent interviews (same project). */
  async interviewerPositions(
    tx: MssqlTx,
    projectId: string,
    interviewerId: string,
    excludeId: string,
    since: Date,
  ) {
    const res = await sql<{ lat: number; lng: number }>`
      SELECT TRY_CAST(JSON_VALUE(p.payload, '$.lat') AS float) AS lat,
             TRY_CAST(JSON_VALUE(p.payload, '$.lng') AS float) AS lng
      FROM interview_paradata p
      JOIN interviews i ON i.id = p.interview_id
      WHERE p.type = 'gps' AND JSON_VALUE(p.payload, '$.when') = 'start'
        AND i.project_id = ${projectId} AND i.interviewer_id = ${interviewerId}
        AND i.id <> ${excludeId} AND i.status IN (${sql.join(COUNTED)})
        AND i.started_at >= ${since.toISOString()}`.execute(tx);
    return res.rows.filter((r) => r.lat !== null && r.lng !== null);
  }

  /** The first geocoded contact of a case, as the address to compare an interview's position to. */
  async caseAddress(tx: MssqlTx, caseId: string) {
    const res = await sql<{ lat: number; lng: number }>`
      SELECT TOP (1) lat, lng FROM contacts
      WHERE case_id = ${caseId} AND lat IS NOT NULL AND lng IS NOT NULL`.execute(tx);
    return res.rows[0] ?? null;
  }

  /** Counted interviews of a project submitted since `since`, for the nightly recompute. */
  async riskCandidates(tx: MssqlTx, projectId: string, since: Date) {
    const res = await sql<{
      id: string;
      interviewer_id: string | null;
      case_id: string | null;
      questionnaire_version_id: string;
      flags: string;
    }>`
      SELECT id, interviewer_id, case_id, questionnaire_version_id, flags FROM interviews
      WHERE project_id = ${projectId} AND status IN (${sql.join(COUNTED)})
        AND submitted_at >= ${since.toISOString()}`.execute(tx);
    return res.rows.map((r) => ({
      id: r.id.toLowerCase(),
      interviewerId: r.interviewer_id ? r.interviewer_id.toLowerCase() : null,
      caseId: r.case_id ? r.case_id.toLowerCase() : null,
      versionId: r.questionnaire_version_id.toLowerCase(),
      flags: parse<Record<string, unknown>>(r.flags) ?? {},
    }));
  }

  async setFlags(tx: MssqlTx, id: string, flags: Record<string, unknown>) {
    await sql`UPDATE interviews SET flags = ${JSON.stringify(flags)} WHERE id = ${id}`.execute(tx);
  }

  /** The person's interviews sent back for fixing, with the latest comment of each. */
  async returnedTo(tx: MssqlTx, projectId: string, userId: string) {
    const res = await sql<{
      id: string;
      external_id: string | null;
      mode: string;
      reviewed_at: Date | null;
      reviewer: string | null;
      comment: string | null;
    }>`
      SELECT i.id, c.external_id, i.mode, i.reviewed_at, u.name AS reviewer,
        (SELECT TOP (1) rc.body FROM review_comments rc WHERE rc.interview_id = i.id
         ORDER BY rc.created_at DESC) AS comment
      FROM interviews i
      LEFT JOIN cases c ON c.id = i.case_id
      LEFT JOIN users u ON u.id = i.reviewed_by
      WHERE i.project_id = ${projectId} AND i.interviewer_id = ${userId} AND i.status = 'returned'
      ORDER BY i.reviewed_at DESC`.execute(tx);
    const ids = res.rows.map((r) => r.id);
    // The comments on single questions still to deal with, so the interviewer knows where to go.
    const open = ids.length
      ? await sql<{ interview_id: string; variable: string; body: string }>`
          SELECT rc.interview_id, rc.variable, rc.body FROM review_comments rc
          WHERE rc.interview_id IN (${sql.join(ids)}) AND rc.variable IS NOT NULL
            AND rc.resolved_at IS NULL
          ORDER BY rc.created_at`.execute(tx)
      : { rows: [] };
    return res.rows.map((r) => ({
      ...r,
      id: r.id.toLowerCase(),
      questions: open.rows
        .filter((c) => c.interview_id.toLowerCase() === r.id.toLowerCase())
        .map((c) => ({ variable: c.variable, body: c.body })),
    }));
  }

  /** Differences between the two paper entries, with this interview as the first, not resolved. */
  async openDifferences(tx: MssqlTx, interviewId: string) {
    const res = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM entry_mismatches
      WHERE first_interview_id = ${interviewId} AND status = 'open'`.execute(tx);
    return res.rows[0]?.n ?? 0;
  }

  /**
   * One interviewer's own quality signals in a project (their submitted first entries): how
   * their interviews fared in review, how many carry each quality flag, and the median length
   * of their complete interviews beside the team's.
   */
  async ownQuality(tx: MssqlTx, projectId: string, userId: string) {
    const mine = await sql<{
      status: string;
      disposition: string | null;
      active_ms: number;
      submissions: number;
      flags: string | null;
    }>`
      SELECT status, disposition, active_ms, submissions, flags FROM interviews
      WHERE project_id = ${projectId} AND interviewer_id = ${userId} AND entry_pass = 1
        AND submitted_at IS NOT NULL`.execute(tx);
    const team = await sql<{ median: number | null }>`
      SELECT TOP (1) PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY active_ms) OVER () AS median
      FROM interviews
      WHERE project_id = ${projectId} AND entry_pass = 1 AND disposition = 'COMPLETE'
        AND interviewer_id IS NOT NULL AND status IN (${sql.join(COUNTED)})`.execute(tx);
    return {
      rows: mine.rows.map((r) => ({
        status: r.status,
        disposition: r.disposition,
        activeMs: r.active_ms,
        submissions: r.submissions,
        flags: parse<Record<string, unknown>>(r.flags) ?? {},
      })),
      teamMedianMs: team.rows[0]?.median ?? null,
    };
  }

  // Comments

  async addComment(
    tx: MssqlTx,
    v: {
      tenantId: string;
      interviewId: string;
      variable?: string | null;
      body: string;
      authorId: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('review_comments')
      .values({
        id,
        tenant_id: v.tenantId,
        interview_id: v.interviewId,
        variable: v.variable ?? null,
        body: v.body,
        author_id: v.authorId,
        resolved_at: null,
      })
      .execute();
    return id;
  }

  async comments(tx: MssqlTx, interviewId: string) {
    return tx
      .selectFrom('review_comments')
      .selectAll()
      .where('interview_id', '=', interviewId)
      .orderBy('created_at')
      .orderBy(idOrder)
      .execute();
  }

  async resolveComment(tx: MssqlTx, id: string): Promise<boolean> {
    const r = await tx
      .updateTable('review_comments')
      .set({ resolved_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .where('resolved_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  // Review status of the interview, and what it does to its case

  async setReviewStatus(
    tx: MssqlTx,
    interviewId: string,
    status: string,
    reviewerId: string,
  ): Promise<void> {
    await tx
      .updateTable('interviews')
      .set({
        status,
        reviewed_by: reviewerId,
        reviewed_at: sql<Date>`SYSDATETIMEOFFSET()`,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', interviewId)
      .execute();
  }

  /** An interview sent back: its case is being worked again. */
  async caseInProgress(tx: MssqlTx, caseId: string): Promise<void> {
    await tx
      .updateTable('cases')
      .set({ status: 'in_progress', updated_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', caseId)
      .execute();
  }

  /** A rejected interview reopens its case: fresh if nobody holds it, assigned if someone does. */
  async reopenCase(tx: MssqlTx, caseId: string): Promise<void> {
    await tx
      .updateTable('cases')
      .set({
        status: sql<string>`CASE WHEN assigned_to IS NULL THEN 'fresh' ELSE 'assigned' END`,
        disposition: null,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', caseId)
      .execute();
  }

  async setCaseDisposition(tx: MssqlTx, caseId: string, disposition: string | null): Promise<void> {
    await tx
      .updateTable('cases')
      .set({ disposition, updated_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', caseId)
      .execute();
  }

  // Corrections

  /**
   * Records a reviewer's changes in the answer history, numbered after the last of the `review`
   * device. The interview is locked first, so two reviewers (or a correction and a coding) cannot
   * take the same numbers: the history drops a repeated number silently, so this must not race.
   * Returns the last number used.
   */
  async appendReviewEvents(
    tx: MssqlTx,
    v: {
      tenantId: string;
      interviewId: string;
      userId: string;
      events: CorrectionEvent[];
      source?: string;
    },
  ): Promise<number> {
    await sql`SELECT id FROM interviews WITH (UPDLOCK, ROWLOCK) WHERE id = ${v.interviewId}`.execute(
      tx,
    );
    const last = await sql<{ n: number }>`
      SELECT COALESCE(MAX(seq), 0) AS n FROM interview_answer_events
      WHERE interview_id = ${v.interviewId} AND device_id = ${REVIEW_DEVICE}`.execute(tx);
    let seq = last.rows[0]?.n ?? 0;
    if (!v.events.length) return seq;
    const rows = v.events.map((e) => ({
      id: randomUUID(),
      seq: ++seq,
      variable: e.key,
      oldValue: e.oldValue === undefined || e.oldValue === null ? null : JSON.stringify(e.oldValue),
      newValue: e.newValue === undefined || e.newValue === null ? null : JSON.stringify(e.newValue),
      reason: e.reason ?? null,
    }));
    await sql`
      INSERT INTO interview_answer_events (id, tenant_id, interview_id, device_id, seq,
        variable, old_value, new_value, at, by_user_id, source, reason)
      SELECT j.id, ${v.tenantId}, ${v.interviewId}, ${REVIEW_DEVICE}, j.seq, j.variable, j.oldValue,
        j.newValue, SYSDATETIMEOFFSET(), ${v.userId}, ${v.source ?? 'reviewer'}, j.reason
      FROM OPENJSON(${JSON.stringify(rows)}) WITH (
        id uniqueidentifier, seq int, variable nvarchar(450), oldValue nvarchar(max),
        newValue nvarchar(max), reason nvarchar(450)
      ) j`.execute(tx);
    return seq;
  }

  /** Writes a corrected snapshot; a device holding a copy takes the new state (version bumped). */
  async writeCorrection(
    tx: MssqlTx,
    interviewId: string,
    v: { state: unknown; answers: unknown; disposition: string | null },
  ): Promise<void> {
    await tx
      .updateTable('interviews')
      .set({
        state: JSON.stringify(v.state),
        answers: JSON.stringify(v.answers),
        state_version: sql<number>`state_version + 1`,
        state_device: REVIEW_DEVICE,
        disposition: v.disposition,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', interviewId)
      .execute();
  }

  // Coding of "other, specify" texts

  /** The "other" texts of counted interviews: variable key, text and the interview it is in. */
  async otherTexts(tx: MssqlTx, projectId: string, variable?: string) {
    const res = await sql<{ key: string; value: string; interview_id: string }>`
      SELECT a.[key] AS [key], a.[value] AS [value], i.id AS interview_id
      FROM interviews i
      CROSS APPLY OPENJSON(i.answers) a
      WHERE i.project_id = ${projectId} AND i.status IN (${sql.join(COUNTED)})
        AND a.type = 1 AND a.[key] LIKE '%[_]OTHER' AND LEN(LTRIM(RTRIM(a.[value]))) > 0`.execute(
      tx,
    );
    // The variable is named with or without its `_OTHER` suffix; a roster row's key is
    // `HH[1].NAME_OTHER`, whose variable is the last part without the row number.
    const last = (k: string) =>
      k
        .replace(/\[\d+\]/g, '')
        .split('.')
        .pop()!;
    return res.rows
      .map((r) => ({ key: r.key, value: r.value, interview_id: r.interview_id.toLowerCase() }))
      .filter(
        (r) =>
          !variable || last(r.key) === variable || last(r.key).replace(/_OTHER$/, '') === variable,
      );
  }

  async codes(tx: MssqlTx, projectId: string, variable: string) {
    return tx
      .selectFrom('open_codes')
      .select(['code', 'label'])
      .where('project_id', '=', projectId)
      .where('variable', '=', variable)
      .orderBy('code')
      .execute();
  }

  async codedTexts(tx: MssqlTx, projectId: string, variable?: string) {
    let q = tx
      .selectFrom('coded_texts')
      .select(['variable', 'text', 'code'])
      .where('project_id', '=', projectId);
    if (variable) q = q.where('variable', '=', variable);
    return q.execute();
  }

  /** Replaces the list of codes of a variable. Codes already given to a text cannot be removed. */
  async saveCodeList(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      variable: string;
      codes: { code: number; label: string }[];
    },
  ): Promise<{ inUse: number[] }> {
    const used = await tx
      .selectFrom('coded_texts')
      .select('code')
      .where('project_id', '=', v.projectId)
      .where('variable', '=', v.variable)
      .execute();
    const keep = new Set(v.codes.map((c) => c.code));
    const inUse = [...new Set(used.map((u) => u.code))].filter((c) => !keep.has(c));
    if (inUse.length) return { inUse };
    await tx
      .deleteFrom('open_codes')
      .where('project_id', '=', v.projectId)
      .where('variable', '=', v.variable)
      .execute();
    if (v.codes.length)
      await tx
        .insertInto('open_codes')
        .values(
          v.codes.map((c) => ({
            id: randomUUID(),
            tenant_id: v.tenantId,
            project_id: v.projectId,
            variable: v.variable,
            code: c.code,
            label: c.label,
          })),
        )
        .execute();
    return { inUse: [] };
  }

  /**
   * Gives texts a code (or removes it with `code` null): stored per distinct text, then written to
   * every counted interview with that text as `<VARIABLE>_CODE` and recorded as a reviewer's
   * change. Returns the interviews changed.
   */
  async assignCode(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      variable: string;
      texts: string[];
      code: number | null;
      userId: string;
    },
  ): Promise<number> {
    if (v.code !== null) {
      const ok = await tx
        .selectFrom('open_codes')
        .select('id')
        .where('project_id', '=', v.projectId)
        .where('variable', '=', v.variable)
        .where('code', '=', v.code)
        .executeTakeFirst();
      if (!ok) throw new Error('Unknown code');
    }
    const keys = [...new Set(v.texts.map((t) => t.trim().toLowerCase()))];
    if (v.code === null) {
      for (const part of [keys.slice(0, 1000), keys.slice(1000)])
        if (part.length)
          await tx
            .deleteFrom('coded_texts')
            .where('project_id', '=', v.projectId)
            .where('variable', '=', v.variable)
            .where('text', 'in', part)
            .execute();
    } else {
      for (const text of keys)
        await sql`
          BEGIN TRY
            INSERT INTO coded_texts (id, tenant_id, project_id, variable, text, code, coded_by)
            VALUES (${randomUUID()}, ${v.tenantId}, ${v.projectId}, ${v.variable}, ${text}, ${v.code}, ${v.userId});
          END TRY
          BEGIN CATCH
            IF ERROR_NUMBER() IN (2601, 2627)
              UPDATE coded_texts SET code = ${v.code}, coded_by = ${v.userId}, coded_at = SYSDATETIMEOFFSET()
              WHERE project_id = ${v.projectId} AND variable = ${v.variable} AND text = ${text};
            ELSE
              THROW;
          END CATCH`.execute(tx);
    }
    const hits = (await this.otherTexts(tx, v.projectId, v.variable)).filter((t) =>
      keys.includes(t.value.trim().toLowerCase()),
    );
    let changed = 0;
    for (const h of hits) {
      const codeKey = h.key.replace(/_OTHER$/, '_CODE');
      const locked = await sql<{ answers: string }>`
        SELECT answers FROM interviews WITH (UPDLOCK, ROWLOCK) WHERE id = ${h.interview_id}`.execute(
        tx,
      );
      const answers = parse<Record<string, unknown>>(locked.rows[0]!.answers);
      const old = answers[codeKey] ?? null;
      if (old === v.code) continue;
      if (v.code === null) delete answers[codeKey];
      else answers[codeKey] = v.code;
      await tx
        .updateTable('interviews')
        .set({ answers: JSON.stringify(answers), updated_at: sql<Date>`SYSDATETIMEOFFSET()` })
        .where('id', '=', h.interview_id)
        .execute();
      await this.appendReviewEvents(tx, {
        tenantId: v.tenantId,
        interviewId: h.interview_id,
        userId: v.userId,
        events: [{ key: codeKey, oldValue: old, newValue: v.code, reason: 'coding' }],
      });
      changed++;
    }
    return changed;
  }
}
