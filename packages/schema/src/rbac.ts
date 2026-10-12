import { z } from 'zod';

export const ROLES = [
  'owner',
  'admin',
  'project_manager',
  'supervisor',
  'reviewer',
  'interviewer',
  'data_entry',
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
    'interviews.read_all',
    'interviews.review',
    'interviews.approve',
  ],
  interviewer: [
    'tenant.read',
    'projects.read',
    'questionnaires.read',
    'cases.read_assigned',
    'interviews.conduct',
    'interviews.read_own',
    'metrics.own',
    'pii.view',
  ],
  data_entry: [
    'tenant.read',
    'projects.read',
    'questionnaires.read',
    'cases.read_assigned',
    'dataentry.key',
  ],
  client_viewer: ['tenant.read', 'projects.read', 'dashboards.read'],
};

/** Roles that must enrol TOTP before using the app. */
export const ROLES_REQUIRING_2FA: readonly Role[] = ['owner', 'admin'];

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles an actor may grant: never above their own rank; only owners create owners. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 90,
  project_manager: 70,
  supervisor: 60,
  reviewer: 50,
  interviewer: 40,
  data_entry: 40,
  client_viewer: 10,
};
