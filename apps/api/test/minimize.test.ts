import { describe, expect, it } from 'vitest';
import { minimizeCase } from '../src/interviews/minimize.js';

const sample = { first_name: 'Rosa', last_name: 'Quispe', address: 'Jr. Sol 1', region: 2 };
const pii = new Set(['first_name', 'last_name', 'address']);

describe('minimizeCase', () => {
  it('keeps what is not personal and the personal fields the questionnaire uses', () => {
    expect(
      minimizeCase(sample, { pii, used: { fields: ['first_name'], all: false }, fieldwork: [] }),
    ).toEqual({ case: { first_name: 'Rosa', region: 2 }, personal: ['first_name'], fieldwork: [] });
  });

  it('adds, apart, what is needed to reach the household', () => {
    expect(
      minimizeCase(sample, {
        pii,
        used: { fields: ['first_name'], all: false },
        fieldwork: ['address'],
      }),
    ).toEqual({
      case: { first_name: 'Rosa', address: 'Jr. Sol 1', region: 2 },
      personal: ['first_name'],
      fieldwork: ['address'],
    });
  });

  it('keeps every field when the questionnaire reads the case as a whole', () => {
    expect(
      minimizeCase(sample, { pii, used: { fields: [], all: true }, fieldwork: [] }).case,
    ).toEqual(sample);
  });

  it('without a questionnaire, nothing personal', () => {
    expect(minimizeCase(sample, { pii, used: null, fieldwork: [] }).case).toEqual({ region: 2 });
  });
});
