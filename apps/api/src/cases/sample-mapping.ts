import { MODES } from '@wansurvey/schema';
import { z } from 'zod';

export const FIELD_TYPES = ['text', 'number', 'date', 'code'] as const;
export const CONTACT_TYPES = ['phone', 'email', 'address'] as const;

const FieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

/** What one column of the file becomes. */
export const ColumnTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignore') }),
  z.object({ kind: z.literal('externalId') }),
  z.object({
    kind: z.literal('sample'),
    field: FieldName,
    type: z.enum(FIELD_TYPES).default('text'),
    pii: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('contact'),
    type: z.enum(CONTACT_TYPES),
    label: z.string().max(50).optional(),
  }),
  z.object({ kind: z.literal('priority') }),
  z.object({ kind: z.literal('modePreference') }),
]);
export type ColumnTarget = z.infer<typeof ColumnTarget>;

export const ImportMapping = z.object({
  columns: z.array(ColumnTarget),
  /** Rows whose id already exists in the project: leave them, or update their sample data. */
  existing: z.enum(['skip', 'update']).default('skip'),
  /** Commit the valid rows and leave out invalid ones (otherwise any invalid row blocks). */
  skipInvalid: z.boolean().default(false),
  /** Country calling code used for phone numbers without one, e.g. "51". */
  defaultCountryCode: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional(),
});
export type ImportMapping = z.infer<typeof ImportMapping>;

const norm = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** A sample field name from a header: letters, digits and _, starting with a letter. */
export function fieldNameFor(header: string): string {
  const n = norm(header);
  return (/^[a-z]/.test(n) ? n : `f_${n}`).slice(0, 64) || 'field';
}

const PII_HINT =
  /(name|nombre|apellido|surname|dni|passport|birth|nacimiento|address|direccion|email|correo|phone|telefono|celular|mobile)/;

/** First guess at a mapping from header names; the person reviews it before validating. */
export function suggestMapping(headers: string[], sample: string[][] = []): ImportMapping {
  let idTaken = false;
  const used = new Set<string>();
  const columns = headers.map((h, i): ColumnTarget => {
    const n = norm(h);
    if (!idTaken && /^(id|case_?id|external_?id|respondent_?id|sample_?id|codigo|code)$/.test(n)) {
      idTaken = true;
      return { kind: 'externalId' };
    }
    if (/(e_?mail|correo)/.test(n)) return { kind: 'contact', type: 'email', label: h };
    if (/(phone|tel|telefono|celular|mobile|movil)/.test(n))
      return { kind: 'contact', type: 'phone', label: h };
    if (/^(address|direccion|domicilio)/.test(n))
      return { kind: 'contact', type: 'address', label: h };
    if (/^(priority|prioridad)$/.test(n)) return { kind: 'priority' };
    if (/^(mode|modo|mode_?preference)$/.test(n)) return { kind: 'modePreference' };
    let field = fieldNameFor(h);
    while (used.has(field)) field = `${field}_${i + 1}`;
    used.add(field);
    const values = sample.map((r) => r[i] ?? '').filter(Boolean);
    const type =
      values.length && values.every((v) => /^-?\d+([.,]\d+)?$/.test(v))
        ? 'number'
        : values.length && values.every((v) => parseDate(v) !== null)
          ? 'date'
          : 'text';
    return { kind: 'sample', field, type, pii: PII_HINT.test(n) };
  });
  return { columns, existing: 'skip', skipInvalid: false };
}

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(v: string): string | null {
  const e = v.trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
}

/**
 * Light E.164 normalisation: keeps digits, turns a leading 00 into +, and adds the default
 * country code to national numbers (dropping a trunk 0). 7–15 digits are accepted.
 */
export function normalisePhone(v: string, cc?: string): string | null {
  let s = v.trim().replace(/[\s().\-/]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+?\d+$/.test(s)) return null;
  if (!s.startsWith('+')) {
    if (!cc) return s.length >= 7 && s.length <= 15 ? s : null;
    s = `+${cc}${s.replace(/^0+/, '')}`;
  }
  const digits = s.length - 1;
  return digits >= 7 && digits <= 15 ? s : null;
}

/** ISO date from YYYY-MM-DD or DD/MM/YYYY (also with - or .). */
export function parseDate(v: string): string | null {
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else {
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v.trim());
    if (!r) return null;
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function typed(v: string, type: (typeof FIELD_TYPES)[number]): { ok: boolean; value: unknown } {
  if (v === '') return { ok: true, value: null };
  switch (type) {
    case 'number': {
      const t = v.replace(',', '.');
      return /^-?\d+(\.\d+)?$/.test(t) ? { ok: true, value: Number(t) } : { ok: false, value: v };
    }
    case 'date': {
      const d = parseDate(v);
      return d ? { ok: true, value: d } : { ok: false, value: v };
    }
    case 'code':
      return { ok: true, value: /^-?\d+$/.test(v) ? Number(v) : v };
    default:
      return { ok: true, value: v };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IssueCode =
  | 'missing_id'
  | 'duplicate_id'
  | 'existing_id'
  | 'invalid_email'
  | 'invalid_phone'
  | 'invalid_number'
  | 'invalid_date'
  | 'invalid_priority'
  | 'invalid_mode'
  | 'empty_row'
  /** A phone or e-mail already belongs to a case in another project (informational). */
  | 'duplicate_elsewhere';

/** Issues that make a row unusable; `existing_id` and `empty_row` are informational. */
const BLOCKING = new Set<IssueCode>([
  'missing_id',
  'duplicate_id',
  'invalid_email',
  'invalid_phone',
  'invalid_number',
  'invalid_date',
  'invalid_priority',
  'invalid_mode',
]);

export interface ImportReport {
  total: number;
  valid: number;
  invalid: number;
  empty: number;
  /** Rows whose id already exists (skipped or updated as the mapping says). */
  existing: number;
  /** Rows that will be created / updated on commit. */
  toCreate: number;
  toUpdate: number;
  /** Other projects sharing phones or e-mails with rows of this file: names and row counts. */
  elsewhere?: { projectId: string; name: string; rows: number }[];
  issues: {
    code: IssueCode;
    count: number;
    blocking: boolean;
    examples: { row: number; column: string; value: string }[];
  }[];
}

export interface PreparedRow {
  /** 1-based data row number (the header is row 0). */
  rowNo: number;
  externalId: string;
  sample: Record<string, unknown>;
  contacts: { type: (typeof CONTACT_TYPES)[number]; value: string; label: string | null }[];
  priority?: number;
  modePreference?: string;
  valid: boolean;
  exists: boolean;
}

/**
 * Checks every row against the mapping: ids present and unique, e-mails, phones, numbers,
 * dates, priorities and modes well formed. Returns the report and the cleaned rows.
 */
export function validateRows(
  headers: string[],
  rows: string[][],
  mapping: ImportMapping,
  existingIds: ReadonlySet<string>,
  maxExamples = 5,
): { report: ImportReport; prepared: PreparedRow[] } {
  const issues = new Map<IssueCode, ImportReport['issues'][number]>();
  const issue = (code: IssueCode, row: number, column: string, value: string) => {
    const it = issues.get(code) ?? { code, count: 0, blocking: BLOCKING.has(code), examples: [] };
    it.count++;
    if (it.examples.length < maxExamples) it.examples.push({ row, column, value });
    issues.set(code, it);
  };
  const idCol = mapping.columns.findIndex((c) => c.kind === 'externalId');
  const seen = new Set<string>();
  const prepared: PreparedRow[] = [];
  let empty = 0;

  rows.forEach((cells, i) => {
    const rowNo = i + 1;
    if (cells.every((c) => c === '')) {
      empty++;
      return;
    }
    const before = [...issues.values()].reduce((n, x) => n + (x.blocking ? x.count : 0), 0);
    const externalId = idCol >= 0 ? (cells[idCol] ?? '') : '';
    if (!externalId) issue('missing_id', rowNo, headers[idCol] ?? 'id', '');
    else if (seen.has(externalId)) issue('duplicate_id', rowNo, headers[idCol]!, externalId);
    seen.add(externalId);
    const exists = !!externalId && existingIds.has(externalId);
    if (exists) issue('existing_id', rowNo, headers[idCol]!, externalId);

    const row: PreparedRow = { rowNo, externalId, sample: {}, contacts: [], valid: true, exists };
    mapping.columns.forEach((col, c) => {
      const raw = cells[c] ?? '';
      const header = headers[c] ?? `Column ${c + 1}`;
      switch (col.kind) {
        case 'sample': {
          const t = typed(raw, col.type);
          if (!t.ok)
            issue(col.type === 'date' ? 'invalid_date' : 'invalid_number', rowNo, header, raw);
          if (t.value !== null) row.sample[col.field] = t.value;
          break;
        }
        case 'contact': {
          if (!raw) break;
          const value =
            col.type === 'email'
              ? normaliseEmail(raw)
              : col.type === 'phone'
                ? normalisePhone(raw, mapping.defaultCountryCode)
                : raw;
          if (value === null)
            issue(col.type === 'email' ? 'invalid_email' : 'invalid_phone', rowNo, header, raw);
          else row.contacts.push({ type: col.type, value, label: col.label ?? header });
          break;
        }
        case 'priority':
          if (raw === '') break;
          if (/^-?\d+$/.test(raw)) row.priority = Number(raw);
          else issue('invalid_priority', rowNo, header, raw);
          break;
        case 'modePreference': {
          if (raw === '') break;
          const m = raw.toUpperCase();
          if ((MODES as readonly string[]).includes(m)) row.modePreference = m;
          else issue('invalid_mode', rowNo, header, raw);
          break;
        }
        default:
          break;
      }
    });
    const after = [...issues.values()].reduce((n, x) => n + (x.blocking ? x.count : 0), 0);
    row.valid = after === before;
    prepared.push(row);
  });

  if (empty)
    issues.set('empty_row', { code: 'empty_row', count: empty, blocking: false, examples: [] });
  const valid = prepared.filter((r) => r.valid);
  const existing = valid.filter((r) => r.exists).length;
  return {
    prepared,
    report: {
      total: rows.length,
      valid: valid.length,
      invalid: prepared.length - valid.length,
      empty,
      existing: prepared.filter((r) => r.exists).length,
      toCreate: valid.length - existing,
      toUpdate: mapping.existing === 'update' ? existing : 0,
      issues: [...issues.values()],
    },
  };
}
