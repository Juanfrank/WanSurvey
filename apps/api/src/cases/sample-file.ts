import { parse as parseCsv } from 'csv-parse/sync';
import { readXlsx, type CellValue } from 'hucre/xlsx';

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

function cellText(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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
  let extra: Partial<ParsedFile>;
  if (lower.endsWith('.xlsx')) {
    let wb;
    try {
      wb = await readXlsx(new Uint8Array(buf));
    } catch {
      throw new SampleFileError('This is not a readable .xlsx file');
    }
    const sheets = wb.sheets.map((w) => w.name);
    const ws = opts.sheet ? wb.sheets.find((w) => w.name === opts.sheet) : wb.sheets[0];
    if (!ws) throw new SampleFileError(`No worksheet ${opts.sheet ?? ''}`.trim());
    // Formula results and rich text arrive as their text; a cell holding an error stays empty.
    table = ws.rows.map((row, r) =>
      row.map((v, c) => (ws.cells?.get(`${r},${c}`)?.type === 'error' ? '' : cellText(v))),
    );
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
