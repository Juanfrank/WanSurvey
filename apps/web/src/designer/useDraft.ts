import { useQuery, useQueryClient } from '@tanstack/react-query';
import { analyze, type Diagnostic } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import type { Draft } from './tree.js';

export interface QuestionnaireDoc {
  id: string;
  projectId: string;
  name: string;
  draft: Draft;
  draftRevision: number;
  updatedAt: string;
  updatedBy: string | null;
  latestVersion: number | null;
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

export interface Conflict {
  currentRevision: number;
  updatedBy: string | null;
  updatedAt: string;
}

const AUTOSAVE_MS = 1500;
const HISTORY = 200;

export const questionnaireKey = (projectId: string, qid: string) =>
  ['questionnaire', projectId, qid] as const;

/** Format problems (Zod) and analyzer diagnostics for a draft, as one list. */
export function diagnose(draft: unknown): {
  diagnostics: Diagnostic[];
  questionnaire: Questionnaire | null;
} {
  const parsed = Questionnaire.safeParse(draft);
  if (!parsed.success) {
    return {
      questionnaire: null,
      diagnostics: parsed.error.issues.slice(0, 50).map((i) => ({
        severity: 'error',
        code: 'format',
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
    };
  }
  return { questionnaire: parsed.data, diagnostics: analyze(parsed.data).diagnostics };
}

/**
 * The questionnaire being designed: local draft with undo/redo, autosave after a pause, and
 * optimistic locking — if someone else saved first, the save stops and `conflict` is set.
 */
export function useDraft(projectId: string, qid: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: questionnaireKey(projectId, qid),
    queryFn: () => api<QuestionnaireDoc>(`/projects/${projectId}/questionnaires/${qid}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [state, setState] = useState<{
    draft: Draft;
    name: string;
    past: Draft[];
    future: Draft[];
  } | null>(null);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const revision = useRef(0);
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const latest = useRef<{ draft: Draft; name: string } | null>(null);

  // Take the server copy on first load and when someone else's revision is loaded; our own
  // saves only bump the cached revision and must not reset the local draft.
  const loaded = useRef(false);
  useEffect(() => {
    if (!query.data) return;
    if (loaded.current && query.data.draftRevision === revision.current) return;
    loaded.current = true;
    revision.current = query.data.draftRevision;
    setState({ draft: query.data.draft, name: query.data.name, past: [], future: [] });
    setStatus('saved');
    setConflict(null);
  }, [query.data]);

  if (state) latest.current = { draft: state.draft, name: state.name };

  /**
   * Applies an edit. Edits with the same `coalesce` key within a second (typing in one field)
   * become one undo step.
   */
  const change = useCallback((next: Draft, coalesce?: string) => {
    setState((s) => {
      if (!s) return s;
      const now = Date.now();
      const merge =
        coalesce &&
        lastCoalesce.current?.key === coalesce &&
        now - lastCoalesce.current.at < 1000 &&
        s.past.length > 0;
      lastCoalesce.current = coalesce ? { key: coalesce, at: now } : null;
      return {
        ...s,
        draft: next,
        past: merge ? s.past : [...s.past, s.draft].slice(-HISTORY),
        future: [],
      };
    });
    setStatus((st) => (st === 'conflict' ? st : 'dirty'));
  }, []);

  const rename = useCallback((name: string) => {
    setState((s) => (s ? { ...s, name } : s));
    setStatus((st) => (st === 'conflict' ? st : 'dirty'));
  }, []);

  const undo = useCallback(() => {
    lastCoalesce.current = null;
    setState((s) =>
      s && s.past.length
        ? { ...s, draft: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.draft, ...s.future] }
        : s,
    );
    setStatus((st) => (st === 'conflict' ? st : 'dirty'));
  }, []);

  const redo = useCallback(() => {
    lastCoalesce.current = null;
    setState((s) =>
      s && s.future.length
        ? { ...s, draft: s.future[0]!, past: [...s.past, s.draft], future: s.future.slice(1) }
        : s,
    );
    setStatus((st) => (st === 'conflict' ? st : 'dirty'));
  }, []);

  /** Saves the latest local draft; resolves to false on a conflict or error. */
  const save = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    if (!latest.current) return Promise.resolve(false);
    const sent = latest.current;
    setStatus('saving');
    const run = (async () => {
      try {
        const res = await api<{ draftRevision: number; updatedAt: string }>(
          `/projects/${projectId}/questionnaires/${qid}/draft`,
          {
            method: 'PUT',
            body: { definition: sent.draft, name: sent.name, baseRevision: revision.current },
          },
        );
        revision.current = res.draftRevision;
        queryClient.setQueryData<QuestionnaireDoc>(questionnaireKey(projectId, qid), (old) =>
          old ? { ...old, draftRevision: res.draftRevision, updatedAt: res.updatedAt } : old,
        );
        // More edits may have arrived while saving.
        const now = latest.current;
        setStatus(now && now.draft === sent.draft && now.name === sent.name ? 'saved' : 'dirty');
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'DRAFT_CONFLICT') {
          setConflict({
            currentRevision: e.body.currentRevision as number,
            updatedBy: (e.body.updatedBy as string | null) ?? null,
            updatedAt: e.body.updatedAt as string,
          });
          setStatus('conflict');
        } else {
          setStatus('error');
        }
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [projectId, qid, queryClient]);

  useEffect(() => {
    if (status !== 'dirty' && status !== 'error') return;
    const timer = setTimeout(() => void save(), status === 'error' ? 5000 : AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [status, state, save]);

  // Warn before leaving with unsaved work.
  useEffect(() => {
    if (status === 'saved') return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [status]);

  /** Conflict: drop local changes and load the other person's version. */
  const reloadTheirs = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: questionnaireKey(projectId, qid) });
    await query.refetch();
  }, [queryClient, projectId, qid, query]);

  /** Conflict: save local changes over theirs. */
  const overwriteMine = useCallback(async () => {
    if (!conflict) return;
    revision.current = conflict.currentRevision;
    setConflict(null);
    setStatus('dirty');
    await save();
  }, [conflict, save]);

  /** Saves everything now (before publishing); resolves to the saved revision, or null. */
  const flush = useCallback(async (): Promise<number | null> => {
    if (conflict) return null;
    if (inFlight.current && !(await inFlight.current)) return null;
    if (status !== 'saved' && !(await save())) return null;
    return revision.current;
  }, [conflict, status, save]);

  const deferred = useDeferredValue(state?.draft);
  const checked = useMemo(() => (deferred ? diagnose(deferred) : null), [deferred]);

  return {
    loading: query.isLoading,
    error: query.error,
    doc: query.data ?? null,
    draft: state?.draft ?? null,
    name: state?.name ?? '',
    revision: revision.current,
    status,
    conflict,
    canUndo: !!state?.past.length,
    canRedo: !!state?.future.length,
    diagnostics: checked?.diagnostics ?? [],
    questionnaire: checked?.questionnaire ?? null,
    change,
    rename,
    undo,
    redo,
    save,
    flush,
    reloadTheirs,
    overwriteMine,
  };
}

export type DraftApi = ReturnType<typeof useDraft>;
