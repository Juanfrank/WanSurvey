import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';

export type ContactKind = 'phone' | 'email';

export interface NoContactRow {
  id: string;
  kind: ContactKind;
  value: string;
  channels: string[] | null;
  reason: string;
  source: string;
  note: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  liftedAt: Date | null;
}

export interface NoContactInput {
  kind: ContactKind;
  value: string;
  channels: string[] | null;
  reason: string;
  source: string;
  note?: string | null;
  expiresAt?: Date | null;
}

export interface ParticipationInput {
  kind: ContactKind;
  value: string;
  channel: string;
  occurredAt: Date;
  result?: string | null;
  projectName?: string | null;
  source: 'system' | 'history';
  caseId?: string | null;
}

export interface ParticipationRow {
  kind: ContactKind;
  value: string;
  channel: string;
  occurredAt: Date;
  result: string | null;
  projectName: string | null;
  source: string;
}

interface RawNoContact {
  id: string;
  kind: ContactKind;
  value: string;
  channels: string | null;
  reason: string;
  source: string;
  note: string | null;
  expires_at: Date | null;
  created_at: Date;
  lifted_at: Date | null;
}

const toRow = (r: RawNoContact): NoContactRow => ({
  id: r.id,
  kind: r.kind,
  value: r.value,
  channels: r.channels ? (JSON.parse(r.channels) as string[]) : null,
  reason: r.reason,
  source: r.source,
  note: r.note,
  expiresAt: r.expires_at ? new Date(r.expires_at) : null,
  createdAt: new Date(r.created_at),
  liftedAt: r.lifted_at ? new Date(r.lifted_at) : null,
});

/** In force: not lifted and not past its expiry. */
const ACTIVE = sql`n.lifted_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > SYSDATETIMEOFFSET())`;

/**
 * SQL: the case (alias given) has a phone or e-mail on the no-contact list that applies to
 * `channel` and is in force. Used by the call queue so entries added after loading still count.
 */
export const hasNoContact = (caseAlias: string, channel: string) => sql`EXISTS (
  SELECT 1 FROM contacts nct
  JOIN no_contact n ON n.tenant_id = nct.tenant_id AND n.kind = nct.type AND n.value = nct.value
  WHERE nct.case_id = ${sql.ref(`${caseAlias}.id`)} AND ${ACTIVE}
    AND (n.channels IS NULL OR EXISTS (SELECT 1 FROM OPENJSON(n.channels) ch WHERE ch.value = ${channel})))`;

/**
 * The people registry on SQL Server (ADR 0002, mssql/0026): the no-contact list and who took part in what, by
 * contact value. Takes the transaction of `MssqlDatabase.withTenant`.
 */
export class RegistryStore {
  /**
   * The entries in force for these values and, when `channel` is given, that apply to it (a
   * list of channels, or none for all of them). Keyed by `kind\0value`.
   */
  async blocked(
    tx: MssqlTx,
    tenantId: string,
    items: { kind: ContactKind; value: string }[],
    channel?: string,
  ): Promise<Map<string, NoContactRow>> {
    const out = new Map<string, NoContactRow>();
    if (!items.length) return out;
    const res = await sql<RawNoContact>`
      SELECT n.* FROM no_contact n
      JOIN OPENJSON(${JSON.stringify(items)}) WITH (kind nvarchar(16) '$.kind', value nvarchar(450) '$.value') j
        ON j.kind = n.kind AND j.value = n.value
      WHERE n.tenant_id = ${tenantId} AND ${ACTIVE}
        ${channel ? sql`AND (n.channels IS NULL OR EXISTS (SELECT 1 FROM OPENJSON(n.channels) c WHERE c.value = ${channel}))` : sql``}`.execute(
      tx,
    );
    for (const r of res.rows) out.set(`${r.kind}\u0000${r.value}`, toRow(r));
    return out;
  }

  /** Adds entries; a value already on the list (not lifted) takes the new terms. */
  async upsert(
    tx: MssqlTx,
    tenantId: string,
    by: string | null,
    entries: NoContactInput[],
  ): Promise<{ added: number; updated: number }> {
    if (!entries.length) return { added: 0, updated: 0 };
    const json = JSON.stringify(
      entries.map((e) => ({
        id: randomUUID(),
        kind: e.kind,
        value: e.value,
        channels: e.channels ? JSON.stringify(e.channels) : null,
        reason: e.reason,
        source: e.source,
        note: e.note ?? null,
        expires: e.expiresAt?.toISOString() ?? null,
      })),
    );
    const shape = sql`WITH (id uniqueidentifier '$.id', kind nvarchar(16) '$.kind', value nvarchar(450) '$.value',
        channels nvarchar(max) '$.channels', reason nvarchar(32) '$.reason', source nvarchar(16) '$.source',
        note nvarchar(1000) '$.note', expires nvarchar(40) '$.expires')`;
    const updated = await sql<{ n: number }>`
      UPDATE n SET channels = j.channels, reason = j.reason, source = j.source, note = j.note,
        expires_at = TRY_CAST(j.expires AS datetimeoffset(3)), created_by = ${by}, created_at = SYSDATETIMEOFFSET()
      FROM no_contact n
      JOIN OPENJSON(${json}) ${shape} j ON j.kind = n.kind AND j.value = n.value
      WHERE n.tenant_id = ${tenantId} AND n.lifted_at IS NULL;
      SELECT @@ROWCOUNT AS n;`.execute(tx);
    const added = await sql<{ n: number }>`
      INSERT INTO no_contact (id, tenant_id, kind, value, channels, reason, source, note, expires_at, created_by)
      SELECT j.id, ${tenantId}, j.kind, j.value, j.channels, j.reason, j.source, j.note,
        TRY_CAST(j.expires AS datetimeoffset(3)), ${by}
      FROM OPENJSON(${json}) ${shape} j
      WHERE NOT EXISTS (SELECT 1 FROM no_contact n WHERE n.tenant_id = ${tenantId}
        AND n.kind = j.kind AND n.value = j.value AND n.lifted_at IS NULL);
      SELECT @@ROWCOUNT AS n;`.execute(tx);
    return { added: added.rows[0]?.n ?? 0, updated: updated.rows[0]?.n ?? 0 };
  }

  async lift(tx: MssqlTx, tenantId: string, id: string, by: string): Promise<boolean> {
    const res = await sql<{ id: string }>`
      UPDATE no_contact SET lifted_at = SYSDATETIMEOFFSET(), lifted_by = ${by}
      OUTPUT inserted.id
      WHERE id = ${id} AND tenant_id = ${tenantId} AND lifted_at IS NULL`.execute(tx);
    return res.rows.length > 0;
  }

  async list(
    tx: MssqlTx,
    tenantId: string,
    f: { q?: string; status: 'active' | 'lifted' | 'all'; limit: number; offset: number },
  ): Promise<{ rows: NoContactRow[]; total: number }> {
    const where = sql`n.tenant_id = ${tenantId}
      ${f.q ? sql`AND n.value LIKE ${'%' + f.q.replace(/[%_[]/g, (c) => `[${c}]`) + '%'}` : sql``}
      ${f.status === 'active' ? sql`AND ${ACTIVE}` : f.status === 'lifted' ? sql`AND (n.lifted_at IS NOT NULL OR n.expires_at <= SYSDATETIMEOFFSET())` : sql``}`;
    const total = await sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM no_contact n WHERE ${where}`.execute(tx);
    const res = await sql<RawNoContact>`
      SELECT n.* FROM no_contact n WHERE ${where}
      ORDER BY n.created_at DESC, n.id OFFSET ${f.offset} ROWS FETCH NEXT ${f.limit} ROWS ONLY`.execute(
      tx,
    );
    return { rows: res.rows.map(toRow), total: total.rows[0]?.n ?? 0 };
  }

  /** Every entry for one value, newest first (lifted ones too). */
  async entriesOf(tx: MssqlTx, tenantId: string, value: string): Promise<NoContactRow[]> {
    const res = await sql<RawNoContact>`
      SELECT n.* FROM no_contact n WHERE n.tenant_id = ${tenantId} AND n.value = ${value}
      ORDER BY n.created_at DESC`.execute(tx);
    return res.rows.map(toRow);
  }

  async addParticipations(
    tx: MssqlTx,
    tenantId: string,
    rows: ParticipationInput[],
  ): Promise<void> {
    if (!rows.length) return;
    await sql`
      INSERT INTO participations (id, tenant_id, kind, value, channel, occurred_at, result, project_name, source, case_id)
      SELECT NEWID(), ${tenantId}, j.kind, j.value, j.channel, TRY_CAST(j.at AS datetimeoffset(3)),
        j.result, j.project, j.source, j.caseId
      FROM OPENJSON(${JSON.stringify(
        rows.map((r) => ({
          kind: r.kind,
          value: r.value,
          channel: r.channel,
          at: r.occurredAt.toISOString(),
          result: r.result ?? null,
          project: r.projectName ?? null,
          source: r.source,
          caseId: r.caseId ?? null,
        })),
      )}) WITH (kind nvarchar(16) '$.kind', value nvarchar(450) '$.value', channel nvarchar(16) '$.channel',
        at nvarchar(40) '$.at', result nvarchar(64) '$.result', project nvarchar(450) '$.project',
        source nvarchar(16) '$.source', caseId uniqueidentifier '$.caseId') j`.execute(tx);
  }

  /** Values among these with a participation since `since` in one of `channels`. */
  async recent(
    tx: MssqlTx,
    tenantId: string,
    items: { kind: ContactKind; value: string }[],
    since: Date,
    channels: string[],
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (!items.length || !channels.length) return out;
    const res = await sql<{ kind: ContactKind; value: string }>`
      SELECT DISTINCT p.kind, p.value FROM participations p
      JOIN OPENJSON(${JSON.stringify(items)}) WITH (kind nvarchar(16) '$.kind', value nvarchar(450) '$.value') j
        ON j.kind = p.kind AND j.value = p.value
      WHERE p.tenant_id = ${tenantId} AND p.occurred_at >= ${since.toISOString()}
        AND p.channel IN (SELECT value FROM OPENJSON(${JSON.stringify(channels)}))`.execute(tx);
    for (const r of res.rows) out.add(`${r.kind}\u0000${r.value}`);
    return out;
  }

  async participationsOf(
    tx: MssqlTx,
    tenantId: string,
    value: string,
  ): Promise<ParticipationRow[]> {
    const res = await sql<{
      kind: ContactKind;
      value: string;
      channel: string;
      occurred_at: Date;
      result: string | null;
      project_name: string | null;
      source: string;
    }>`SELECT TOP (200) kind, value, channel, occurred_at, result, project_name, source
       FROM participations WHERE tenant_id = ${tenantId} AND value = ${value}
       ORDER BY occurred_at DESC`.execute(tx);
    return res.rows.map((r) => ({
      kind: r.kind,
      value: r.value,
      channel: r.channel,
      occurredAt: new Date(r.occurred_at),
      result: r.result,
      projectName: r.project_name,
      source: r.source,
    }));
  }

  /** The phones and e-mails of a case, and the project's name. */
  async contactsOfCase(
    tx: MssqlTx,
    caseId: string,
  ): Promise<{ kind: ContactKind; value: string; projectName: string }[]> {
    const res = await sql<{ kind: ContactKind; value: string; name: string }>`
      SELECT ct.type AS kind, ct.value, p.name FROM contacts ct
      JOIN cases c ON c.id = ct.case_id
      JOIN projects p ON p.id = c.project_id
      WHERE ct.case_id = ${caseId} AND ct.type IN ('phone', 'email')`.execute(tx);
    return res.rows.map((r) => ({ kind: r.kind, value: r.value, projectName: r.name }));
  }
}
