import { Bytes, fitUtf8, utf8Length, type Table } from './table.js';

/** Stata's widest fixed string (longer texts are cut). */
export const DTA_MAX_STRING = 2045;
const DOUBLE = 65526;
/** Stata's system missing value `.` for doubles. */
const MISSING = 0x7fe0000000000000n;
const RESERVED = new Set(
  '_all _b byte _coef _cons double float if in int long _n _N _pi _pred _rc _skip strL using with'.split(
    ' ',
  ),
);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Valid, unique Stata names (32 characters at most). */
export function stataNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let base = name.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(base)) base = `v${base}`;
    if (RESERVED.has(base)) base = `${base}_`;
    base = base.slice(0, 32);
    let candidate = base;
    for (let n = 1; used.has(candidate.toLowerCase()); n++) {
      const suffix = `_${n}`;
      candidate = base.slice(0, 32 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * A Stata dataset in format 118 (Stata 14 and later): little-endian, UTF-8, doubles for
 * numbers, fixed strings, variable labels and value labels. Stata has no declared missing
 * values, so don't know / refused keep their codes and labels.
 */
export function writeDta(table: Table, opts: { label?: string; now?: Date } = {}): Uint8Array {
  const now = opts.now ?? new Date();
  const names = stataNames(table.columns.map((c) => c.name));
  const cols = table.columns.map((c, i) => {
    let width = 0;
    if (c.type === 'string') {
      for (const row of table.rows) {
        const v = row[i];
        if (v !== null && v !== undefined) width = Math.max(width, utf8Length(String(v)));
      }
      width = Math.min(DTA_MAX_STRING, Math.max(1, width));
    }
    const labels =
      c.type === 'numeric' && c.valueLabels
        ? [...c.valueLabels].filter(([v]) => Number.isInteger(v) && Math.abs(v) < 2 ** 31)
        : [];
    return { ...c, width, name: names[i]!, labels };
  });
  const K = cols.length;
  const b = new Bytes();
  const map: number[] = new Array(14).fill(0);

  b.ascii('<stata_dta><header><release>118</release><byteorder>LSF</byteorder>');
  b.ascii('<K>').u16(K).ascii('</K>');
  b.ascii('<N>').u64(table.rows.length).ascii('</N>');
  const label = fitUtf8(opts.label ?? table.name, 80);
  b.ascii('<label>').u16(label.length).bytes(label).ascii('</label>');
  const stamp = `${String(now.getUTCDate()).padStart(2, '0')} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  b.ascii('<timestamp>').u8(stamp.length).ascii(stamp).ascii('</timestamp></header>');

  map[1] = b.length;
  b.ascii('<map>');
  const mapAt = b.length;
  for (let i = 0; i < 14; i++) b.u64(0);
  b.ascii('</map>');

  map[2] = b.length;
  b.ascii('<variable_types>');
  for (const c of cols) b.u16(c.type === 'string' ? c.width : DOUBLE);
  b.ascii('</variable_types>');

  map[3] = b.length;
  b.ascii('<varnames>');
  for (const c of cols) b.fixed(c.name, 129, 0);
  b.ascii('</varnames>');

  map[4] = b.length;
  b.ascii('<sortlist>');
  for (let i = 0; i <= K; i++) b.u16(0);
  b.ascii('</sortlist>');

  map[5] = b.length;
  b.ascii('<formats>');
  for (const c of cols)
    b.fixed(c.type === 'string' ? `%-${Math.min(c.width, 244)}s` : '%10.0g', 57, 0);
  b.ascii('</formats>');

  map[6] = b.length;
  b.ascii('<value_label_names>');
  for (const c of cols) b.fixed(c.labels.length ? c.name : '', 129, 0);
  b.ascii('</value_label_names>');

  map[7] = b.length;
  b.ascii('<variable_labels>');
  for (const c of cols) b.fixed(c.label, 321, 0);
  b.ascii('</variable_labels>');

  map[8] = b.length;
  b.ascii('<characteristics></characteristics>');

  map[9] = b.length;
  b.ascii('<data>');
  for (const row of table.rows)
    cols.forEach((c, i) => {
      const v = row[i];
      if (c.type === 'string') b.fixed(v === null || v === undefined ? '' : String(v), c.width, 0);
      else if (typeof v === 'number' && Number.isFinite(v)) b.f64(v);
      else b.bits64(MISSING);
    });
  b.ascii('</data>');

  map[10] = b.length;
  b.ascii('<strls></strls>');

  map[11] = b.length;
  b.ascii('<value_labels>');
  for (const c of cols) {
    if (!c.labels.length) continue;
    const texts = c.labels.map(([, t]) => fitUtf8(t, 32_000));
    const txtlen = texts.reduce((n, t) => n + t.length + 1, 0);
    b.ascii('<lbl>')
      .i32(8 + 8 * c.labels.length + txtlen)
      .fixed(c.name, 129, 0)
      .fixed('', 3, 0);
    b.i32(c.labels.length).i32(txtlen);
    let off = 0;
    for (const t of texts) {
      b.i32(off);
      off += t.length + 1;
    }
    for (const [v] of c.labels) b.i32(v);
    for (const t of texts) b.bytes(t).u8(0);
    b.ascii('</lbl>');
  }
  b.ascii('</value_labels>');

  map[12] = b.length;
  b.ascii('</stata_dta>');
  map[13] = b.length;
  map.forEach((v, i) => b.setU64(mapAt + i * 8, v));
  return b.result();
}
