import { describe, expect, it } from 'vitest';
import { parseTable, pick } from '../src/admin/registry-csv.js';

describe('registry files', () => {
  it('reads comma, semicolon and tab files, quotes and a byte-order mark', () => {
    expect(parseTable('﻿valor;Motivo\n987 000 111;"no, llamar"\n\n')).toEqual([
      { valor: '987 000 111', motivo: 'no, llamar' },
    ]);
    expect(parseTable('value\treason\na@b.co\tqueja')).toEqual([
      { value: 'a@b.co', reason: 'queja' },
    ]);
    expect(parseTable('value,note\nx,"dice ""no"""')).toEqual([{ value: 'x', note: 'dice "no"' }]);
    expect(parseTable('only a header')).toEqual([]);
  });

  it('picks the first column the file has under any of its names', () => {
    const row = { telefono: '987', motivo: '' };
    expect(pick(row, ['value', 'telefono'])).toBe('987');
    expect(pick(row, ['reason', 'motivo'])).toBeUndefined();
  });
});
