/** The administration pages, each shown to whoever holds its permission. */
export const ADMIN_SECTIONS = [
  { to: '/admin/users', key: 'users', permission: 'users.read' },
  { to: '/admin/teams', key: 'teams', permission: 'users.read' },
  { to: '/admin/roles', key: 'roles', permission: 'tenant.manage' },
  { to: '/admin/organisation', key: 'organisation', permission: 'tenant.manage' },
  { to: '/admin/audit', key: 'audit', permission: 'audit.read' },
] as const;

export const adminSectionsFor = (permissions: readonly string[] = []) =>
  ADMIN_SECTIONS.filter((s) => permissions.includes(s.permission));
