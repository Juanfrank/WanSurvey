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
}

export interface CaseList {
  total: number;
  page: number;
  limit: number;
  counts: Partial<Record<CaseStatus, number>>;
  fields: SampleField[];
  piiMasked: boolean;
  canReveal: boolean;
  rows: CaseRow[];
}

export interface Assignee {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  workload: Partial<Record<CaseStatus, number>>;
}

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
