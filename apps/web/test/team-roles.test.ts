import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { matchesGrants, redundantRows } from '../src/team/roles.js';

const P = 'p-1';
const Q = 'p-2';

describe('role rows that add nothing', () => {
  it('flags a project row whose permissions a whole-organisation row already gives', () => {
    expect(
      redundantRows(
        [
          { role: 'supervisor', projectId: null },
          { role: 'reviewer', projectId: P },
        ],
        ROLE_PERMISSIONS,
      ),
    ).toEqual([null, 0]);
  });

  it('keeps a row that adds permissions: a supervisor does not conduct interviews', () => {
    expect(
      redundantRows(
        [
          { role: 'supervisor', projectId: null },
          { role: 'interviewer', projectId: P },
        ],
        ROLE_PERMISSIONS,
      ),
    ).toEqual([null, null]);
  });

  it('flags only the later of two identical rows, and never across projects', () => {
    expect(
      redundantRows(
        [
          { role: 'reviewer', projectId: P },
          { role: 'reviewer', projectId: P },
          { role: 'reviewer', projectId: Q },
        ],
        ROLE_PERMISSIONS,
      ),
    ).toEqual([null, 0, null]);
  });

  it('names a row that stays, not one that is itself covered', () => {
    expect(
      redundantRows(
        [
          { role: 'reviewer', projectId: P },
          { role: 'supervisor', projectId: null },
          { role: 'reviewer', projectId: P },
        ],
        ROLE_PERMISSIONS,
      ),
    ).toEqual([1, null, 1]);
  });

  it('flags nothing while the organisation’s permissions are unknown', () => {
    expect(
      redundantRows(
        [
          { role: 'admin', projectId: null },
          { role: 'reviewer', projectId: P },
        ],
        undefined,
      ),
    ).toEqual([null, null]);
  });
});

describe('the role and project filters', () => {
  const grants = [
    { role: 'interviewer', projectId: P },
    { role: 'supervisor', projectId: null },
  ];
  it('matches a role in that project, or for the whole organisation', () => {
    expect(matchesGrants(grants, 'interviewer', P)).toBe(true);
    expect(matchesGrants(grants, 'interviewer', Q)).toBe(false);
    expect(matchesGrants(grants, 'supervisor', Q)).toBe(true);
    expect(matchesGrants(grants, '', Q)).toBe(true);
    expect(matchesGrants(grants, 'reviewer', '')).toBe(false);
    expect(matchesGrants([], '', '')).toBe(true);
    expect(matchesGrants([], 'interviewer', '')).toBe(false);
  });
});
