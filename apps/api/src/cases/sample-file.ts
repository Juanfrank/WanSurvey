import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export interface ParsedFile {
  headers: string[];
  rows: string[][];
  /** Worksheet names, for XLSX files. */
  sheets?: string[];
  encoding?: 'utf-8' | 'windows-1252';
  delimiter?: string;
}

export class SampleFileError extends Error {}

const DELIMITERS = [',', ';', '\t', '|'];

/** The delimiter that splits the first line into the most fields (ignoring quoted text). */
export function sniffDelimiter(text: string): string {
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? '').replace(/"[^"]*"/g, '');
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (Excel's "CSV" on Windows). */
function decode(buf: Buffer): { text: string; encoding: ParsedFile['encoding'] } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
  }
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
  }
  return String(v);
}

const trimRow = (r: string[]) => r.map((c) => c.trim());
const isBlank = (r: string[]) => r.every((c) => c === '');

/**
 * Reads a CSV or XLSX sample file into a header row and string cells. CSV encoding and
 * delimiter are detected; XLSX dates become ISO dates. Fails clearly on unreadable files.
 */
export async function parseSampleFile(
  buf: Buffer,
  fileName: string,
  opts: { sheet?: string; maxRows: number },
): Promise<ParsedFile> {
  const lower = fileName.toLowerCase();
  let table: string[][];
  let extra: Partial<ParsedFile> = {};
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw new SampleFileError('This is not a readable .xlsx file');
    }
    const sheets = wb.worksheets.map((w) => w.name);
    const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
    if (!ws) throw new SampleFileError(`No worksheet ${opts.sheet ?? ''}`.trim());
    table = [];
    const width = ws.columnCount;
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
      table[n - 1] = cells;
    });
    table = Array.from(table, (r) => r ?? []);
    extra = { sheets };
  } else if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    const { text, encoding } = decode(buf);
    const delimiter = lower.endsWith('.tsv') ? '\t' : sniffDelimiter(text);
    try {
      table = parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: false });
    } catch (e) {
      throw new SampleFileError(`The CSV could not be read: ${(e as Error).message}`);
    }
    extra = { encoding, delimiter };
  } else {
    throw new SampleFileError('Upload a .csv or .xlsx file');
  }
  const rows = table.map(trimRow);
  while (rows.length && isBlank(rows[rows.length - 1]!)) rows.pop();
  const headerIndex = rows.findIndex((r) => !isBlank(r));
  if (headerIndex < 0) throw new SampleFileError('The file is empty');
  const headers = rows[headerIndex]!.map((h, i) => h || `Column ${i + 1}`);
  const body = rows.slice(headerIndex + 1);
  if (body.length > opts.maxRows) {
    throw new SampleFileError(`The file has ${body.length} rows; the limit is ${opts.maxRows}`);
  }
  return { headers, rows: body.map((r) => headers.map((_, i) => r[i] ?? '')), ...extra };
}
