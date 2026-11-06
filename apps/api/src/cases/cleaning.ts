import { regexProblem, tryParse, type Node } from '@wansurvey/logic';
import type { CleaningSettings } from '@wansurvey/schema';
import { compileRule, ruleError } from './case-logic.js';
import type { ImportReport, PreparedRow } from './sample-mapping.js';

/**
 * Cleaning a list as it is loaded (before its rows become cases or frame units): text columns
 * tidied, saved exclusion rules applied, and the same person twice in one file found. What is
 * left out is counted by rule in the import report, so the person who loads knows why.
 */

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** A text column tidied: NFC, no invisible characters, spaces collapsed, optionally no symbols. */
export function cleanText(v: string, opts: { spaces: boolean; symbols: boolean }): string {
  let s = v;
  if (opts.spaces) s = s.normalize('NFC').replace(/[\p{Cc}\p{Cf}\u00a0]/gu, ' ');
  if (opts.symbols) s = s.replace(/[^\p{L}\p{N}\s.,'’-]/gu, '');
  return opts.spaces || opts.symbols ? s.replace(/\s+/g, ' ').trim() : s;
}

/** What is wrong with a rule's expression (it must parse, read only the row's data, and its patterns be valid). */
export function ruleProblem(expression: string): string | null {
  const bad = ruleError(expression);
  if (bad) return bad;
  const parsed = tryParse(expression);
  if (!parsed.ok) return parsed.error.message;
  let problem: string | null = null;
  const walk = (n: Node): void => {
    if (n.type === 'call' && n.name === 'matches') {
      const pattern = n.args[1];
      if (pattern?.type === 'str') problem ??= regexProblem(pattern.value);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'span' || !v || typeof v !== 'object') continue;
      if (Array.isArray(v)) v.forEach((x) => walk(x as Node));
      else if ('type' in v) walk(v as Node);
    }
  };
  walk(parsed.node);
  return problem ? `matches(): ${problem}` : null;
}

const keyOf = (r: PreparedRow, fields: string[]): string | null => {
  const parts = fields.map((f) => {
    const v =
      f === 'phone' || f === 'email'
        ? r.contacts.find((c) => c.type === f)?.value
        : (r.sample[f] as unknown);
    return v === undefined || v === null ? '' : fold(String(v)).replace(/\s+/g, ' ').trim();
  });
  return parts.every((p) => p === '') ? null : parts.join('\u0001');
};

/**
 * Applies the project's rules and duplicate check to the rows that are valid, marking those left
 * out (`excluded`) and adding what was done to the report.
 */
export function applyCleaning(
  prepared: PreparedRow[],
  report: ImportReport,
  settings: CleaningSettings,
  maxExamples = 5,
): void {
  const rules = settings.rules
    .filter((r) => r.enabled)
    .map((r) => ({ rule: r, test: compileRule(r.expression) }));
  const perRule = new Map<string, { id: string; name: string; count: number }>();
  const excludedRows: PreparedRow[] = [];
  const left = (r: PreparedRow) => !!r.crossChecked || !!r.excluded;

  if (rules.length)
    for (const r of prepared) {
      if (!r.valid || left(r)) continue;
      const row = {
        sample: r.sample,
        status: 'fresh',
        priority: r.priority ?? 0,
        modePreference: r.modePreference ?? null,
      };
      const hit = rules.find((x) => x.test(row));
      if (!hit) continue;
      r.excluded = { rule: hit.rule.id, name: hit.rule.name };
      excludedRows.push(r);
      const e = perRule.get(hit.rule.id) ?? { id: hit.rule.id, name: hit.rule.name, count: 0 };
      e.count++;
      perRule.set(hit.rule.id, e);
    }

  // The same person twice in the file: by the fields the project chose (accents, case and spaces
  // do not count). The first row is the one that stays.
  const duplicates: { row: PreparedRow; of: number }[] = [];
  if (settings.duplicateFields.length) {
    const first = new Map<string, number>();
    for (const r of prepared) {
      if (!r.valid) continue;
      const key = keyOf(r, settings.duplicateFields);
      if (key === null) continue;
      const seen = first.get(key);
      if (seen === undefined) first.set(key, r.rowNo);
      else {
        duplicates.push({ row: r, of: seen });
        if (settings.duplicateAction === 'exclude' && !left(r))
          r.excluded = { rule: 'duplicate', name: 'duplicate' };
      }
    }
  }

  const gone = prepared.filter((r) => r.valid && r.excluded && !r.exists).length;
  report.toCreate -= gone;
  const dupGone =
    settings.duplicateAction === 'exclude'
      ? duplicates.filter((d) => d.row.excluded?.rule === 'duplicate').length
      : 0;
  if (perRule.size || duplicates.length || rules.length || settings.duplicateFields.length)
    report.cleaning = {
      // Every rule that is on, in the order of the project, with how many it left out (maybe none).
      rules: rules.map(
        ({ rule }) => perRule.get(rule.id) ?? { id: rule.id, name: rule.name, count: 0 },
      ),
      duplicates: { count: duplicates.length, excluded: dupGone, action: settings.duplicateAction },
    };
  if (excludedRows.length)
    report.issues.push({
      code: 'excluded_rule',
      count: excludedRows.length,
      blocking: false,
      examples: excludedRows.slice(0, maxExamples).map((r) => ({
        row: r.rowNo,
        column: r.excluded!.name,
        value: r.externalId,
      })),
    });
  if (duplicates.length)
    report.issues.push({
      code: 'duplicate_key',
      count: duplicates.length,
      blocking: false,
      examples: duplicates.slice(0, maxExamples).map((d) => ({
        row: d.row.rowNo,
        column: `#${d.of}`,
        value: d.row.externalId,
      })),
    });
}
