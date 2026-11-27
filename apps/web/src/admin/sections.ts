/** The blocks the administration menu is split into, in order. */
export const ADMIN_GROUPS = ['people', 'organisation', 'security'] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

/**
 * The administration pages, each open to whoever holds one of its permissions. `menu` narrows who
 * sees it listed: people who may only look at the team or the registry (project managers and
 * supervisors) work with them from their projects, so the menu does not lead them here.
 */
export const ADMIN_SECTIONS: readonly {
  to: string;
  key: string;
  group: AdminGroup;
  permission: readonly string[];
  menu?: readonly string[];
}[] = [
  {
    to: '/admin/users',
    key: 'users',
    group: 'people',
    permission: ['users.read'],
    menu: ['users.manage', 'tenant.manage'],
  },
  {
    to: '/admin/teams',
    key: 'teams',
    group: 'people',
    permission: ['users.read'],
    menu: ['users.manage', 'tenant.manage'],
  },
  { to: '/admin/roles', key: 'roles', group: 'people', permission: ['tenant.manage'] },
  {
    to: '/admin/organisation',
    key: 'organisation',
    group: 'organisation',
    permission: ['tenant.manage'],
  },
  {
    to: '/admin/registry',
    key: 'peopleRegistry',
    group: 'organisation',
    permission: ['registry.read'],
    menu: ['registry.manage', 'users.manage', 'tenant.manage'],
  },
  { to: '/admin/audit', key: 'audit', group: 'security', permission: ['audit.read'] },
  // Who reads the activity log also sees the keys, read only.
  {
    to: '/admin/api-keys',
    key: 'apiKeys',
    group: 'security',
    permission: ['apikeys.manage', 'audit.read'],
  },
  { to: '/admin/webhooks', key: 'webhooks', group: 'security', permission: ['apikeys.manage'] },
];

const holds = (permissions: readonly string[], any: readonly string[]) =>
  any.some((p) => permissions.includes(p));

/** The sections a person may open. */
export const adminSectionsFor = (permissions: readonly string[] = []) =>
  ADMIN_SECTIONS.filter((s) => holds(permissions, s.permission));

/** The sections listed in the menu: those a person may open and acts on, not only looks at. */
export const adminMenuFor = (permissions: readonly string[] = []) =>
  adminSectionsFor(permissions).filter((s) => !s.menu || holds(permissions, s.menu));

/** The menu's sections by block, leaving out empty blocks. */
export const adminMenuGroups = (permissions: readonly string[] = []) =>
  ADMIN_GROUPS.map((group) => ({
    group,
    sections: adminMenuFor(permissions).filter((s) => s.group === group),
  })).filter((g) => g.sections.length);
