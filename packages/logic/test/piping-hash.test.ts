import { describe, expect, it } from 'vitest';
import { sha256, stableStringify, seededRandom } from '../src/hash.js';
import { parseTemplate, renderTemplate, TemplateError } from '../src/piping.js';
import { mapScope } from './helpers.js';

describe('piping', () => {
  const scope = mapScope(
    { Q3_NAME: 'Ana', Q2: 1, Q7: 2, HH_MEMBERS: [{ NAME: 'Luis' }, { NAME: 'Eva' }], EMPTY: null },
    {
      ns: {
        case: { city: 'Quito' },
        interviewer: { firstName: 'Juan' },
        respondent: { firstName: 'Rosa' },
      },
      labels: { Q7: { '2': 'Rented' } },
      rosters: { HH_MEMBERS: ['NAME'] },
      row: { roster: 'HH_MEMBERS', index: 2 },
    },
  );
  const r = (src: string) => renderTemplate(src, scope, { lang: 'en' });

  it('resolves variables and namespaces', () => {
    expect(
      r(
        'Hi {{Q3_NAME}} from {{case.city}}, I am {{interviewer.firstName}}; {{respondent.firstName}}',
      ),
    ).toBe('Hi Ana from Quito, I am Juan; Rosa');
  });
  it('label filter shows the label, not the code', () => {
    expect(r('{{Q7}} / {{Q7 | label}}')).toBe('2 / Rented');
  });
  it('date filter formats in the active language', () => {
    expect(r('{{today | date:"iso"}}')).toBe('2026-10-12');
    expect(renderTemplate('{{today | date:"long"}}', scope, { lang: 'en-US' })).toBe(
      'October 12, 2026',
    );
    expect(renderTemplate('{{today | date:"long"}}', scope, { lang: 'es' })).toBe(
      '12 de octubre de 2026',
    );
  });
  it('roster pipes with i', () => {
    expect(r('{{roster.HH_MEMBERS[i].NAME}} and {{roster.HH_MEMBERS[1].NAME}}')).toBe(
      'Eva and Luis',
    );
  });
  it('conditional text', () => {
    expect(r('{{#if Q2 == 1}}your husband{{else}}your wife{{/if}}')).toBe('your husband');
    expect(r('{{#if Q2 == 2}}your husband{{else}}your wife{{/if}}')).toBe('your wife');
    expect(r('{{#if Q2 == 1}}A{{#if Q7 == 2}}B{{/if}}{{/if}}C')).toBe('ABC');
  });
  it('unresolved pipes render a visible placeholder', () => {
    expect(r('Name: {{EMPTY}}')).toBe('Name: [EMPTY]');
    expect(renderTemplate('Name: {{EMPTY}}', scope, { lang: 'en', placeholder: () => '___' })).toBe(
      'Name: ___',
    );
  });
  it('rejects malformed templates', () => {
    expect(() => parseTemplate('{{Q1')).toThrow(TemplateError);
    expect(() => parseTemplate('{{#if Q1}}x')).toThrow(/\/if/);
    expect(() => parseTemplate('{{else}}')).toThrow(TemplateError);
    expect(() => parseTemplate('{{Q1 | upper}}')).toThrow(/Unknown filter/);
    expect(() => parseTemplate('{{1 +}}')).toThrow(TemplateError);
  });
});

describe('hash', () => {
  it('sha256 matches known vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    expect(sha256('héllo ✓ 😀')).toBe(
      'ed48bf1a238c902172191a3a1f46532d86cc20dc6bea2f3f9a90215097b1e10c',
    );
  });
  it('stableStringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }),
    );
  });
  it('seededRandom is deterministic', () => {
    const a = seededRandom('x');
    const b = seededRandom('x');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
