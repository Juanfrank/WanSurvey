import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import type { SampleField } from '../designer/vars.js';

export const STATUSES = ['fresh', 'assigned', 'in_progress', 'finalised', 'withdrawn'] as const;
export type CaseStatus = (typeof STATUSES)[number];

export interface CaseRow {
  id: string;
  externalId: string;
  sample: Record<string, unknown>;
  status: CaseStatus;
  disposition: string | null;
  priority: number;
  modePreference: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  updatedAt: string;
  assignedAt?: string | null;
  questionnaireId?: string | null;
  /** When a callback or appointment is due, if one is. */
  nextContactAt?: string | null;
  /** An interview of the case was sent back for corrections. */
  returned?: boolean;
}

export interface CaseList {
  total: number;
  page: number;
  limit: number;
  counts: Partial<Record<CaseStatus, number>>;
  /** Finished with a complete interview. */
  completed?: number;
  /** Held by someone, whatever their state. */
  held?: number;
  /** Open cases with an interview sent back for corrections. */
  returned?: number;
  /** Open cases with a callback or appointment due within a day. */
  due?: number;
  fields: SampleField[];
  assignmentMode: 'assigned' | 'pool';
  /** Days a case may stay assigned before it expires; null: no deadline. */
  caseExpiryDays?: number | null;
  caseExpiryHours?: number | null;
  piiMasked: boolean;
  autoReveal: boolean;
  canReveal: boolean;
  rows: CaseRow[];
}

export interface Assignee {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  /** The organisation's teams the person is in. */
  teams?: { id: string; name: string }[];
  workload: Partial<Record<CaseStatus, number>>;
}

/**
 * People who go to the field. `roles` lists only the roles that let the person work cases, so
 * anyone who has one besides owner or administrator (whose roles carry every permission) works
 * cases by design; owners and administrators alone are offered apart and not chosen by default.
 */
export const isFieldWorker = (p: Pick<Assignee, 'roles'>) =>
  p.roles.some((r) => r !== 'owner' && r !== 'admin');

export function useAssignees(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['assignees', projectId],
    queryFn: () => api<Assignee[]>(`/projects/${projectId}/assignees`),
    enabled,
  });
}

export function useSampleFields(projectId: string) {
  return useQuery({
    queryKey: ['sample-fields', projectId],
    queryFn: () => api<SampleField[]>(`/projects/${projectId}/sample-fields`),
  });
}

export const qs = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
