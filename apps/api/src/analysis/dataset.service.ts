import { Injectable, NotFoundException } from '@nestjs/common';
import { buildTables, type ExportInterview } from '@wansurvey/exporters';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/database.js';
import { COUNTED } from '../common/statuses.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Which interviews a topline, summary or export reads. */
export const DataFilter = z.object({
  questionnaireId: z.uuid().optional(),
  mode: z.enum(['CATI', 'CAPI', 'CAWI', 'PAPI']).optional(),
  from: Day.optional(),
  to: Day.optional(),
  interviewerId: z.uuid().optional(),
  approvedOnly: z.coerce.boolean().optional(),
});
export type DataFilter = z.infer<typeof DataFilter>;

/** Where the next page starts: after this submission time and id. */
export interface PageKey {
  at: string;
  id: string;
}

/** The questionnaire version a read is against, resolved once. */
export interface DataSource {
  questionnaireId: string;
  versionId: string;
  name: string;
  compiled: CompiledQuestionnaire;
  tz: string;
}

export interface Dataset {
  questionnaireId: string;
  /** The latest version, whose variables and labels the data is read against. */
  versionId: string;
  name: string;
  compiled: CompiledQuestionnaire;
  interviews: ExportInterview[];
}

/**
 * The data of a questionnaire (S1, M6): its submitted interviews in every mode (first
 * keying only; returned and rejected ones left out), read against the latest version so all
 * modes and versions share one set of variables.
 */
@Injectable()
export class DatasetService {
  /** The project's questionnaires that have a published version, newest first. */
  async questionnaires(tx: Tx, projectId: string) {
    return tx.execute<{ id: string; name: string; version: number }>(sql`
      select q.id, q.name, max(v.version)::int as version
      from questionnaires q join questionnaire_versions v on v.questionnaire_id = q.id
      where q.project_id = ${projectId}
      group by q.id, q.name order by max(v.published_at) desc`);
  }

  /** The latest version of the questionnaire asked for (or the newest), with the project's zone. */
  private async version(tx: Tx, projectId: string, f: DataFilter) {
    const qid = f.questionnaireId ?? (await this.questionnaires(tx, projectId))[0]?.id;
    if (!qid) throw new NotFoundException({ code: 'NO_DATA', message: 'Nothing published yet' });
    const [v] = await tx.execute<{
      id: string;
      name: string;
      compiled: CompiledQuestionnaire;
      tz: string;
    }>(sql`
      select v.id, q.name, v.compiled, p.timezone as tz
      from questionnaire_versions v join questionnaires q on q.id = v.questionnaire_id
      join projects p on p.id = q.project_id
      where q.id = ${qid} and q.project_id = ${projectId}
      order by v.version desc limit 1`);
    if (!v) throw new NotFoundException({ code: 'NO_DATA', message: 'Nothing published yet' });
    return { qid, v };
  }

  /** The interviews a filter reads (`i`, joined to its version `v`). */
  private scope(
    projectId: string,
    qid: string,
    tz: string,
    f: DataFilter,
    opts: { completesOnly?: boolean },
  ) {
    const day = sql`(i.submitted_at at time zone ${tz})::date`;
    return sql`i.project_id = ${projectId} and v.questionnaire_id = ${qid} and i.entry_pass = 1
        and i.status in ${f.approvedOnly ? ['approved'] : [...COUNTED]}
        ${opts.completesOnly ? sql`and i.disposition = 'COMPLETE'` : sql``}
        ${f.mode ? sql`and i.mode = ${f.mode}` : sql``}
        ${f.interviewerId ? sql`and i.interviewer_id = ${f.interviewerId}` : sql``}
        ${f.from ? sql`and ${day} >= ${f.from}::date` : sql``}
        ${f.to ? sql`and ${day} <= ${f.to}::date` : sql``}`;
  }

  /** What a paged read needs, fixed once: the version read against and the project's zone. */
  async source(tx: Tx, projectId: string, f: DataFilter): Promise<DataSource> {
    const { qid, v } = await this.version(tx, projectId, f);
    return { questionnaireId: qid, versionId: v.id, name: v.name, compiled: v.compiled, tz: v.tz };
  }

  async load(
    tx: Tx,
    projectId: string,
    f: DataFilter,
    opts: { paradata?: boolean; completesOnly?: boolean } = {},
  ): Promise<Dataset> {
    const { tz, ...src } = await this.source(tx, projectId, f);
    const { interviews } = await this.read(tx, projectId, { ...src, tz }, f, opts, null);
    return { ...src, interviews };
  }

  /**
   * One page of the interviews, in submission order, after `after` (null: the first). Each
   * page is read on its own, so an export of any size never holds a connection or the whole
   * data: ask again with the returned `after` until it is null.
   */
  page(
    tx: Tx,
    projectId: string,
    src: DataSource,
    f: DataFilter,
    opts: { paradata?: boolean },
    after: PageKey | null,
    size: number,
  ) {
    return this.read(tx, projectId, src, f, opts, { after, size });
  }

  private async read(
    tx: Tx,
    projectId: string,
    src: DataSource,
    f: DataFilter,
    opts: { paradata?: boolean; completesOnly?: boolean },
    page: { after: PageKey | null; size: number } | null,
  ): Promise<{ interviews: ExportInterview[]; after: PageKey | null }> {
    // Counted interviews are all submitted. Submission time as text keeps its microseconds, so
    // the next page starts exactly after; (submitted_at, id) is an index range.
    const at = sql`i.submitted_at`;
    const rows = await tx.execute<{
      id: string;
      caseId: string | null;
      caseCode: string | null;
      mode: string;
      status: string;
      disposition: string | null;
      interviewer: string | null;
      startedAt: Date;
      submittedAt: Date | null;
      activeMs: number;
      version: number;
      language: string;
      answers: Record<string, unknown>;
      flags: Record<string, unknown>;
      back: number | null;
      notes: number | null;
      pauses: number | null;
      warnings: number | null;
      role: string | null;
      stratum: string | null;
      prob: number | null;
      weight: number | null;
      pageAt: string;
    }>(sql`
      select i.id, i.case_id as "caseId", c.external_id as "caseCode", i.mode, i.status, i.disposition, u.name as interviewer,
             c.selection_role as role, fu.stratum, c.inclusion_prob as prob, c.base_weight as weight,
             i.started_at as "startedAt", i.submitted_at as "submittedAt", i.active_ms as "activeMs",
             v.version, i.language, i.answers, i.flags, ${at}::text as "pageAt"
             ${
               opts.paradata
                 ? sql`, pd.back, pd.notes, pd.pauses, pd.warnings`
                 : sql`, null as back, null as notes, null as pauses, null as warnings`
             }
      from interviews i
      join questionnaire_versions v on v.id = i.questionnaire_version_id
      left join users u on u.id = i.interviewer_id
      left join cases c on c.id = i.case_id
      left join frame_units fu on fu.id = c.frame_unit_id
      ${
        opts.paradata
          ? sql`left join lateral (
              select count(*) filter (where type = 'navigate_back')::int as back,
                     count(*) filter (where type = 'note_added')::int as notes,
                     count(*) filter (where type = 'pause')::int as pauses,
                     count(*) filter (where type = 'warning_confirmed')::int as warnings
              from interview_paradata pd where pd.interview_id = i.id) pd on true`
          : sql``
      }
      where ${this.scope(projectId, src.questionnaireId, src.tz, f, opts)}
        and i.submitted_at is not null
        ${page?.after ? sql`and (${at}, i.id) > (${page.after.at}::timestamptz, ${page.after.id}::uuid)` : sql``}
      order by ${at}, i.id
      ${page ? sql`limit ${page.size}` : sql``}`);
    const last = rows.at(-1);
    return {
      after: page && last && rows.length === page.size ? { at: last.pageAt, id: last.id } : null,
      interviews: rows.map(({ role, stratum, prob, weight, pageAt: _at, ...r }) => ({
        ...r,
        sampling: { role, stratum, prob, weight },
        paradata: opts.paradata
          ? {
              backMoves: r.back ?? 0,
              notes: r.notes ?? 0,
              pauses: r.pauses ?? 0,
              warnings: r.warnings ?? 0,
            }
          : undefined,
      })),
    };
  }

  /** The main table, rosters and personal answers left out (they are exported, not tabulated). */
  table(d: Dataset, language?: string) {
    return buildTables(d.compiled, d.interviews, {
      rosters: 'long',
      paradata: false,
      personal: false,
      ...(language ? { language } : {}),
    }).main;
  }
}
