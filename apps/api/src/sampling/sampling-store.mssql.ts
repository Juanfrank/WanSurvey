import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';

/**
 * The sampling plan, the frame of units, the cases made from the units that were selected, and
 * interviewer goals on SQL Server (Kysely): what `sampling.service.ts` does on PostgreSQL with
 * Drizzle, as a store for the switch (docs/roadmap.md). Takes the transaction of
 * `MssqlDatabase.withTenant`. Bulk writes send one JSON parameter opened with OPENJSON, as in
 * `CasesStore`.
 */
const NO_QUESTIONNAIRE = '00000000-0000-0000-0000-000000000000';
const json = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));
const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

export type PlanRow = Selectable<MssqlSchema['sampling_plans']>;

export interface PlanInput {
  source?: unknown;
  design?: unknown;
  size?: unknown;
  eligibility?: string | null;
  exclusions?: string | null;
  quotas?: unknown;
  substitution?: unknown;
  crossChecks?: unknown;
  seed: string;
}

export interface NewUnit {
  externalId: string;
  sourceLabel?: string | null;
  sample?: Record<string, unknown>;
  samplePii?: string | null;
  contacts?: { type: string; value: string; label?: string | null }[];
  importId?: string | null;
  eligible?: boolean;
  exclusion?: string | null;
}

/** A 1 / probability weight, as the app computes it. */
export interface MadeCase {
  unitId: string;
  role: 'main' | 'reserve' | 'substitute';
  prob: number | null;
  weight: number | null;
  substituteFor?: string | null;
}

export class SamplingStore {
  // Plan (one per questionnaire of the project, or one for the project when it has none)

  async plan(
    tx: MssqlTx,
    projectId: string,
    questionnaireId: string | null,
  ): Promise<PlanRow | undefined> {
    let q = tx.selectFrom('sampling_plans').selectAll().where('project_id', '=', projectId);
    q =
      questionnaireId === null
        ? q.where('questionnaire_id', 'is', null)
        : q.where('questionnaire_id', '=', questionnaireId);
    return q.executeTakeFirst();
  }

  /** Creates the plan or replaces its inputs (a selected plan cannot be edited). */
  async savePlan(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      questionnaireId: string | null;
      input: PlanInput;
      userId: string | null;
    },
  ): Promise<string> {
    const values = {
      source: JSON.stringify(v.input.source ?? {}),
      design: JSON.stringify(v.input.design ?? {}),
      size: JSON.stringify(v.input.size ?? {}),
      eligibility: v.input.eligibility ?? null,
      exclusions: v.input.exclusions ?? null,
      quotas: JSON.stringify(v.input.quotas ?? []),
      substitution: JSON.stringify(v.input.substitution ?? {}),
      cross_checks: JSON.stringify(v.input.crossChecks ?? []),
      seed: v.input.seed,
      updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      updated_by: v.userId,
    };
    const existing = await this.plan(tx, v.projectId, v.questionnaireId);
    if (existing) {
      if (existing.status === 'selected') throw new Error('The sample is already selected');
      await tx.updateTable('sampling_plans').set(values).where('id', '=', existing.id).execute();
      return existing.id.toLowerCase();
    }
    const id = randomUUID();
    await tx
      .insertInto('sampling_plans')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        ...values,
        result: null,
        selected_at: null,
        selected_by: null,
      })
      .execute();
    return id;
  }

  async markSelected(
    tx: MssqlTx,
    planId: string,
    result: unknown,
    userId: string | null,
  ): Promise<void> {
    await tx
      .updateTable('sampling_plans')
      .set({
        status: 'selected',
        result: JSON.stringify(result),
        selected_at: sql<Date>`SYSDATETIMEOFFSET()`,
        selected_by: userId,
      })
      .where('id', '=', planId)
      .execute();
  }

  // Frame

  /**
   * Adds units to the frame, skipping those whose external id is already there (the same
   * questionnaire of the project): ON CONFLICT DO NOTHING of PostgreSQL, as a NOT EXISTS under a
   * range lock so that two loads at once cannot both insert it. Returns how many were added.
   */
  async addUnits(
    tx: MssqlTx,
    v: { tenantId: string; projectId: string; questionnaireId: string | null; units: NewUnit[] },
  ): Promise<number> {
    let added = 0;
    for (const part of chunks(v.units, 2000)) {
      const rows = part.map((u) => ({
        id: randomUUID(),
        ext: u.externalId,
        label: u.sourceLabel ?? null,
        sample: JSON.stringify(u.sample ?? {}),
        pii: u.samplePii ?? null,
        contacts: JSON.stringify(u.contacts ?? []),
        importId: u.importId ?? null,
        eligible: u.eligible === false ? 0 : 1,
        exclusion: u.exclusion ?? null,
      }));
      const res = await sql<{ n: number }>`
        INSERT INTO dbo.frame_units (id, tenant_id, project_id, questionnaire_id, external_id,
          source_label, sample, sample_pii, contacts, import_id, eligible, exclusion)
        SELECT j.id, ${v.tenantId}, ${v.projectId}, ${v.questionnaireId}, j.ext, j.label, j.sample,
          j.pii, j.contacts, j.importId, j.eligible, j.exclusion
        FROM OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, ext nvarchar(450), label nvarchar(450), sample nvarchar(max),
          pii nvarchar(max), contacts nvarchar(max), importId uniqueidentifier, eligible bit,
          exclusion nvarchar(max)
        ) j
        WHERE NOT EXISTS (
          SELECT 1 FROM dbo.frame_units f WITH (UPDLOCK, HOLDLOCK)
          WHERE f.project_id = ${v.projectId}
            AND ISNULL(f.questionnaire_id, CAST(${NO_QUESTIONNAIRE} AS uniqueidentifier)) = ISNULL(CAST(${v.questionnaireId} AS uniqueidentifier), CAST(${NO_QUESTIONNAIRE} AS uniqueidentifier))
            AND f.external_id = j.ext
        );
        SELECT @@ROWCOUNT AS n`.execute(tx);
      added += Number(res.rows[0]?.n ?? 0);
    }
    return added;
  }

  async unitCounts(tx: MssqlTx, projectId: string, questionnaireId: string | null) {
    let q = tx
      .selectFrom('frame_units')
      .select([
        'role',
        sql<number>`COUNT(*)`.as('n'),
        sql<number>`SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END)`.as('eligible'),
      ])
      .where('project_id', '=', projectId);
    q =
      questionnaireId === null
        ? q.where('questionnaire_id', 'is', null)
        : q.where('questionnaire_id', '=', questionnaireId);
    return q.groupBy('role').execute();
  }

  /** Empties the frame before anything is selected, to load a corrected list. */
  async clearFrame(
    tx: MssqlTx,
    projectId: string,
    questionnaireId: string | null,
  ): Promise<number> {
    const plan = await this.plan(tx, projectId, questionnaireId);
    if (plan?.status === 'selected') throw new Error('The sample is already selected');
    let q = tx.deleteFrom('frame_units').where('project_id', '=', projectId);
    q =
      questionnaireId === null
        ? q.where('questionnaire_id', 'is', null)
        : q.where('questionnaire_id', '=', questionnaireId);
    const r = await q.executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /** Records what the selection decided for each unit, in one statement. */
  async recordSelection(
    tx: MssqlTx,
    picks: {
      unitId: string;
      role: 'main' | 'reserve' | null;
      releaseOrder?: number | null;
      prob?: number | null;
      weight?: number | null;
      stratum?: string | null;
      eligible?: boolean;
      exclusion?: string | null;
    }[],
  ): Promise<void> {
    for (const part of chunks(picks, 2000)) {
      if (!part.length) continue;
      const rows = part.map((p) => ({
        id: p.unitId,
        role: p.role,
        releaseOrder: p.releaseOrder ?? null,
        prob: p.prob ?? null,
        weight: p.weight ?? null,
        stratum: p.stratum ?? null,
        eligible: p.eligible === false ? 0 : 1,
        exclusion: p.exclusion ?? null,
      }));
      await sql`
        UPDATE f SET role = j.role, release_order = j.releaseOrder, inclusion_prob = j.prob,
          base_weight = j.weight, stratum = j.stratum, eligible = j.eligible, exclusion = j.exclusion
        FROM dbo.frame_units f
        JOIN OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, role nvarchar(32), releaseOrder int, prob float, weight float,
          stratum nvarchar(450), eligible bit, exclusion nvarchar(max)
        ) j ON j.id = f.id`.execute(tx);
    }
  }

  // Cases from units

  /**
   * Makes cases from frame units with their contacts, role, probability and base weight, all on
   * the server. A unit whose external id already has a case is skipped (as ON CONFLICT DO NOTHING
   * did). The unit's sample and sealed personal fields are copied as they are. Returns the cases
   * made, with the unit each came from.
   */
  async makeCases(
    tx: MssqlTx,
    v: { projectId: string; questionnaireId: string | null; cases: MadeCase[] },
  ): Promise<{ caseId: string; unitId: string }[]> {
    const made: { caseId: string; unitId: string }[] = [];
    for (const part of chunks(v.cases, 1000)) {
      if (!part.length) continue;
      const rows = part.map((c) => ({
        unitId: c.unitId,
        caseId: randomUUID(),
        role: c.role,
        prob: c.prob,
        weight: c.weight,
        substituteFor: c.substituteFor ?? null,
      }));
      const res = await sql<{ id: string; frame_unit_id: string }>`
        DECLARE @out TABLE (id uniqueidentifier, frame_unit_id uniqueidentifier);
        INSERT INTO dbo.cases (id, tenant_id, project_id, questionnaire_id, external_id, sample,
          sample_pii, import_id, frame_unit_id, selection_role, substitute_for, inclusion_prob,
          base_weight)
        OUTPUT inserted.id, inserted.frame_unit_id INTO @out
        SELECT m.caseId, f.tenant_id, f.project_id, f.questionnaire_id, f.external_id, f.sample,
          f.sample_pii, f.import_id, f.id, m.role, m.substituteFor, m.prob, m.weight
        FROM dbo.frame_units f
        JOIN OPENJSON(${JSON.stringify(rows)}) WITH (
          unitId uniqueidentifier, caseId uniqueidentifier, role nvarchar(32),
          substituteFor uniqueidentifier, prob float, weight float
        ) m ON m.unitId = f.id
        WHERE f.project_id = ${v.projectId}
          AND NOT EXISTS (
            SELECT 1 FROM dbo.cases c WITH (UPDLOCK, HOLDLOCK)
            WHERE c.project_id = f.project_id
              AND ISNULL(c.questionnaire_id, CAST(${NO_QUESTIONNAIRE} AS uniqueidentifier)) = ISNULL(f.questionnaire_id, CAST(${NO_QUESTIONNAIRE} AS uniqueidentifier))
              AND c.external_id = f.external_id
          );
        INSERT INTO dbo.contacts (id, tenant_id, case_id, type, value, label)
        SELECT NEWID(), f.tenant_id, o.id, k.type, k.value, k.label
        FROM @out o
        JOIN dbo.frame_units f ON f.id = o.frame_unit_id
        CROSS APPLY OPENJSON(f.contacts) WITH (
          type nvarchar(32), value nvarchar(450), label nvarchar(450)
        ) k;
        UPDATE f SET case_id = o.id
        FROM dbo.frame_units f JOIN @out o ON o.frame_unit_id = f.id;
        SELECT id, frame_unit_id FROM @out;`.execute(tx);
      made.push(
        ...res.rows.map((r) => ({
          caseId: r.id.toLowerCase(),
          unitId: r.frame_unit_id.toLowerCase(),
        })),
      );
    }
    return made;
  }

  /**
   * Releases the next `count` reserve units in their release order, marking them released. READPAST
   * lets simultaneous releases take different units instead of waiting for one another.
   */
  async releaseReserves(
    tx: MssqlTx,
    v: { projectId: string; questionnaireId: string | null; count: number },
  ): Promise<string[]> {
    const res = await sql<{ id: string }>`
      WITH next AS (
        SELECT TOP (${v.count}) * FROM dbo.frame_units WITH (UPDLOCK, READPAST, ROWLOCK, INDEX(frame_units_reserve_idx))
        WHERE project_id = ${v.projectId}
          AND ISNULL(questionnaire_id, CAST(${NO_QUESTIONNAIRE} AS uniqueidentifier)) = ISNULL(CAST(${v.questionnaireId} AS uniqueidentifier), CAST(${NO_QUESTIONNAIRE} AS uniqueidentifier))
          AND role = 'reserve' AND released_at IS NULL
        ORDER BY release_order, id
      )
      UPDATE next SET released_at = SYSDATETIMEOFFSET()
      OUTPUT inserted.id`.execute(tx);
    return res.rows.map((r) => r.id.toLowerCase());
  }

  // Interviewer goals

  async addGoal(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      questionnaireId?: string | null;
      userId?: string | null;
      frequency?: string;
      startsOn: string;
      endsOn: string;
      target: number;
      createdBy: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('interviewer_goals')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId ?? null,
        user_id: v.userId ?? null,
        frequency: v.frequency ?? 'period',
        starts_on: v.startsOn,
        ends_on: v.endsOn,
        target: v.target,
        created_by: v.createdBy,
      })
      .execute();
    return id;
  }

  /** Dates come back as `YYYY-MM-DD` text, not as instants. */
  async goals(tx: MssqlTx, projectId: string) {
    const res = await sql<{
      id: string;
      user_id: string | null;
      questionnaire_id: string | null;
      frequency: string;
      starts_on: string;
      ends_on: string;
      target: number;
    }>`
      SELECT id, user_id, questionnaire_id, frequency,
        CONVERT(varchar(10), starts_on, 23) AS starts_on, CONVERT(varchar(10), ends_on, 23) AS ends_on,
        target
      FROM dbo.interviewer_goals WHERE project_id = ${projectId}
      ORDER BY starts_on, id`.execute(tx);
    return res.rows;
  }

  async deleteGoal(tx: MssqlTx, id: string): Promise<void> {
    await tx.deleteFrom('interviewer_goals').where('id', '=', id).execute();
  }
}

export { json as parseJson };
