import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BreakingChange, Diagnostic, MappingProblem, ScenarioCheck } from '@wansurvey/logic';
import { roleHasPermission, Scenario, type Permission, type Role } from '@wansurvey/schema';
import { api } from '../api.js';
import type { ScenarioStore } from '../preview/panels.js';
import { useMe } from '../routes/AppLayout.js';

/** Whether the signed-in member holds a permission for a project (tenant-wide or scoped). */
export function useCan(permission: Permission, projectId: string | null): boolean {
  const me = useMe();
  return !!me.data?.memberships.some(
    (m) =>
      (m.permissions
        ? m.permissions.includes(permission)
        : roleHasPermission(m.role as Role, permission)) &&
      (m.projectId === null || m.projectId === projectId),
  );
}

export interface PublishCheckResult {
  ok: boolean;
  schemaIssues: { path: string; message: string }[];
  diagnostics: Diagnostic[];
  scenarios: {
    id: string;
    name: string;
    passed: boolean;
    checks: ScenarioCheck[];
  }[];
  breaking: BreakingChange[];
  mappingProblems: MappingProblem[];
  unchanged: boolean;
  previousVersion: number | null;
  draftRevision: number;
}

export interface VersionSummary {
  version: number;
  status: 'published' | 'retired';
  hash: string;
  hasMapping: boolean;
  publishedAt: string;
  publishedBy: string | null;
  retiredAt: string | null;
}

const base = (projectId: string, qid: string) => `/projects/${projectId}/questionnaires/${qid}`;

export function useVersions(projectId: string, qid: string) {
  return useQuery({
    queryKey: ['versions', qid],
    queryFn: () => api<VersionSummary[]>(`${base(projectId, qid)}/versions`),
  });
}

export function useRetire(projectId: string, qid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api(`${base(projectId, qid)}/versions/${version}/retire`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['versions', qid] }),
  });
}

/** Scenarios saved on the server; publishing runs every one of them. */
export function useApiScenarios(projectId: string, qid: string): ScenarioStore {
  const qc = useQueryClient();
  const key = ['scenarios', qid];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ id: string; name: string; scenario: unknown }[]>(`${base(projectId, qid)}/scenarios`),
  });
  const rows = query.data ?? [];
  const list = rows.flatMap((r) => {
    const s = Scenario.safeParse(r.scenario);
    return s.success ? [s.data] : [];
  });
  return {
    list,
    async save(s) {
      await api(`${base(projectId, qid)}/scenarios`, { method: 'PUT', body: { scenario: s } });
      await qc.invalidateQueries({ queryKey: key });
    },
    async remove(s) {
      const row = rows.find((r) => r.name === s.name);
      if (!row) return;
      await api(`${base(projectId, qid)}/scenarios/${row.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: key });
    },
  };
}

export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
