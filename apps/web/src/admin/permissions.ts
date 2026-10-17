import type { Permission } from '@wansurvey/schema';

/** The permissions grouped as people think of them, for the roles page and the role guide. */
export const PERMISSION_AREAS: { area: string; permissions: Permission[] }[] = [
  {
    area: 'organisation',
    permissions: [
      'tenant.read',
      'tenant.manage',
      'tenant.billing',
      'tenant.delete',
      'users.read',
      'users.manage',
      'audit.read',
    ],
  },
  {
    area: 'projects',
    permissions: ['projects.read', 'projects.create', 'projects.update', 'projects.delete'],
  },
  {
    area: 'questionnaires',
    permissions: [
      'questionnaires.read',
      'questionnaires.edit',
      'questionnaires.publish',
      'questionnaires.comment',
    ],
  },
  {
    area: 'cases',
    permissions: [
      'cases.read_all',
      'cases.read_assigned',
      'cases.import',
      'cases.assign',
      'cases.edit',
    ],
  },
  {
    area: 'fieldwork',
    permissions: [
      'interviews.conduct',
      'interviews.read_own',
      'dataentry.key',
      'cawi.waves',
      'email.templates',
    ],
  },
  {
    area: 'review',
    permissions: [
      'interviews.read_all',
      'interviews.review',
      'interviews.approve',
      'interviews.correct',
    ],
  },
  {
    area: 'results',
    permissions: ['metrics.own', 'metrics.team', 'dashboards.read', 'exports.run'],
  },
  { area: 'privacy', permissions: ['pii.view'] },
];

/** The i18n key of a permission's label (keys cannot hold dots). */
export const permKey = (p: string) => `admin.perms.${p.replace(/\./g, '_')}`;

/** What `GET /tenant/roles` returns. */
export interface RolesView {
  roles: {
    role: string;
    permissions: string[];
    defaults: string[];
    editable: boolean;
    changed: boolean;
  }[];
  permissions: string[];
  reserved: string[];
}
