import { Bytes } from './table.js';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 computed piece by piece. */
export class Crc32 {
  private c = 0xffffffff;
  update(data: Uint8Array) {
    let c = this.c;
    for (const b of data) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
    this.c = c;
    return this;
  }
  value() {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

export const crc32 = (data: Uint8Array) => new Crc32().update(data).value();

const dosTime = (at: Date) => ({
  time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
});

/**
 * A ZIP archive written as it goes (files stored, no compression; names in UTF-8): each file's
 * size and CRC are not known before its data, so they follow it in a data descriptor. Every
 * method returns the bytes to append; offsets are counted here. Under 4 GiB (no ZIP64).
 */
export class ZipStream {
  private offset = 0;
  private readonly central = new Bytes();
  private count = 0;
  private current?: { name: Uint8Array; at: number; crc: Crc32; size: number };
  private readonly stamp: { time: number; date: number };

  constructor(at = new Date()) {
    this.stamp = dosTime(at);
  }

  private out(b: Uint8Array) {
    this.offset += b.length;
    if (this.offset > 0xffffffff) throw new Error('A ZIP file cannot pass 4 GiB');
    return b;
  }

  /** Starts a file. */
  open(name: string): Uint8Array {
    if (this.current) throw new Error('close() the previous file first');
    const n = new TextEncoder().encode(name);
    this.current = { name: n, at: this.offset, crc: new Crc32(), size: 0 };
    const b = new Bytes();
    // Bit 3: sizes and CRC in the descriptor after the data; bit 11: UTF-8 names.
    b.u32(0x04034b50).u16(20).u16(0x0808).u16(0).u16(this.stamp.time).u16(this.stamp.date);
    b.u32(0).u32(0).u32(0).u16(n.length).u16(0).bytes(n);
    return this.out(b.result());
  }

  /** The file's next bytes (returned as they are, after counting them). */
  data(chunk: Uint8Array): Uint8Array {
    const f = this.current;
    if (!f) throw new Error('open() a file first');
    f.crc.update(chunk);
    f.size += chunk.length;
    return this.out(chunk);
  }

  /** Ends the file: its data descriptor. */
  close(): Uint8Array {
    const f = this.current;
    if (!f) throw new Error('No file open');
    this.current = undefined;
    const crc = f.crc.value();
    const { time, date } = this.stamp;
    this.central.u32(0x02014b50).u16(20).u16(20).u16(0x0808).u16(0).u16(time).u16(date);
    this.central.u32(crc).u32(f.size).u32(f.size).u16(f.name.length);
    this.central.u16(0).u16(0).u16(0).u16(0).u32(0).u32(f.at).bytes(f.name);
    this.count++;
    return this.out(new Bytes().u32(0x08074b50).u32(crc).u32(f.size).u32(f.size).result());
  }

  /** The central directory: the archive's last bytes. */
  finish(): Uint8Array {
    if (this.current) throw new Error('close() the last file first');
    const dir = this.central.result();
    const b = new Bytes();
    b.bytes(dir);
    b.u32(0x06054b50).u16(0).u16(0).u16(this.count).u16(this.count);
    b.u32(dir.length).u32(this.offset).u16(0);
    return this.out(b.result());
  }
}

/** A ZIP archive with the files stored as they are (no compression); names in UTF-8. */
export function writeZip(files: { name: string; data: Uint8Array }[], at = new Date()): Uint8Array {
  const out = new Bytes();
  const central = new Bytes();
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);
    const offset = out.length;
    out.u32(0x04034b50).u16(20).u16(0x0800).u16(0).u16(time).u16(date);
    out.u32(crc).u32(f.data.length).u32(f.data.length).u16(name.length).u16(0);
    out.bytes(name).bytes(f.data);
    central.u32(0x02014b50).u16(20).u16(20).u16(0x0800).u16(0).u16(time).u16(date);
    central.u32(crc).u32(f.data.length).u32(f.data.length).u16(name.length);
    central.u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).bytes(name);
  }
  const start = out.length;
  const dir = central.result();
  out.bytes(dir);
  out.u32(0x06054b50).u16(0).u16(0).u16(files.length).u16(files.length);
  out.u32(dir.length).u32(start).u16(0);
  return out.result();
}
