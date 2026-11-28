import { describe, expect, it } from 'vitest';
import {
  grantReaches,
  roleMatrix,
  ROLE_PERMISSIONS,
  staysWhenClosed,
  withoutClosedProjects,
  type ProjectGrant,
  type Role,
} from '../src/rbac.js';

const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const Q = 'aaaaaaaa-0000-4000-8000-000000000002';

describe('closed projects', () => {
  it('keeps whoever runs the project, administrators and readers; field roles leave', () => {
    const stays = (r: Role) => staysWhenClosed(ROLE_PERMISSIONS[r]);
    const kept: Role[] = ['owner', 'admin', 'project_manager', 'client_viewer'];
    const gone: Role[] = ['supervisor', 'reviewer', 'interviewer'];
    expect(kept.every(stays)).toBe(true);
    expect(gone.some(stays)).toBe(false);
  });

  it('leaves out field grants of closed projects and stops organisation-wide ones there', () => {
    const grants: ProjectGrant[] = [
      { role: 'interviewer', projectId: P },
      { role: 'interviewer', projectId: Q },
      { role: 'supervisor', projectId: null },
      { role: 'client_viewer', projectId: P },
    ];
    const out = withoutClosedProjects(grants, [P.toUpperCase()]);
    expect(out).toEqual([
      { role: 'interviewer', projectId: Q },
      { role: 'supervisor', projectId: null, exceptProjects: [P] },
      { role: 'client_viewer', projectId: P },
    ]);
    expect(grantReaches(out[1]!, P)).toBe(false);
    expect(grantReaches(out[1]!, Q)).toBe(true);
    expect(grantReaches(out[1]!, null)).toBe(true);
    // Nothing closed: the grants as they are.
    expect(withoutClosedProjects(grants, [])).toEqual(grants);
  });

  it('follows an organisation’s own matrix: a customised reader with a field permission leaves', () => {
    const matrix = roleMatrix({ client_viewer: ['projects.read', 'cases.assign'] });
    const g: ProjectGrant = {
      role: 'client_viewer',
      projectId: P,
      permissions: matrix.client_viewer,
    };
    expect(withoutClosedProjects([g], [P])).toEqual([]);
  });
});
