/** The administration pages, each shown to whoever holds its permission. */
export const ADMIN_SECTIONS = [
  { to: '/admin/users', key: 'users', permission: 'users.read' },
  { to: '/admin/teams', key: 'teams', permission: 'users.read' },
  { to: '/admin/roles', key: 'roles', permission: 'tenant.manage' },
  { to: '/admin/organisation', key: 'organisation', permission: 'tenant.manage' },
  { to: '/admin/registry', key: 'peopleRegistry', permission: 'registry.read' },
  { to: '/admin/audit', key: 'audit', permission: 'audit.read' },
  { to: '/admin/api-keys', key: 'apiKeys', permission: 'apikeys.manage' },
  { to: '/admin/webhooks', key: 'webhooks', permission: 'apikeys.manage' },
] as const;

export const adminSectionsFor = (permissions: readonly string[] = []) =>
  ADMIN_SECTIONS.filter((s) => permissions.includes(s.permission));
