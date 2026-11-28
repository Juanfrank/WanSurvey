import { describe, expect, it } from 'vitest';
import { homeParts, homeProjects, type HomeData } from '../src/home/home.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

const data: HomeData = {
  projectIds: [B, A],
  completes: [{ projectId: A, n: 7 }],
  field: [
    { projectId: A, cases: 50, unassigned: 10, callbacksDue: 2 },
    { projectId: B, cases: 5, unassigned: 5, callbacksDue: 0 },
  ],
  active: [{ projectId: A, n: 3 }],
  lastActivity: [{ projectId: A, at: new Date('2026-11-20T10:30:00Z') }],
  review: [{ projectId: A, toReview: 4, tooFast: 1 }],
  mine: [
    { projectId: A, open: 15, callbacksDue: 1, nextCallbackAt: null, returned: 1 },
    { projectId: B, open: 0, callbacksDue: 0, nextCallbackAt: null, returned: 0 },
  ],
};

describe('home summary', () => {
  it('gives a project manager the fieldwork of every project, not a day of their own', () => {
    const m = [{ role: 'project_manager' as const, projectId: null }];
    expect(homeParts(m)).toEqual({ field: true, review: false, mine: false });
    const rows = homeProjects(m, { ...data, mine: [] });
    expect(rows.map((r) => r.id)).toEqual([A, B]);
    expect(rows[0]).toEqual({
      id: A,
      field: {
        completes: 7,
        cases: 50,
        unassigned: 10,
        callbacksDue: 2,
        activeNow: 3,
        lastActivityAt: '2026-11-20T10:30:00.000Z',
      },
      review: null,
      mine: null,
    });
    expect(rows[1]!.field).toMatchObject({ completes: 0, activeNow: 0, lastActivityAt: null });
  });

  it('gives an interviewer of one project only that project and only their own work', () => {
    const m = [{ role: 'interviewer' as const, projectId: A }];
    expect(homeParts(m)).toEqual({ field: false, review: false, mine: true });
    const rows = homeProjects(m, data);
    expect(rows).toEqual([
      {
        id: A,
        field: null,
        review: null,
        mine: { open: 15, callbacksDue: 1, nextCallbackAt: null, returned: 1 },
      },
    ]);
  });

  it('shows the review queue to supervisors', () => {
    const m = [{ role: 'supervisor' as const, projectId: B }];
    const rows = homeProjects(m, data);
    expect(rows.map((r) => r.id)).toEqual([B]);
    expect(rows[0]!.review).toEqual({ toReview: 0, tooFast: 0 });
    expect(rows[0]!.field).not.toBeNull();
  });

  it('follows customised role permissions', () => {
    const m = [
      { role: 'interviewer' as const, projectId: null, permissions: ['projects.read' as const] },
    ];
    expect(homeParts(m)).toEqual({ field: false, review: false, mine: false });
    expect(homeProjects(m, data).every((r) => !r.field && !r.mine && !r.review)).toBe(true);
  });
});
