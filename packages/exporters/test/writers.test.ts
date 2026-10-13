import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  crc32,
  shortNames,
  stataNames,
  writeCsv,
  writeDta,
  writeSav,
  writeZip,
  type Table,
} from '../src/index.js';

const table: Table = {
  name: 'PRUEBA',
  columns: [
    { name: 'interview_id', label: 'Id', type: 'string' },
    {
      name: 'SEXO_DEL_ENCUESTADO',
      label: 'Sexo del encuestado',
      type: 'numeric',
      valueLabels: new Map([
        [1, 'Hombre'],
        [2, 'Mujer'],
        [-8, 'No sabe'],
        [-9, 'No responde'],
      ]),
      missing: [-8, -9],
      measure: 'nominal',
    },
    { name: 'EDAD', label: '¿Cuántos años tiene?', type: 'numeric', measure: 'scale' },
    { name: 'INGRESO', label: 'Ingreso mensual', type: 'numeric', measure: 'scale' },
    { name: 'NOMBRE', label: 'Nombre', type: 'string' },
  ],
  rows: [
    ['a1', 1, 34, 1500.5, 'José Peña'],
    ['a2', 2, null, 980, 'Ana María Quispe Huamán de la Cruz'],
    ['a3', -8, 51, null, null],
  ],
};

const py = (() => {
  try {
    execFileSync('python3', ['-c', 'import pyreadstat, pandas'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
/** CI installs pyreadstat and sets this, so the round trip never silently skips there. */
const required = process.env.REQUIRE_PYREADSTAT === '1';

function readBack(bytes: Uint8Array, ext: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-export-'));
  const file = join(dir, `data.${ext}`);
  writeFileSync(file, bytes);
  return JSON.parse(
    execFileSync('python3', [join(import.meta.dirname, 'read.py'), file], { encoding: 'utf8' }),
  ) as {
    columns: string[];
    rows: unknown[][];
    labels: Record<string, string>;
    value_labels: Record<string, Record<string, string>>;
    missing?: Record<string, number[]>;
    measure?: Record<string, string>;
  };
}

describe('export writers', () => {
  it('makes unique short names for SPSS and valid names for Stata', () => {
    expect(shortNames(['HOUSEHOLD_SIZE', 'HOUSEHOLD_INCOME', '1st', 'a.b'])).toEqual([
      'HOUSEHOL',
      'HOUSEHO1',
      'V1ST',
      'A_B',
    ]);
    expect(stataNames(['in', 'x'.repeat(40), 'x'.repeat(40), 'año'])).toEqual([
      'in_',
      'x'.repeat(32),
      `${'x'.repeat(30)}_1`,
      'a_o',
    ]);
  });

  it('writes CSV in UTF-8 with a BOM, codes or labels', () => {
    const csv = writeCsv(table);
    expect(csv.startsWith('﻿interview_id,SEXO_DEL_ENCUESTADO')).toBe(true);
    expect(csv).toContain('a1,1,34,1500.5,José Peña');
    expect(writeCsv(table, { labels: true })).toContain('a2,Mujer,,980');
  });

  it('writes a valid ZIP (stored files, CRC-32)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const zip = writeZip([{ name: 'a.csv', data: new TextEncoder().encode('x') }]);
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    if (py) {
      const dir = mkdtempSync(join(tmpdir(), 'ws-zip-'));
      writeFileSync(join(dir, 'a.zip'), zip);
      const names = execFileSync(
        'python3',
        [
          '-c',
          `import zipfile;z=zipfile.ZipFile('${join(dir, 'a.zip')}');print(z.namelist(),z.read('a.csv').decode())`,
        ],
        { encoding: 'utf8' },
      );
      expect(names.trim()).toBe("['a.csv'] x");
    }
  });

  it.skipIf(!py && !required)(
    'SPSS .sav reads back with labels, value labels and missing values',
    () => {
      const out = readBack(writeSav(table, { now: new Date('2026-10-13T08:00:00Z') }), 'sav');
      expect(out.columns).toEqual([
        'interview_id',
        'SEXO_DEL_ENCUESTADO',
        'EDAD',
        'INGRESO',
        'NOMBRE',
      ]);
      expect(out.rows).toEqual([
        ['a1', 1, 34, 1500.5, 'José Peña'],
        ['a2', 2, null, 980, 'Ana María Quispe Huamán de la Cruz'],
        ['a3', -8, 51, null, ''],
      ]);
      expect(out.labels.EDAD).toBe('¿Cuántos años tiene?');
      expect(out.value_labels.SEXO_DEL_ENCUESTADO).toEqual({
        '1': 'Hombre',
        '2': 'Mujer',
        '-8': 'No sabe',
        '-9': 'No responde',
      });
      expect(out.missing?.SEXO_DEL_ENCUESTADO).toEqual([-8, -9]);
      expect(out.measure?.EDAD).toBe('scale');
    },
  );

  it.skipIf(!py && !required)('Stata .dta reads back with labels and value labels', () => {
    const out = readBack(writeDta(table, { now: new Date('2026-10-13T08:00:00Z') }), 'dta');
    expect(out.columns).toEqual([
      'interview_id',
      'SEXO_DEL_ENCUESTADO',
      'EDAD',
      'INGRESO',
      'NOMBRE',
    ]);
    expect(out.rows).toEqual([
      ['a1', 1, 34, 1500.5, 'José Peña'],
      ['a2', 2, null, 980, 'Ana María Quispe Huamán de la Cruz'],
      ['a3', -8, 51, null, ''],
    ]);
    expect(out.labels.EDAD).toBe('¿Cuántos años tiene?');
    expect(out.value_labels.SEXO_DEL_ENCUESTADO).toEqual({
      '1': 'Hombre',
      '2': 'Mujer',
      '-8': 'No sabe',
      '-9': 'No responde',
    });
  });
});
