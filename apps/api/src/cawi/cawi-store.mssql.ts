import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';

/**
 * Web surveys and e-mail on SQL Server (Kysely): templates, waves, invitations with the leases the
 * dispatcher takes, delivery tracking, bounces and suppressions, open links, and quick feedback,
 * as `cawi.service.ts` and `feedback.service.ts` do them on PostgreSQL with Drizzle
 * (docs/roadmap.md). Takes the transaction of `MssqlDatabase.withTenant`; the public lookups by
 * token or slug are `MssqlDatabase.withTenantOf`.
 */
export type InvitationRow = Selectable<MssqlSchema['invitations']>;
export type WaveRow = Omit<Selectable<MssqlSchema['waves']>, 'reminder_days'> & {
  reminder_days: number[];
};

const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));
const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const toWave = (w: Selectable<MssqlSchema['waves']>): WaveRow => ({
  ...w,
  reminder_days: parse(w.reminder_days),
});

export interface NewInvitation {
  caseId: string | null;
  contactId?: string | null;
  email: string | null;
  tokenHash: string;
  tokenEnc: string;
  language: string;
  /** 'queued' to send; 'sent' for a link nothing is sent to (or 'link'). */
  status?: string;
}

export class CawiStore {
  // Templates

  async saveTemplate(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      kind: string;
      language: string;
      subject: string;
      body: string;
      userId: string | null;
    },
  ): Promise<void> {
    await sql`
      BEGIN TRY
        INSERT INTO dbo.email_templates (id, tenant_id, project_id, kind, language, subject, body, updated_by)
        VALUES (${randomUUID()}, ${v.tenantId}, ${v.projectId}, ${v.kind}, ${v.language}, ${v.subject}, ${v.body}, ${v.userId});
      END TRY
      BEGIN CATCH
        IF ERROR_NUMBER() IN (2601, 2627)
          UPDATE dbo.email_templates SET subject = ${v.subject}, body = ${v.body}, updated_by = ${v.userId},
            updated_at = SYSDATETIMEOFFSET()
          WHERE project_id = ${v.projectId} AND kind = ${v.kind} AND language = ${v.language};
        ELSE
          THROW;
      END CATCH`.execute(tx);
  }

  async templates(tx: MssqlTx, projectId: string) {
    return tx
      .selectFrom('email_templates')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('kind')
      .orderBy('language')
      .execute();
  }

  // Waves

  async createWave(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      questionnaireId: string;
      name: string;
      channel?: 'email' | 'links';
      filter?: string | null;
      reminderDays?: number[];
      sendAt?: Date | null;
      bouncesToCati?: boolean;
      createdBy: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('waves')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        name: v.name,
        channel: v.channel ?? 'email',
        filter: v.filter ?? null,
        reminder_days: JSON.stringify([...(v.reminderDays ?? [])].sort((a, b) => a - b)),
        send_at: v.sendAt ?? null,
        bounces_to_cati: v.bouncesToCati ?? false,
        created_by: v.createdBy,
        sent_at: null,
      })
      .execute();
    return id;
  }

  async wave(tx: MssqlTx, id: string): Promise<WaveRow | undefined> {
    const w = await tx.selectFrom('waves').selectAll().where('id', '=', id).executeTakeFirst();
    return w && toWave(w);
  }

  /** The wave with a row lock for the rest of the transaction (sending is decided once). */
  async lockWave(tx: MssqlTx, id: string): Promise<WaveRow | undefined> {
    const res = await sql<
      Selectable<MssqlSchema['waves']>
    >`SELECT * FROM dbo.waves WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`.execute(tx);
    return res.rows[0] && toWave(res.rows[0]);
  }

  async setWaveStatus(
    tx: MssqlTx,
    id: string,
    status: 'draft' | 'sending' | 'sent',
  ): Promise<void> {
    await tx
      .updateTable('waves')
      .set({ status, ...(status === 'sent' ? { sent_at: sql<Date>`SYSDATETIMEOFFSET()` } : {}) })
      .where('id', '=', id)
      .execute();
  }

  /** The waves of a project with how far each invitation list has got. */
  async waveProgress(tx: MssqlTx, projectId: string) {
    const res = await sql<{
      id: string;
      name: string;
      status: string;
      invited: number;
      sent: number;
      opened: number;
      started: number;
      completed: number;
      bounced: number;
      reminders: number;
    }>`
      SELECT w.id, w.name, w.status, COUNT(i.id) AS invited,
        COALESCE(SUM(CASE WHEN i.sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent,
        COALESCE(SUM(CASE WHEN i.opened_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS opened,
        COALESCE(SUM(CASE WHEN i.started_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS started,
        COALESCE(SUM(CASE WHEN i.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN i.bounced_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS bounced,
        COALESCE(SUM(i.reminders_sent), 0) AS reminders
      FROM dbo.waves w LEFT JOIN dbo.invitations i ON i.wave_id = w.id
      WHERE w.project_id = ${projectId}
      GROUP BY w.id, w.name, w.status, w.created_at
      ORDER BY w.created_at, w.id`.execute(tx);
    return res.rows.map((r) => ({ ...r, id: r.id.toLowerCase() }));
  }

  // Invitations

  /**
   * Adds the invitations of a wave, one per case: a case already invited in the wave is skipped
   * (ON CONFLICT DO NOTHING of PostgreSQL), under a range lock so that two sends at once cannot
   * both add it. Returns how many were added.
   */
  async addInvitations(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      questionnaireId: string;
      waveId: string;
      rows: NewInvitation[];
    },
  ): Promise<number> {
    let added = 0;
    for (const part of chunks(v.rows, 1000)) {
      const rows = part.map((r) => ({
        id: randomUUID(),
        caseId: r.caseId,
        contactId: r.contactId ?? null,
        email: r.email,
        tokenHash: r.tokenHash,
        tokenEnc: r.tokenEnc,
        language: r.language,
        status: r.status ?? 'queued',
      }));
      const res = await sql<{ n: number }>`
        INSERT INTO dbo.invitations (id, tenant_id, project_id, questionnaire_id, wave_id, case_id,
          contact_id, email, token_hash, token_enc, language, status, sent_at)
        SELECT j.id, ${v.tenantId}, ${v.projectId}, ${v.questionnaireId}, ${v.waveId}, j.caseId,
          j.contactId, j.email, j.tokenHash, j.tokenEnc, j.language, j.status,
          CASE WHEN j.status = 'sent' THEN SYSDATETIMEOFFSET() ELSE NULL END
        FROM OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, caseId uniqueidentifier, contactId uniqueidentifier,
          email nvarchar(450), tokenHash nvarchar(450), tokenEnc nvarchar(max),
          language nvarchar(32), status nvarchar(32)
        ) j
        WHERE NOT EXISTS (
          SELECT 1 FROM dbo.invitations x WITH (UPDLOCK, HOLDLOCK)
          WHERE x.wave_id = ${v.waveId} AND x.case_id = j.caseId
        );
        SELECT @@ROWCOUNT AS n`.execute(tx);
      added += Number(res.rows[0]?.n ?? 0);
    }
    return added;
  }

  /** The anonymous start of an open link (no wave, no case). */
  async addOpenInvitation(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      questionnaireId: string;
      tokenHash: string;
      tokenEnc: string;
      language: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('invitations')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        wave_id: null,
        case_id: null,
        contact_id: null,
        email: null,
        token_hash: v.tokenHash,
        token_enc: v.tokenEnc,
        language: v.language,
        sent_at: null,
        delivered_at: null,
        bounced_at: null,
        bounce_type: null,
        opened_at: null,
        clicked_at: null,
        started_at: null,
        completed_at: null,
        last_reminder_at: null,
        lease_until: null,
        last_error: null,
        interview_id: null,
      })
      .execute();
    return id;
  }

  async invitation(tx: MssqlTx, id: string): Promise<InvitationRow | undefined> {
    return tx.selectFrom('invitations').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async invitationByToken(tx: MssqlTx, tokenHash: string): Promise<InvitationRow | undefined> {
    return tx
      .selectFrom('invitations')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
  }

  /**
   * Takes a batch for one dispatcher: queued invitations (oldest first) and reminders that are due
   * (the days since the last send have passed), both of waves whose send time has come and
   * questionnaires that are active, never of cases already finished. Each is leased until
   * `leaseUntil`; another dispatcher skips them until then (READPAST), and takes them again if
   * this one is lost. The candidates are chosen first, without locks, and only those are locked.
   */
  async lease(
    tx: MssqlTx,
    v: { now: Date; limit: number; leaseMs: number },
  ): Promise<{ invitation: InvitationRow; kind: 'invitation' | 'reminder' }[]> {
    const now = v.now.toISOString();
    const free = sql`(i.lease_until IS NULL OR i.lease_until < ${now})`;
    const active = sql`EXISTS (SELECT 1 FROM dbo.questionnaires q WHERE q.id = i.questionnaire_id AND q.state = 'active')`;
    const queued = await sql<{ id: string }>`
      SELECT TOP (${v.limit}) i.id FROM dbo.invitations i
      JOIN dbo.waves w ON w.id = i.wave_id
      WHERE i.status = 'queued' AND ${free} AND (w.send_at IS NULL OR w.send_at <= ${now}) AND ${active}
      ORDER BY i.queued_at, i.id`.execute(tx);
    const due = await sql<{ id: string }>`
      SELECT TOP (${v.limit}) i.id FROM dbo.invitations i
      JOIN dbo.waves w ON w.id = i.wave_id
      WHERE i.status = 'sent' AND i.completed_at IS NULL AND ${free} AND ${active}
        AND NOT EXISTS (SELECT 1 FROM dbo.cases c WHERE c.id = i.case_id AND c.status IN ('finalised', 'withdrawn'))
        AND i.reminders_sent < (SELECT COUNT(*) FROM OPENJSON(w.reminder_days))
        AND DATEADD(day, CAST(JSON_VALUE(w.reminder_days, CONCAT('$[', i.reminders_sent, ']')) AS int), i.sent_at) <= ${now}
      ORDER BY i.sent_at, i.id`.execute(tx);
    const ids = [...queued.rows.map((r) => r.id), ...due.rows.map((r) => r.id)];
    if (!ids.length) return [];
    const taken = await sql<InvitationRow>`
      UPDATE i SET lease_until = DATEADD(millisecond, ${v.leaseMs}, ${now})
      OUTPUT inserted.*
      FROM dbo.invitations i WITH (UPDLOCK, READPAST, ROWLOCK)
      WHERE i.id IN (${sql.join(ids)}) AND i.status IN ('queued', 'sent') AND ${free}`.execute(tx);
    return taken.rows.map((r) => ({
      invitation: r,
      kind: r.status === 'queued' ? 'invitation' : 'reminder',
    }));
  }

  /** The invitation went out (or a reminder did): counted, and the lease let go. */
  async markSent(tx: MssqlTx, id: string, kind: 'invitation' | 'reminder'): Promise<void> {
    await sql`
      UPDATE dbo.invitations SET lease_until = NULL, last_error = NULL,
        send_attempts = send_attempts + 1,
        status = CASE WHEN ${kind} = 'invitation' THEN 'sent' ELSE status END,
        sent_at = CASE WHEN ${kind} = 'invitation' THEN SYSDATETIMEOFFSET() ELSE sent_at END,
        reminders_sent = reminders_sent + CASE WHEN ${kind} = 'reminder' THEN 1 ELSE 0 END,
        last_reminder_at = CASE WHEN ${kind} = 'reminder' THEN SYSDATETIMEOFFSET() ELSE last_reminder_at END
      WHERE id = ${id}`.execute(tx);
  }

  /** The send failed: the attempt is counted and, after `maxAttempts`, the invitation is failed. */
  async markFailed(tx: MssqlTx, id: string, error: string, maxAttempts: number): Promise<void> {
    await sql`
      UPDATE dbo.invitations SET send_attempts = send_attempts + 1, last_error = ${error},
        lease_until = NULL,
        status = CASE WHEN send_attempts + 1 >= ${maxAttempts} AND status = 'queued' THEN 'failed' ELSE status END
      WHERE id = ${id}`.execute(tx);
  }

  async markSuppressed(tx: MssqlTx, id: string): Promise<void> {
    await tx
      .updateTable('invitations')
      .set({ status: 'suppressed', lease_until: null })
      .where('id', '=', id)
      .execute();
  }

  // Tracking (each is recorded once, the first time)

  async track(
    tx: MssqlTx,
    id: string,
    event: 'delivered' | 'opened' | 'clicked' | 'started',
  ): Promise<void> {
    const column = {
      delivered: 'delivered_at',
      opened: 'opened_at',
      clicked: 'clicked_at',
      started: 'started_at',
    }[event];
    await sql`UPDATE dbo.invitations SET ${sql.raw(column)} = SYSDATETIMEOFFSET() WHERE id = ${id} AND ${sql.raw(column)} IS NULL`.execute(
      tx,
    );
  }

  /** The respondent finished: the invitation is completed and tied to the interview. */
  async markCompleted(tx: MssqlTx, id: string, interviewId: string): Promise<void> {
    await tx
      .updateTable('invitations')
      .set({
        status: 'completed',
        completed_at: sql<Date>`COALESCE(completed_at, SYSDATETIMEOFFSET())`,
        interview_id: interviewId,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * A bounce reported by the provider: noted on the invitation and, if hard, the address is never
   * mailed again. Returns whether it was recorded (it is not for an invitation that is gone).
   */
  async bounce(
    tx: MssqlTx,
    v: { tenantId: string; id: string; type: 'hard' | 'soft' | 'complaint' },
  ): Promise<boolean> {
    const inv = await this.invitation(tx, v.id);
    if (!inv) return false;
    await tx
      .updateTable('invitations')
      .set({
        status: v.type === 'soft' ? inv.status : 'bounced',
        bounced_at: sql<Date>`COALESCE(bounced_at, SYSDATETIMEOFFSET())`,
        bounce_type: v.type,
      })
      .where('id', '=', v.id)
      .execute();
    if (v.type !== 'soft' && inv.email)
      await this.suppress(tx, {
        tenantId: v.tenantId,
        email: inv.email,
        reason: v.type === 'hard' ? 'hard_bounce' : 'complaint',
      });
    return true;
  }

  // Suppressions

  async suppress(
    tx: MssqlTx,
    v: { tenantId: string; email: string; reason: 'hard_bounce' | 'complaint' | 'unsubscribe' },
  ): Promise<void> {
    await sql`
      BEGIN TRY
        INSERT INTO dbo.suppressions (id, tenant_id, email, reason)
        VALUES (${randomUUID()}, ${v.tenantId}, ${v.email}, ${v.reason});
      END TRY
      BEGIN CATCH
        IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;
      END CATCH`.execute(tx);
  }

  /** Which of the addresses must not be mailed (address comparison ignores case). */
  async suppressed(tx: MssqlTx, emails: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunks(emails, 1000)) {
      if (!part.length) continue;
      const rows = await tx
        .selectFrom('suppressions')
        .select('email')
        .where('email', 'in', part)
        .execute();
      for (const r of rows) out.add(r.email.toLowerCase());
    }
    return out;
  }

  async unsuppress(tx: MssqlTx, email: string): Promise<void> {
    await tx.deleteFrom('suppressions').where('email', '=', email).execute();
  }

  // Open links

  async createOpenLink(
    tx: MssqlTx,
    v: { tenantId: string; projectId: string; questionnaireId: string; slug: string },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('open_links')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        slug: v.slug,
      })
      .execute();
    return id;
  }

  async setOpenLinkActive(tx: MssqlTx, id: string, active: boolean): Promise<void> {
    await tx.updateTable('open_links').set({ active }).where('id', '=', id).execute();
  }

  async openLink(tx: MssqlTx, id: string) {
    return tx.selectFrom('open_links').selectAll().where('id', '=', id).executeTakeFirst();
  }

  // Quick feedback

  async createPoint(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      name: string;
      question: Record<string, string>;
      faces?: 3 | 5;
      askComment?: boolean;
      slug: string;
      items?: unknown[];
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('feedback_points')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        name: v.name,
        question: JSON.stringify(v.question),
        faces: v.faces ?? 3,
        ask_comment: v.askComment ?? true,
        slug: v.slug,
        items: JSON.stringify(v.items ?? []),
      })
      .execute();
    return id;
  }

  /** Changing the questions or the follow-up items raises the version (the answers kept say which they answered). */
  async updatePoint(
    tx: MssqlTx,
    id: string,
    v: {
      name?: string;
      question?: Record<string, string>;
      faces?: 3 | 5;
      askComment?: boolean;
      items?: unknown[];
      active?: boolean;
    },
  ): Promise<void> {
    const now = sql<Date>`SYSDATETIMEOFFSET()`;
    await tx
      .updateTable('feedback_points')
      .set({
        updated_at: now,
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.faces !== undefined ? { faces: v.faces } : {}),
        ...(v.askComment !== undefined ? { ask_comment: v.askComment } : {}),
        ...(v.active !== undefined ? { active: v.active } : {}),
        ...(v.question !== undefined ? { question: JSON.stringify(v.question) } : {}),
        ...(v.items !== undefined ? { items: JSON.stringify(v.items) } : {}),
        ...(v.question !== undefined || v.items !== undefined || v.faces !== undefined
          ? { version: sql<number>`version + 1` }
          : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async point(tx: MssqlTx, id: string) {
    const p = await tx
      .selectFrom('feedback_points')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return (
      p && {
        ...p,
        question: parse<Record<string, string>>(p.question),
        items: parse<unknown[]>(p.items),
      }
    );
  }

  async addResponse(
    tx: MssqlTx,
    v: {
      tenantId: string;
      pointId: string;
      score: number;
      channel?: 'link' | 'widget' | 'paper';
      ref?: string | null;
      comment?: string | null;
      editHash?: string | null;
      answers?: unknown;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('feedback_responses')
      .values({
        id,
        tenant_id: v.tenantId,
        point_id: v.pointId,
        score: v.score,
        channel: v.channel ?? 'link',
        ref: v.ref ?? null,
        comment: v.comment ?? null,
        edit_hash: v.editHash ?? null,
        answers: v.answers === undefined || v.answers === null ? null : JSON.stringify(v.answers),
      })
      .execute();
    return id;
  }

  /** The browser that answered adds its comment once, with the key it was given. */
  async addCommentOnce(
    tx: MssqlTx,
    v: { id: string; editHash: string; comment: string },
  ): Promise<boolean> {
    const r = await tx
      .updateTable('feedback_responses')
      .set({ comment: v.comment, edit_hash: null })
      .where('id', '=', v.id)
      .where('edit_hash', '=', v.editHash)
      .where('comment', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /** Answers per score, and the average, of a point. */
  async scoreSummary(tx: MssqlTx, pointId: string) {
    const rows = await tx
      .selectFrom('feedback_responses')
      .select(['score', sql<number>`COUNT(*)`.as('n')])
      .where('point_id', '=', pointId)
      .groupBy('score')
      .orderBy('score')
      .execute();
    const total = rows.reduce((s, r) => s + r.n, 0);
    const sum = rows.reduce((s, r) => s + r.score * r.n, 0);
    return {
      total,
      average: total ? sum / total : null,
      byScore: Object.fromEntries(rows.map((r) => [r.score, r.n])),
    };
  }
}
