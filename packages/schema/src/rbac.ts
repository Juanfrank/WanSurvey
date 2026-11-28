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

/** Roles that must enrol TOTP before using the app, whatever the organisation decides. */
export const ROLES_REQUIRING_2FA: readonly Role[] = ['owner', 'admin'];

/** Roles an organisation may add to those that must enrol TOTP (its two-step policy). */
export const OPTIONAL_2FA_ROLES = ROLES.filter((r) => !ROLES_REQUIRING_2FA.includes(r));

/** The organisation's list of extra roles that must use two-step verification. */
export const TwoFactorRoles = z
  .array(z.enum(OPTIONAL_2FA_ROLES as [Role, ...Role[]]))
  .max(ROLES.length)
  .refine((list) => new Set(list).size === list.length, 'Repeated role');

/**
 * Every role that must enrol TOTP in an organisation: the fixed ones plus those its settings
 * add (`settings.twoFactorRoles`). Unknown or malformed entries are ignored.
 */
export function rolesRequiring2fa(settings?: unknown): Role[] {
  const extra = (settings && typeof settings === 'object' ? settings : {}) as {
    twoFactorRoles?: unknown;
  };
  const list = Array.isArray(extra.twoFactorRoles)
    ? extra.twoFactorRoles.filter((r): r is Role => OPTIONAL_2FA_ROLES.includes(r as Role))
    : [];
  return [...new Set<Role>([...ROLES_REQUIRING_2FA, ...list])];
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

// ─── Closed projects ─────────────────────────────────────────────────────────────────

/** Project statuses in which fieldwork is over: nothing is started, sent, assigned or claimed. */
export const CLOSED_PROJECT_STATUSES = ['closed', 'archived'] as const;

/** Whether fieldwork is over in a project of this status. */
export const isClosedStatus = (status: string | null | undefined): boolean =>
  (CLOSED_PROJECT_STATUSES as readonly string[]).includes(status ?? '');

/** The permission of whoever runs a project: it alone reopens a project, a case or an interview. */
export const MANAGE_PROJECT: Permission = 'projects.update';

/**
 * The permissions of fieldwork: doing, handing out, reviewing and correcting interviews. A role
 * that holds one of them is a field role: it no longer reaches a closed project.
 */
export const FIELD_PERMISSIONS: readonly Permission[] = [
  'interviews.conduct',
  'dataentry.key',
  'cases.read_assigned',
  'cases.assign',
  'interviews.review',
  'interviews.approve',
  'interviews.correct',
];

/**
 * Whether a role, by what it allows, still reaches a project once it is closed: whoever runs the
 * project (`projects.update`: owners, administrators, project managers) and the roles that only
 * read or analyse (client viewers). Field roles (interviewers, supervisors, reviewers, and any
 * customised role holding a fieldwork permission) do not; their grants stay, and reopening the
 * project gives the access back.
 */
export const staysWhenClosed = (permissions: readonly Permission[]): boolean =>
  permissions.includes(MANAGE_PROJECT) || !permissions.some((p) => FIELD_PERMISSIONS.includes(p));

/** A grant as the session holds it; `exceptProjects`: closed projects it no longer reaches. */
export interface ProjectGrant {
  role: Role;
  projectId: string | null;
  permissions?: readonly Permission[];
  exceptProjects?: readonly string[];
}

/**
 * The grants that apply once closed projects are taken into account: a field role's grant in a
 * closed project is left out, and an organisation-wide one stops at the closed projects (listed
 * in `exceptProjects`). Nothing is deleted: the person's roles are as they were.
 */
export function withoutClosedProjects<G extends ProjectGrant>(
  grants: readonly G[],
  closed: readonly string[],
  matrix: RoleMatrix = ROLE_PERMISSIONS,
): G[] {
  if (!closed.length) return [...grants];
  const shut = new Set(closed.map((id) => id.toLowerCase()));
  return grants.flatMap((g) => {
    if (staysWhenClosed(g.permissions ?? matrix[g.role] ?? [])) return [g];
    if (g.projectId !== null) return shut.has(g.projectId.toLowerCase()) ? [] : [g];
    return [{ ...g, exceptProjects: [...shut] }];
  });
}

/** Whether a grant reaches a project (`null`: organisation-wide only). */
export const grantReaches = (g: ProjectGrant, projectId: string | null): boolean =>
  g.projectId === null
    ? !(projectId && g.exceptProjects?.includes(projectId.toLowerCase()))
    : projectId !== null && g.projectId.toLowerCase() === projectId.toLowerCase();
