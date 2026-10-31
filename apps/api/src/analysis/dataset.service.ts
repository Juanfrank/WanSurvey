import { Injectable, NotFoundException } from '@nestjs/common';
import { buildTables, type ExportInterview } from '@wansurvey/exporters';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { z } from 'zod';
import { type AnalysisTx } from './analysis-repo.js';

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
  async questionnaires(tx: AnalysisTx, projectId: string) {
    return tx.questionnairesWithVersions(projectId);
  }

  /** The latest version of the questionnaire asked for (or the newest), with the project's zone. */
  private async version(tx: AnalysisTx, projectId: string, f: DataFilter) {
    const t = tx;
    const qid = f.questionnaireId ?? (await t.questionnairesWithVersions(projectId))[0]?.id;
    if (!qid) throw new NotFoundException({ code: 'NO_DATA', message: 'Nothing published yet' });
    const v = await t.latestVersion(projectId, qid);
    if (!v) throw new NotFoundException({ code: 'NO_DATA', message: 'Nothing published yet' });
    return { qid, v };
  }

  /** What a paged read needs, fixed once: the version read against and the project's zone. */
  async source(tx: AnalysisTx, projectId: string, f: DataFilter): Promise<DataSource> {
    const { qid, v } = await this.version(tx, projectId, f);
    return { questionnaireId: qid, versionId: v.id, name: v.name, compiled: v.compiled, tz: v.tz };
  }

  async load(
    tx: AnalysisTx,
    projectId: string,
    f: DataFilter,
    opts: { paradata?: boolean; completesOnly?: boolean } = {},
  ): Promise<Dataset> {
    const { tz, ...src } = await this.source(tx, projectId, f);
    const { interviews } = await tx.readInterviews(projectId, { ...src, tz }, f, opts, null);
    return { ...src, interviews };
  }

  /**
   * One page of the interviews, in submission order, after `after` (null: the first). Each
   * page is read on its own, so an export of any size never holds a connection or the whole
   * data: ask again with the returned `after` until it is null.
   */
  page(
    tx: AnalysisTx,
    projectId: string,
    src: DataSource,
    f: DataFilter,
    opts: { paradata?: boolean },
    after: PageKey | null,
    size: number,
  ) {
    return tx.readInterviews(projectId, src, f, opts, { after, size });
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
