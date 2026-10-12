/** A roster row on the way to an answer: `{ name: 'HH', row: 2 }`. Rows are 1-based. */
export interface Frame {
  name: string;
  row: number;
}

/** Answer keys address a value: `Q5`, `HH[2].AGE`, `HH[2].VISITS[1].DATE`. */
export function formatKey(frames: readonly Frame[], name: string): string {
  return frames.map((f) => `${f.name}[${f.row}].`).join('') + name;
}

export function framesKey(frames: readonly Frame[]): string {
  return frames.map((f) => `${f.name}[${f.row}]`).join('.');
}

const SEGMENT = /^([A-Za-z][A-Za-z0-9_]*)\[(\d+)\]$/;

export function parseKey(key: string): { frames: Frame[]; name: string } | null {
  const parts = key.split('.');
  const name = parts.pop();
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return null;
  const frames: Frame[] = [];
  for (const p of parts) {
    const m = SEGMENT.exec(p);
    if (!m || Number(m[2]) < 1) return null;
    frames.push({ name: m[1]!, row: Number(m[2]) });
  }
  return { frames, name };
}
