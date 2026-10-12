/** Deterministic demo sample: households with contacts, for the seed, tests and E2E files. */
export interface SampleRow {
  id: string;
  first_name: string;
  last_name: string;
  region: number;
  city: string;
  age: number;
  phone: string;
  email: string;
  priority: number;
}

const FIRST = ['Rosa', 'Juan', 'Ana', 'Luis', 'María', 'Pedro', 'Lucía', 'Jorge', 'Elena', 'Diego'];
const LAST = ['Quispe', 'Flores', 'Sánchez', 'Rojas', 'Díaz', 'Torres', 'Vargas', 'Castro'];
const CITIES = ['Lima', 'Arequipa', 'Cusco'];

/** `n` households; region cycles 1–3 so a third of them are in region 1. */
export function sampleRows(n = 50): SampleRow[] {
  return Array.from({ length: n }, (_, i) => {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 3) % LAST.length]!;
    return {
      id: `HH${String(i + 1).padStart(4, '0')}`,
      first_name: first,
      last_name: last,
      region: (i % 3) + 1,
      city: CITIES[i % 3]!,
      age: 20 + ((i * 7) % 60),
      phone: `9${String(10000000 + i * 7919).slice(-8)}`,
      email: `${first.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.${i + 1}@example.org`,
      priority: i % 10 === 0 ? 5 : 0,
    };
  });
}

export const SAMPLE_HEADERS = [
  'id',
  'first_name',
  'last_name',
  'region',
  'city',
  'age',
  'phone',
  'email',
  'priority',
] as const;

/**
 * Rows as cells, optionally with problems to find on import: two invalid e-mails (rows 5 and
 * 12) and a repeated id (the last row repeats the first id).
 */
export function sampleTable(n = 50, withErrors = false): string[][] {
  const rows = sampleRows(n).map((r) => SAMPLE_HEADERS.map((h) => String(r[h])));
  if (withErrors) {
    rows[4]![7] = 'not-an-email';
    rows[11]![7] = 'someone@';
    rows.push([...rows[0]!]);
  }
  return [[...SAMPLE_HEADERS], ...rows];
}

/** The table as CSV text (comma separated, quoted where needed). */
export function toCsv(table: string[][]): string {
  const q = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return table.map((r) => r.map(q).join(',')).join('\n') + '\n';
}
