import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_PRESETS } from '../src/admin/audit-actions.js';
import { actionLabel, describeDetails, type DescribeContext } from '../src/admin/audit-details.js';

const ANA = '0b6f3c1e-1111-4a2b-8c3d-000000000001';
const PROJECT = '0b6f3c1e-2222-4a2b-8c3d-000000000002';

let c: DescribeContext;

beforeAll(async () => {
  // The setup has loaded the catalogue; only the language changes.
  await i18next.changeLanguage('es');
  const names = new Map([
    [ANA, 'Ana Pérez'],
    [PROJECT, 'Hogares 2026'],
  ]);
  c = {
    t: (k, o) => i18next.t(k, o ?? {}),
    name: (id) => names.get(id),
    date: (d) => d.toISOString().slice(0, 10),
  };
});

describe('activity log in words', () => {
  it('names every action in English and Spanish', async () => {
    for (const lng of ['en', 'es']) {
      await i18next.changeLanguage(lng);
      const t = (k: string, o?: { defaultValue?: string }) => i18next.t(k, o ?? {});
      const missing = AUDIT_ACTIONS.filter((a) => actionLabel(t, a) === a);
      expect(missing, lng).toEqual([]);
    }
    await i18next.changeLanguage('es');
  });

  it('quick filters only name actions the log records', () => {
    const known = new Set<string>(AUDIT_ACTIONS);
    for (const actions of Object.values(AUDIT_PRESETS))
      for (const a of actions) expect(known.has(a), a).toBe(true);
  });

  it('shows a role change as permissions added and removed', () => {
    const rows = describeDetails(
      'tenant.roles_updated',
      { before: {}, after: { reviewer: ['tenant.read', 'dashboards.read'] } },
      c,
    );
    const reviewer = rows.find((r) => r.label === 'Revisor');
    expect(reviewer?.value).toContain('+ Ver el tablero y los resultados');
    expect(reviewer?.value).toMatch(/− /);
  });

  it('says when a role change changed nothing', () => {
    expect(
      describeDetails('tenant.roles_updated', { before: {}, after: {} }, c).map((r) => r.value),
    ).toEqual(['sin cambios']);
  });

  it('shows changed fields before and after, and names ids', () => {
    const rows = describeDetails(
      'team.updated',
      { before: { name: 'Norte', leaderId: null }, after: { name: 'Sur', leaderId: ANA } },
      c,
    );
    expect(rows).toEqual([
      { label: 'Nombre', value: 'Norte → Sur' },
      { label: 'Responsable', value: '— → Ana Pérez' },
    ]);
  });

  it('describes a correction and a review decision', () => {
    expect(
      describeDetails(
        'interview.corrected',
        {
          variable: 'A2_AGE',
          reason: 'Typo',
          cleared: 0,
          projectId: PROJECT,
          externalId: 'HH0004',
        },
        c,
      ),
    ).toEqual([
      { label: 'Pregunta', value: 'A2_AGE' },
      { label: 'Motivo', value: 'Typo' },
      { label: 'Respuestas borradas', value: '0' },
      { label: 'Proyecto', value: 'Hogares 2026' },
      { label: 'Código del caso', value: 'HH0004' },
    ]);
    expect(describeDetails('interview.approved', { from: 'submitted', to: 'approved' }, c)).toEqual(
      [{ label: 'Estado', value: 'enviada → aprobada' }],
    );
  });

  it('describes a share-out: how many cases, how and to whom', () => {
    const rows = describeDetails(
      'cases.assigned',
      { distributed: true, method: 'even', perPerson: { [ANA]: 12 }, count: 12 },
      c,
    );
    expect(rows).toContainEqual({ label: 'Método', value: 'en partes iguales' });
    expect(rows).toContainEqual({ label: 'Por persona', value: 'Ana Pérez: 12' });
    expect(rows).toContainEqual({ label: 'Casos', value: '12' });
    expect(rows).toContainEqual({ label: 'Reparto', value: 'Sí' });
  });
});
