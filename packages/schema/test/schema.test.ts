import { describe, expect, it } from 'vitest';
import {
  AnswerValueSchema,
  DEFAULT_SPECIAL_CODES,
  ModeVariant,
  Questionnaire,
  ROLE_PERMISSIONS,
  ROLES,
  roleHasPermission,
} from '../src/index.js';

const minimal = {
  id: 'Q',
  title: { en: 'T' },
  defaultLanguage: 'en',
  languages: ['en'],
  sections: [
    {
      id: 'S',
      title: { en: 'S' },
      items: [
        {
          kind: 'question',
          id: 'A',
          name: 'A',
          type: 'single',
          text: { en: 'A?' },
          options: [{ code: 1, label: { en: 'x' } }],
        },
        {
          kind: 'roster',
          id: 'R',
          name: 'R',
          count: { type: 'fixed', n: 2 },
          items: [
            { kind: 'block', id: 'B', items: [{ kind: 'static', id: 'ST', text: { en: 'hi' } }] },
          ],
        },
      ],
    },
  ],
};

describe('questionnaire schema', () => {
  it('parses a nested questionnaire and applies defaults', () => {
    const q = Questionnaire.parse(minimal);
    expect(q.settings.specialCodes).toEqual(DEFAULT_SPECIAL_CODES);
    expect(q.quotas).toEqual([]);
  });

  it('mode variants cannot change variable name, type or codes', () => {
    expect(ModeVariant.safeParse({ text: { en: 'x' } }).success).toBe(true);
    expect(ModeVariant.safeParse({ name: 'OTHER' }).success).toBe(false);
    expect(ModeVariant.safeParse({ type: 'text' }).success).toBe(false);
    expect(ModeVariant.safeParse({ options: [] }).success).toBe(false);
  });

  it('rejects invalid variable names and unknown fields', () => {
    const bad = structuredClone(minimal) as typeof minimal;
    (bad.sections[0]!.items[0] as { name: string }).name = '1bad';
    expect(Questionnaire.safeParse(bad).success).toBe(false);
    const extra = structuredClone(minimal) as typeof minimal;
    (extra.sections[0]!.items[0] as Record<string, unknown>).eval = 'x';
    expect(Questionnaire.safeParse(extra).success).toBe(false);
  });

  it('answer values cover every question type', () => {
    for (const v of [null, 1, 'a', true, { $special: 'DK' }, [1, 2], { a: 1 }, [{ AGE: 3 }]]) {
      expect(AnswerValueSchema.safeParse(v).success).toBe(true);
    }
  });
});

describe('rbac matrix', () => {
  it('owner has everything; admin lacks billing', () => {
    expect(roleHasPermission('owner', 'tenant.billing')).toBe(true);
    expect(roleHasPermission('admin', 'tenant.billing')).toBe(false);
    expect(roleHasPermission('admin', 'users.manage')).toBe(true);
  });
  it('matches the spec table', () => {
    expect(roleHasPermission('project_manager', 'users.manage')).toBe(false);
    expect(roleHasPermission('project_manager', 'questionnaires.publish')).toBe(true);
    expect(roleHasPermission('supervisor', 'questionnaires.edit')).toBe(false);
    expect(roleHasPermission('reviewer', 'cases.edit')).toBe(false);
    expect(roleHasPermission('interviewer', 'exports.run')).toBe(false);
    expect(roleHasPermission('interviewer', 'interviews.read_all')).toBe(false);
    expect(roleHasPermission('data_entry', 'dashboards.read')).toBe(false);
    expect(roleHasPermission('client_viewer', 'pii.view')).toBe(false);
    for (const r of ROLES) expect(ROLE_PERMISSIONS[r].length).toBeGreaterThan(0);
  });
});
