import { describe, expect, it } from 'vitest';
import { suggestMapping } from '../src/cases/sample-mapping.js';

const personal = (headers: string[]) =>
  Object.fromEntries(
    suggestMapping(headers).columns.map((c, i) => [
      headers[i],
      c.kind === 'sample' ? c.pii : c.kind,
    ]),
  );

describe('suggested mapping: personal columns', () => {
  it('suggests names, dates of birth, document numbers and postcodes as personal', () => {
    expect(
      personal([
        'first_name',
        'Fecha de nacimiento',
        'DOB',
        'Cédula',
        'documento_identidad',
        'national_id',
        'RUT',
        'zip',
        'codigo_postal',
        'calle',
      ]),
    ).toEqual({
      first_name: true,
      'Fecha de nacimiento': true,
      DOB: true,
      Cédula: true,
      documento_identidad: true,
      national_id: true,
      RUT: true,
      zip: true,
      codigo_postal: true,
      calle: true,
    });
  });

  it('leaves analysis variables and look-alike words alone', () => {
    // Age, city and region drive eligibility, strata and quotas: the person decides.
    expect(personal(['age', 'city', 'region', 'zipped', 'trust_level', 'language'])).toEqual({
      age: false,
      city: false,
      region: false,
      zipped: false,
      trust_level: false,
      language: false,
    });
  });
});
