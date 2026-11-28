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
  /** Approve a draft for publishing, in projects that ask for it. */
  'questionnaires.approve',
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
  'audit.export',
  /** Create and revoke the keys of the integration API. */
  'apikeys.manage',
  /** Listen to the recordings of interviews (always written to the activity log). */
  'audio.listen',
  'pii.view',
  /** See the people registry: the no-contact list and who took part in what. */
  'registry.read',
  /** Add and lift no-contact entries and load the registry's files. */
  'registry.manage',
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
  admin: ALL.filter(
    (p) =>
      p !== 'tenant.billing' &&
      p !== 'tenant.delete' &&
      p !== 'audit.export' &&
      p !== 'apikeys.manage',
  ),
  project_manager: [
    'tenant.read',
    'users.read',
    'projects.read',
    'projects.create',
    'projects.update',
    'questionnaires.read',
    'questionnaires.edit',
    'questionnaires.publish',
    'questionnaires.approve',
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
    'registry.read',
    'registry.manage',
  ],
  supervisor: [
    'audio.listen',
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
    'registry.read',
  ],
  reviewer: [
    'audio.listen',
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

/**
 * Roles that must enrol TOTP when they sign in with a password even where the requirement for
 * everyone is relaxed (`PASSWORD_2FA_REQUIRED=false`, development and tests only).
 */
export const ROLES_REQUIRING_2FA: readonly Role[] = ['owner', 'admin'];

/**
 * Whether signing in with a password requires two-step verification (TOTP). Every account does
 * (`everyone`, the rule in production): where access is by Microsoft sign-in, the password is
 * the exception and gets a second factor of its own. Only when the server relaxes it (tests,
 * development) does it fall back to owners and administrators. A Microsoft sign-in never needs
 * it here: the directory applies its own MFA.
 */
export function twoStepRequired(roles: readonly string[], everyone: boolean): boolean {
  return everyone || roles.some((r) => ROLES_REQUIRING_2FA.includes(r as Role));
}

/**
 * Permissions that reach personal data or the integrity of what was collected: the roles page
 * marks them and asks before they are given to another role.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  'pii.view',
  'exports.run',
  'interviews.correct',
  'audio.listen',
  'audit.export',
  'registry.read',
  'registry.manage',
];

/**
 * What a role opens to someone of the client organisation: interviews, recordings, cases or
 * personal data. Giving such a role to an external client asks for a reason (activity log).
 */
export const EXTERNAL_SENSITIVE_PERMISSIONS: readonly Permission[] = [
  'interviews.read_all',
  'interviews.read_own',
  'audio.listen',
  'pii.view',
  'cases.read_all',
  'cases.read_assigned',
  'exports.run',
];

/** Of the client organisation: client is all they hold for the whole organisation. */
export function isExternalClient(
  grants: readonly { role: string; projectId: string | null }[],
): boolean {
  const org = grants.filter((g) => g.projectId === null);
  return org.length > 0 && org.every((g) => g.role === 'client_viewer');
}

/**
 * What new roles open to an external client (a person of the client organisation before or
 * after the change): the sensitive permissions, by `matrix`, of each role they did not hold as
 * a client (all of them for someone who becomes one).
 * Empty when they are not external or nothing sensitive is added.
 */
export function externalAccessOpened(
  before: readonly { role: string; projectId: string | null }[],
  after: readonly { role: string; projectId: string | null }[],
  matrix: Partial<Record<string, readonly string[]>>,
): Permission[] {
  const wasExternal = isExternalClient(before);
  if (!wasExternal && !isExternalClient(after)) return [];
  const key = (g: { role: string; projectId: string | null }) =>
    `${g.role}|${g.projectId?.toLowerCase() ?? ''}`;
  // Someone of the organisation who becomes a client: every role they keep counts as given now.
  const had = new Set(wasExternal ? before.map(key) : []);
  const held = new Set(after.filter((g) => !had.has(key(g))).flatMap((g) => matrix[g.role] ?? []));
  return EXTERNAL_SENSITIVE_PERMISSIONS.filter((p) => held.has(p));
}

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
