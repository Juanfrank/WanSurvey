import {
  Bytes,
  encodeAll,
  fitUtf8,
  statsOf,
  type Cell,
  type Column,
  type Table,
  type TableEncoder,
  type TableStats,
} from './table.js';

/** The longest string a column holds (longer texts are cut; SPSS's short-string limit). */
export const SAV_MAX_STRING = 255;

const SYSMIS = 0xffefffffffffffffn;
const HIGHEST = 0x7fefffffffffffffn;
const LOWEST = 0xffeffffffffffffen;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Unique 8-character upper-case names, as the SPSS dictionary needs; long names go in record 7.13. */
export function shortNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let base = name.toUpperCase().replace(/[^A-Z0-9_@#$]/g, '_');
    if (!/^[A-Z@]/.test(base)) base = `V${base}`;
    base = base.slice(0, 8);
    let candidate = base;
    for (let n = 1; used.has(candidate); n++) {
      const suffix = String(n);
      candidate = base.slice(0, 8 - suffix.length) + suffix;
    }
    used.add(candidate);
    return candidate;
  });
}

const format = (type: number, width: number, decimals: number) =>
  (type << 16) | (width << 8) | decimals;

/**
 * An SPSS system file (.sav), uncompressed, little-endian, UTF-8: variable labels, value
 * labels, declared missing values (don't know, refused…), long variable names and the
 * measurement level of each column. The header needs the rows' `stats` (case count, text
 * widths, decimals); the cases then stream in batches.
 */
export function savEncoder(
  columns: Column[],
  stats: TableStats,
  opts: { label?: string; name?: string; now?: Date } = {},
): TableEncoder {
  const now = opts.now ?? new Date();
  const cols = columns.map((c, i) => {
    const width = c.type === 'string' ? Math.min(SAV_MAX_STRING, Math.max(1, stats.widths[i]!)) : 0;
    const decimals = c.type === 'numeric' && stats.decimals[i] ? 2 : 0;
    return { ...c, width, decimals, segments: c.type === 'string' ? Math.ceil(width / 8) : 1 };
  });
  const shorts = shortNames(cols.map((c) => c.name));
  const caseSize = cols.reduce((n, c) => n + c.segments, 0);

  const head = () => {
    const b = new Bytes();
    // Header record.
    b.ascii('$FL2');
    b.fixed('@(#) SPSS DATA FILE WanSurvey', 60);
    b.i32(2).i32(caseSize).i32(0).i32(0).i32(stats.rows).f64(100);
    b.fixed(
      `${pad2(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]} ${pad2(now.getUTCFullYear() % 100)}`,
      9,
    );
    b.fixed(
      `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`,
      8,
    );
    b.fixed(opts.label ?? opts.name ?? '', 64);
    b.fixed('', 3);

    // Variable records; dictionary indexes count every 8-byte segment.
    const index: number[] = [];
    let at = 1;
    cols.forEach((c, i) => {
      index.push(at);
      at += c.segments;
      const fmt =
        c.type === 'string' ? format(1, c.width, 0) : format(5, c.decimals ? 12 : 11, c.decimals);
      const missing = c.type === 'numeric' ? (c.missing ?? []).slice(0, 3) : [];
      const label = fitUtf8(c.label, 255);
      b.i32(2)
        .i32(c.type === 'string' ? c.width : 0)
        .i32(label.length ? 1 : 0)
        .i32(missing.length);
      b.i32(fmt).i32(fmt).fixed(shorts[i]!, 8);
      if (label.length) {
        b.i32(label.length).bytes(label);
        for (let p = label.length; p % 4; p++) b.u8(0x20);
      }
      for (const m of missing) b.f64(m);
      for (let s = 1; s < c.segments; s++)
        b.i32(2).i32(-1).i32(0).i32(0).i32(0).i32(0).fixed('', 8);
    });

    // Value labels: one record pair per labelled numeric variable.
    cols.forEach((c, i) => {
      if (c.type !== 'numeric' || !c.valueLabels?.size) return;
      b.i32(3).i32(c.valueLabels.size);
      for (const [value, text] of c.valueLabels) {
        const l = fitUtf8(text, 120);
        b.f64(value).u8(l.length).bytes(l);
        for (let p = 1 + l.length; p % 8; p++) b.u8(0x20);
      }
      b.i32(4).i32(1).i32(index[i]!);
    });

    // Extension records: machine integers (UTF-8), machine floats, display, long names, encoding.
    b.i32(7).i32(3).i32(4).i32(8);
    b.i32(20).i32(0).i32(0).i32(-1).i32(1).i32(1).i32(2).i32(65001);
    b.i32(7).i32(4).i32(8).i32(3).bits64(SYSMIS).bits64(HIGHEST).bits64(LOWEST);
    b.i32(7)
      .i32(11)
      .i32(4)
      .i32(cols.length * 3);
    for (const c of cols) {
      const measure =
        c.measure ?? (c.type === 'string' || c.valueLabels?.size ? 'nominal' : 'scale');
      b.i32(measure === 'nominal' ? 1 : measure === 'ordinal' ? 2 : 3);
      b.i32(Math.min(40, Math.max(8, c.type === 'string' ? c.width : 8)));
      b.i32(c.type === 'string' ? 0 : 1);
    }
    const longNames = new TextEncoder().encode(
      cols.map((c, i) => `${shorts[i]}=${c.name.slice(0, 64)}`).join('\t'),
    );
    b.i32(7).i32(13).i32(1).i32(longNames.length).bytes(longNames);
    const enc = new TextEncoder().encode('UTF-8');
    b.i32(7).i32(20).i32(1).i32(enc.length).bytes(enc);
    b.i32(999).i32(0);
    return b.result();
  };

  // Data, case by case.
  const rows = (batch: Cell[][]) => {
    const b = new Bytes();
    for (const row of batch)
      cols.forEach((c, i) => {
        const v = row[i];
        if (c.type === 'numeric') {
          if (typeof v === 'number' && Number.isFinite(v)) b.f64(v);
          else b.bits64(SYSMIS);
        } else {
          const text = fitUtf8(v === null || v === undefined ? '' : String(v), c.width);
          b.bytes(text);
          for (let p = text.length; p < c.segments * 8; p++) b.u8(0x20);
        }
      });
    return b.result();
  };
  return { head, rows, tail: () => new Uint8Array(0) };
}

export function writeSav(table: Table, opts: { label?: string; now?: Date } = {}): Uint8Array {
  return encodeAll(
    savEncoder(table.columns, statsOf(table), { ...opts, name: table.name }),
    table.rows,
  );
}
