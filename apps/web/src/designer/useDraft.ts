import { useQuery, useQueryClient } from '@tanstack/react-query';
import { analyze, type Diagnostic } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import { mergeDrafts } from './merge.js';
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
  /** Items (or `questionnaire.<part>`) both sides changed differently, when known. */
  items?: string[];
}

/** What happened when a newer server draft came in. */
export type SyncOutcome = 'none' | 'loaded' | 'merged' | 'conflict';

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
 * optimistic locking. When someone else saved first, their draft is merged with the local
 * edits (three-way, against the draft both started from); only edits to the same item stop
 * the save and set `conflict`.
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
  /** The server draft the local one is based on: the common ancestor for merges. */
  const base = useRef<{ draft: Draft; name: string } | null>(null);
  const statusRef = useRef<SaveStatus>('saved');
  statusRef.current = status;

  // Take the server copy on first load and when someone else's revision is loaded; our own
  // saves only bump the cached revision and must not reset the local draft.
  const loaded = useRef(false);
  useEffect(() => {
    if (!query.data) return;
    if (loaded.current && query.data.draftRevision === revision.current) return;
    loaded.current = true;
    revision.current = query.data.draftRevision;
    base.current = { draft: query.data.draft, name: query.data.name };
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
        base.current = sent;
        queryClient.setQueryData<QuestionnaireDoc>(questionnaireKey(projectId, qid), (old) =>
          old ? { ...old, draftRevision: res.draftRevision, updatedAt: res.updatedAt } : old,
        );
        // More edits may have arrived while saving.
        const now = latest.current;
        setStatus(now && now.draft === sent.draft && now.name === sent.name ? 'saved' : 'dirty');
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'DRAFT_CONFLICT') {
          // Someone saved first: merge their draft in; a clean merge autosaves again.
          inFlight.current = null;
          try {
            await syncRef.current();
          } catch {
            setStatus('error');
          }
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

  /**
   * Brings in a newer server draft: loaded as is when there are no local edits, merged with
   * them otherwise. Undo history is cleared, since older steps lack the other person's edits.
   */
  const sync = useCallback(async (): Promise<SyncOutcome> => {
    if (inFlight.current || !latest.current || !base.current) return 'none';
    const doc = await api<QuestionnaireDoc>(`/projects/${projectId}/questionnaires/${qid}`);
    if (doc.draftRevision <= revision.current || inFlight.current) return 'none';
    const local = latest.current;
    const unchanged =
      statusRef.current === 'saved' &&
      local.draft === base.current.draft &&
      local.name === base.current.name;
    let draft = doc.draft;
    let name = doc.name;
    let outcome: SyncOutcome = 'loaded';
    if (!unchanged) {
      const merged = mergeDrafts(base.current.draft, local.draft, doc.draft);
      const was = base.current.name;
      if (local.name !== was && doc.name !== was && local.name !== doc.name)
        merged.conflicts.push('name');
      if (!merged.draft || merged.conflicts.length) {
        setConflict({
          currentRevision: doc.draftRevision,
          updatedBy: doc.updatedBy,
          updatedAt: doc.updatedAt,
          items: merged.conflicts,
        });
        setStatus('conflict');
        return 'conflict';
      }
      draft = merged.draft;
      name = local.name !== base.current.name ? local.name : doc.name;
      outcome = 'merged';
    }
    revision.current = doc.draftRevision;
    base.current = { draft: doc.draft, name: doc.name };
    queryClient.setQueryData<QuestionnaireDoc>(questionnaireKey(projectId, qid), doc);
    lastCoalesce.current = null;
    latest.current = { draft, name };
    setState({ draft, name, past: [], future: [] });
    setConflict(null);
    setStatus(outcome === 'merged' ? 'dirty' : 'saved');
    return outcome;
  }, [projectId, qid, queryClient]);
  const syncRef = useRef(sync);
  syncRef.current = sync;

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
    sync,
  };
}

export type DraftApi = ReturnType<typeof useDraft>;
