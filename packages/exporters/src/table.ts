/** One column of an export: its name, label, storage and value labels. */
export interface Column {
  /** Variable name: letters, digits and `_`, starting with a letter. */
  name: string;
  /** Variable label (question text, or a description for meta columns). */
  label: string;
  type: 'numeric' | 'string';
  /** Codes with their labels, for coded numeric columns. */
  valueLabels?: Map<number, string>;
  /** Codes that mean "no valid answer" (don't know, refused…), declared missing in SPSS. */
  missing?: number[];
  /** nominal, ordinal or scale; SPSS shows it, the rest ignore it. */
  measure?: 'nominal' | 'ordinal' | 'scale';
  /** Columns that together hold one question (the options of a multiple choice). */
  group?: { name: string; label: string };
  /** A variable of the questionnaire (not a meta or paradata column). */
  variable?: boolean;
  /** Free text written by the respondent (an open answer, or "other, specify"). */
  open?: boolean;
  /** Where the cells come from, for exports that rebuild the table elsewhere (SQL). */
  source?: ColumnSource;
}

/**
 * How a column's cells are read. Answers: `read` says how the value of `variable` becomes a
 * cell (its code, its text, a 0/1 per option, a ranked position, a grid row…), `path` the
 * roster row of a wide column (1-based, outermost first).
 */
export type ColumnSource =
  | { kind: 'meta'; field: string }
  | { kind: 'paradata'; field: string }
  | { kind: 'roster_row'; level: number }
  | {
      kind: 'answer';
      variable: string;
      read: 'code' | 'text' | 'dummy' | 'rank' | 'grid' | 'computed' | 'other' | 'coded';
      code?: string;
      position?: number;
      row?: string;
      /** Computed variables: a number, or any other value written as JSON. */
      numeric?: boolean;
      path?: number[];
    };

export type Cell = number | string | null;

/** A rectangular dataset: columns and rows of cells. */
export interface Table {
  name: string;
  columns: Column[];
  rows: Cell[][];
}

/** A growable little-endian byte buffer. */
export class Bytes {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
    return this;
  }
  u16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }
  i32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
    return this;
  }
  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
    return this;
  }
  u64(v: number) {
    this.ensure(8);
    this.view.setBigUint64(this.length, BigInt(v), true);
    this.length += 8;
    return this;
  }
  f64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
    return this;
  }
  /** Raw 8 bytes given as a 64-bit pattern (special doubles). */
  bits64(hex: bigint) {
    this.ensure(8);
    this.view.setBigUint64(this.length, hex, true);
    this.length += 8;
    return this;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  /** Text in exactly `n` bytes: cut at a character boundary, padded with `pad`. */
  fixed(s: string, n: number, pad = 0x20) {
    const b = fitUtf8(s, n);
    this.bytes(b);
    for (let i = b.length; i < n; i++) this.u8(pad);
    return this;
  }
  ascii(s: string) {
    return this.bytes(new TextEncoder().encode(s));
  }
  /** Overwrites 8 bytes at `at` (offsets filled in later). */
  setU64(at: number, v: number) {
    this.view.setBigUint64(at, BigInt(v), true);
  }
  setI32(at: number, v: number) {
    this.view.setInt32(at, v, true);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const encoder = new TextEncoder();

/** UTF-8 bytes of `s`, at most `max` long, never cutting a character in two. */
export function fitUtf8(s: string, max: number): Uint8Array {
  const all = encoder.encode(s);
  if (all.length <= max) return all;
  let end = max;
  while (end > 0 && (all[end]! & 0xc0) === 0x80) end--;
  return all.slice(0, end);
}

export const utf8Length = (s: string) => encoder.encode(s).length;
