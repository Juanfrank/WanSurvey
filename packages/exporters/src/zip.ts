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

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
