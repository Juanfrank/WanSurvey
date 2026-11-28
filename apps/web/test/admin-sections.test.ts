import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { draftChanges } from '../src/admin/RolesPage.js';
import { adminMenuFor, adminMenuGroups, adminSectionsFor } from '../src/admin/sections.js';

const keys = (list: readonly { key: string }[]) => list.map((s) => s.key);

describe('administration menu', () => {
  it('lists every section in three blocks for the owner', () => {
    expect(adminMenuGroups(ROLE_PERMISSIONS.owner).map((g) => [g.group, keys(g.sections)])).toEqual(
      [
        ['people', ['users', 'teams', 'roles']],
        ['organisation', ['organisation', 'peopleRegistry']],
        ['security', ['audit', 'apiKeys', 'webhooks']],
      ],
    );
  });

  it('shows administrators the API keys and the webhooks, read only', () => {
    expect(keys(adminMenuFor(ROLE_PERMISSIONS.admin))).toContain('apiKeys');
    expect(keys(adminMenuFor(ROLE_PERMISSIONS.admin))).toContain('webhooks');
    // Nobody without the activity log or the keys' permission.
    expect(keys(adminSectionsFor(ROLE_PERMISSIONS.project_manager))).not.toContain('webhooks');
  });

  it('leaves out of the menu what project managers and supervisors only look at', () => {
    expect(keys(adminMenuFor(ROLE_PERMISSIONS.project_manager))).toEqual(['peopleRegistry']);
    expect(adminMenuFor(ROLE_PERMISSIONS.supervisor)).toEqual([]);
    // The pages themselves stay open to them.
    expect(keys(adminSectionsFor(ROLE_PERMISSIONS.supervisor))).toEqual([
      'users',
      'teams',
      'peopleRegistry',
    ]);
  });
});

describe('changes to the roles', () => {
  it('says what each role gains and loses against what is saved', () => {
    const saved = [
      { role: 'owner', permissions: ['a'], defaults: ['a'], editable: false, changed: false },
      { role: 'reviewer', permissions: ['a', 'b'], defaults: ['a'], editable: true, changed: true },
      {
        role: 'client_viewer',
        permissions: ['a'],
        defaults: ['a'],
        editable: true,
        changed: false,
      },
    ];
    expect(draftChanges(saved, { reviewer: ['a', 'c'], client_viewer: ['a'] })).toEqual([
      { role: 'reviewer', given: ['c'], taken: ['b'] },
    ]);
  });
});
