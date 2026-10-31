import { BadRequestException, Injectable } from '@nestjs/common';
import { crosstab, crosstabVariables, filterRows, topline, type Table } from '@wansurvey/exporters';
import { projectSettings } from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Tx } from '../db/database.js';
import { asAnalysisTx, type AnalysisTx } from './analysis-repo.js';
import { median } from '../metrics/metrics.js';
import { DataFilter, DatasetService, type Dataset } from './dataset.service.js';

/** Filters plus a closed question to keep (`where=SEX:1,2`) and the label language. */
export const AnalysisQuery = DataFilter.extend({
  where: z
    .string()
    .regex(/^[A-Za-z_]\w*:[-\w]+(,[-\w]+)*$/)
    .max(500)
    .optional(),
  lang: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/)
    .optional(),
});
export type AnalysisQuery = z.infer<typeof AnalysisQuery>;

export const CrosstabQuery = AnalysisQuery.extend({
  row: z.string().regex(/^\w+$/).max(100),
  col: z.string().regex(/^\w+$/).max(100),
});

/** Built tables kept per project and query while the project's data stays the same. */
const CACHE_SIZE = 50;

/** Toplines, crosstabs and the printable summary (S1–S3). */
@Injectable()
export class AnalysisService {
  private readonly cache = new Map<string, { data: Dataset; table: Table }>();

  constructor(
    private readonly datasets: DatasetService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The table of a query. Every analysis page, and each viewer of a shared link, would read
   * and rebuild all the interviews; instead the result is kept until the project's interviews
   * or published versions change (a cheap check on indexed columns).
   */
  private async table(tx: Tx | AnalysisTx, projectId: string, q: AnalysisQuery) {
    const stamp = await asAnalysisTx(tx, this.audit).dataStamp(projectId);
    const key = `${projectId}|${stamp}|${JSON.stringify(q)}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const built = await this.build(tx, projectId, q);
    this.cache.set(key, built);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return built;
  }

  private async build(tx: Tx | AnalysisTx, projectId: string, q: AnalysisQuery) {
    const data = await this.datasets.load(tx, projectId, q, { completesOnly: true });
    let table = this.datasets.table(data, q.lang);
    if (q.where) {
      const [name, codes] = q.where.split(':') as [string, string];
      if (!table.columns.some((c) => c.name === name && c.variable))
        throw new BadRequestException({ code: 'UNKNOWN_VARIABLE', message: `No variable ${name}` });
      table = filterRows(
        table,
        name,
        codes.split(',').map((c) => (Number.isFinite(Number(c)) ? Number(c) : c)),
      );
    }
    return { data, table };
  }

  async topline(tx: Tx | AnalysisTx, projectId: string, q: AnalysisQuery) {
    const { data, table } = await this.table(tx, projectId, q);
    return {
      questionnaire: { id: data.questionnaireId, name: data.name },
      languages: data.compiled.questionnaire.languages,
      n: table.rows.length,
      items: topline(table),
      variables: crosstabVariables(table),
    };
  }

  async crosstab(tx: Tx | AnalysisTx, projectId: string, q: z.infer<typeof CrosstabQuery>) {
    const { table } = await this.table(tx, projectId, q);
    const x = crosstab(table, q.row, q.col);
    if (!x)
      throw new BadRequestException({
        code: 'NOT_CROSSTABBABLE',
        message: 'Pick two closed questions',
      });
    return x;
  }

  /** Figures for the top of the summary, from the same interviews as the topline. */
  kpis(data: Dataset) {
    const byMode: Record<string, number> = {};
    for (const i of data.interviews) byMode[i.mode] = (byMode[i.mode] ?? 0) + 1;
    const lengths = data.interviews.map((i) => i.activeMs / 60_000);
    const dates = data.interviews
      .map((i) => (i.submittedAt ? new Date(i.submittedAt).toISOString() : null))
      .filter((d): d is string => !!d)
      .sort();
    return {
      completes: data.interviews.length,
      approved: data.interviews.filter((i) => i.status === 'approved').length,
      byMode,
      medianMinutes: median(lengths),
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
    };
  }

  async summary(tx: Tx | AnalysisTx, projectId: string, q: AnalysisQuery) {
    const { data, table } = await this.table(tx, projectId, q);
    const p = await asAnalysisTx(tx, this.audit).projectBrief(projectId);
    return {
      project: { name: p?.name ?? '', code: p?.code ?? '' },
      questionnaire: { id: data.questionnaireId, name: data.name },
      target: projectSettings(p?.settings).fieldwork.targetCompletes,
      generatedAt: new Date().toISOString(),
      filters: q,
      kpis: { ...this.kpis(data), completes: table.rows.length },
      items: topline(table),
    };
  }
}
