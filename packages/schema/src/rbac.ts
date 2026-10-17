import { z } from 'zod';

export const ROLES = [
  'owner',
  'admin',
  'project_manager',
  'supervisor',
  'reviewer',
  'interviewer',
  'client_viewer',
] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const PERMISSIONS = [
  'tenant.read',
  'tenant.manage',
  'tenant.billing',
  'tenant.delete',
  'users.read',
  'users.manage',
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.delete',
  'questionnaires.read',
  'questionnaires.edit',
  'questionnaires.publish',
  /** Comment on questionnaire items (review rounds); editors can comment too. */
  'questionnaires.comment',
  'cases.read_all',
  'cases.read_assigned',
  'cases.import',
  'cases.assign',
  'cases.edit',
  'interviews.conduct',
  'interviews.read_own',
  'interviews.read_all',
  'interviews.review',
  'interviews.approve',
  'interviews.correct',
  'dataentry.key',
  'metrics.own',
  'metrics.team',
  'dashboards.read',
  'exports.run',
  'email.templates',
  'cawi.waves',
  'audit.read',
  'pii.view',
] as const;
export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

const ALL: readonly Permission[] = PERMISSIONS;

/**
 * Role → permission matrix (spec §7). The server enforces it on every endpoint;
 * clients use the same table only to hide what the server already forbids.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'tenant.billing' && p !== 'tenant.delete'),
  project_manager: [
    'tenant.read',
    'users.read',
    'projects.read',
    'projects.create',
    'projects.update',
    'questionnaires.read',
    'questionnaires.edit',
    'questionnaires.publish',
    'questionnaires.comment',
    'cases.read_all',
    'cases.import',
    'cases.assign',
    'cases.edit',
    'interviews.read_all',
    'metrics.team',
    'dashboards.read',
    'exports.run',
    'cawi.waves',
    'pii.view',
  ],
  supervisor: [
    'tenant.read',
    'users.read',
    'projects.read',
    'questionnaires.read',
    'questionnaires.comment',
    'cases.read_all',
    'cases.assign',
    'interviews.read_all',
    'interviews.review',
    'interviews.approve',
    'interviews.correct',
    'metrics.team',
    'dashboards.read',
    'pii.view',
  ],
  reviewer: [
    'tenant.read',
    'projects.read',
    'questionnaires.read',
    'questionnaires.comment',
    'interviews.read_all',
    'interviews.review',
    'interviews.approve',
  ],
  // Interviewers also key paper forms (there is no separate data-entry role).
  interviewer: [
    'tenant.read',
    'projects.read',
    'questionnaires.read',
    'cases.read_assigned',
    'interviews.conduct',
    'interviews.read_own',
    'dataentry.key',
    'metrics.own',
    'pii.view',
  ],
  client_viewer: [
    'tenant.read',
    'projects.read',
    'dashboards.read',
    // Clients review questionnaires and comment on them.
    'questionnaires.read',
    'questionnaires.comment',
  ],
};

/** Roles that must enrol TOTP before using the app. */
export const ROLES_REQUIRING_2FA: readonly Role[] = ['owner', 'admin'];

export function roleHasPermission(
  role: Role,
  permission: Permission,
  matrix: RoleMatrix = ROLE_PERMISSIONS,
): boolean {
  return matrix[role].includes(permission);
}

/** What each role may do in one organisation. */
export type RoleMatrix = Record<Role, readonly Permission[]>;

/** Roles whose permissions an organisation may change; owners and administrators keep theirs. */
export const CUSTOM_ROLES = [
  'project_manager',
  'supervisor',
  'reviewer',
  'interviewer',
  'client_viewer',
] as const satisfies readonly Role[];
export type CustomRole = (typeof CUSTOM_ROLES)[number];

/** Never given to a customised role: running the organisation stays with its administrators. */
export const RESERVED_PERMISSIONS: readonly Permission[] = [
  'tenant.manage',
  'tenant.billing',
  'tenant.delete',
];

/** An organisation's changes to the default matrix: the full list of each changed role. */
const RolePermissionList = z
  .array(Permission)
  .max(PERMISSIONS.length)
  .refine((ps) => !ps.some((p) => RESERVED_PERMISSIONS.includes(p)), 'Reserved permission');
export const RoleOverrides = z.partialRecord(z.enum(CUSTOM_ROLES), RolePermissionList).default({});
export type RoleOverrides = z.infer<typeof RoleOverrides>;

/** The defaults with an organisation's changes on top (unknown or reserved entries ignored). */
export function roleMatrix(overrides?: unknown): RoleMatrix {
  const changes = (overrides && typeof overrides === 'object' ? overrides : {}) as Record<
    string,
    unknown
  >;
  const matrix = { ...ROLE_PERMISSIONS };
  for (const role of CUSTOM_ROLES) {
    const list = RolePermissionList.safeParse(changes[role]);
    // Every role keeps seeing the organisation it belongs to.
    if (list.success) matrix[role] = [...new Set<Permission>(['tenant.read', ...list.data])];
  }
  return matrix;
}

/** Roles an actor may grant: never above their own rank; only owners create owners. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 90,
  project_manager: 70,
  supervisor: 60,
  reviewer: 50,
  interviewer: 40,
  client_viewer: 10,
};
