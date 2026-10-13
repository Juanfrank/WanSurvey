import { BadRequestException, Injectable } from '@nestjs/common';
import { crosstab, crosstabVariables, filterRows, topline } from '@wansurvey/exporters';
import { projectSettings } from '@wansurvey/schema';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/database.js';
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

/** Toplines, crosstabs and the printable summary (S1–S3). */
@Injectable()
export class AnalysisService {
  constructor(private readonly datasets: DatasetService) {}

  private async table(tx: Tx, projectId: string, q: AnalysisQuery) {
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

  async topline(tx: Tx, projectId: string, q: AnalysisQuery) {
    const { data, table } = await this.table(tx, projectId, q);
    return {
      questionnaire: { id: data.questionnaireId, name: data.name },
      languages: data.compiled.questionnaire.languages,
      n: table.rows.length,
      items: topline(table),
      variables: crosstabVariables(table),
    };
  }

  async crosstab(tx: Tx, projectId: string, q: z.infer<typeof CrosstabQuery>) {
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

  async summary(tx: Tx, projectId: string, q: AnalysisQuery) {
    const { data, table } = await this.table(tx, projectId, q);
    const [p] = await tx.execute<{ name: string; code: string; settings: unknown }>(
      sql`select name, code, settings from projects where id = ${projectId}`,
    );
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
