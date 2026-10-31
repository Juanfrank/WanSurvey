import { writeXlsx } from 'hucre/xlsx';
import { describe, expect, it } from 'vitest';
import { parseSampleFile, SampleFileError } from '../src/cases/sample-file.js';

const xlsx = async (sheets: { name: string; rows: unknown[][] }[]) =>
  Buffer.from(await writeXlsx({ sheets: sheets as never }));

describe('sample files in Excel', () => {
  it('reads text, numbers, booleans, dates and blanks as text', async () => {
    const buf = await xlsx([
      {
        name: 'Hoja 1',
        rows: [
          ['id', 'texto', 'num', 'fecha', 'bool', 'vacio'],
          ['A1', '  hola  ', 42, new Date(Date.UTC(2026, 9, 31)), true, null],
          ['A2', 'x', 3.5, new Date(Date.UTC(2020, 0, 5, 13, 30)), false, ''],
        ],
      },
      { name: 'Otra', rows: [['k', 'v']] },
    ]);
    const file = await parseSampleFile(buf, 'muestra.xlsx', { maxRows: 100 });
    expect(file.sheets).toEqual(['Hoja 1', 'Otra']);
    expect(file.headers).toEqual(['id', 'texto', 'num', 'fecha', 'bool', 'vacio']);
    expect(file.rows).toEqual([
      ['A1', 'hola', '42', '2026-10-31', 'true', ''],
      ['A2', 'x', '3.5', '2020-01-05', 'false', ''],
    ]);
  });

  it('leaves error cells empty and reads the sheet asked for', async () => {
    const buf = await xlsx([
      { name: 'Primera', rows: [['a']] },
      {
        name: 'Segunda',
        rows: [
          ['id', 'v'],
          ['1', { value: '#N/A', type: 'error' }],
        ],
      },
    ]);
    const file = await parseSampleFile(buf, 'm.xlsx', { sheet: 'Segunda', maxRows: 10 });
    expect(file.rows).toEqual([['1', '']]);
    await expect(parseSampleFile(buf, 'm.xlsx', { sheet: 'No', maxRows: 10 })).rejects.toThrow(
      /No worksheet No/,
    );
  });

  it('refuses a file that is not an .xlsx and one with too many rows', async () => {
    await expect(
      parseSampleFile(Buffer.from('esto no es un libro'), 'm.xlsx', { maxRows: 10 }),
    ).rejects.toBeInstanceOf(SampleFileError);
    const rows = [['id'], ...Array.from({ length: 6 }, (_, i) => [String(i)])];
    const buf = await xlsx([{ name: 'S', rows }]);
    await expect(parseSampleFile(buf, 'm.xlsx', { maxRows: 5 })).rejects.toThrow(/limit is 5/);
  });
});
