import {
  createInterview,
  type CompiledQuestionnaire,
  type InterviewSession,
  type InterviewState,
} from '@wansurvey/logic';
import type { Mode } from '@wansurvey/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { InterviewClock } from './paradata.js';
import { InterviewStore, lowOnSpace, type NewOp } from './store.js';
import { Syncer } from './sync.js';

export interface InterviewPayload {
  interview: {
    id: string;
    projectId: string;
    caseId: string | null;
    questionnaireId: string;
    version: number;
    mode: Mode;
    language: string;
    status: string;
    disposition: string | null;
    startedAt: string;
    state: Partial<InterviewState>;
    activeMs: number;
    totalMs: number;
    deviceId: string;
    interviewer: string | null;
  };
  context: {
    externalId?: string;
    case?: Record<string, unknown>;
    contacts?: { type: string; value: string; label: string | null }[];
  };
  compiled: CompiledQuestionnaire;
  lastSeq: number;
  serverTime: string;
}

/**
 * - `saved`: the server has every change;
 * - `saving`: sending now;
 * - `local`: kept on this device, not yet on the server (offline or waiting);
 * - `error`: could not be kept on this device.
 */
export type SaveState = 'saved' | 'saving' | 'local' | 'error';

const SYNC_EVERY_MS = 3000;

/** Starts (or resumes) an interview on a case and keeps a copy on this device. */
export async function startInterview(
  projectId: string,
  body: { caseId: string; questionnaireId: string; mode: Mode },
): Promise<InterviewPayload> {
  const store = await InterviewStore.open();
  try {
    const deviceId = await store.deviceId();
    const p = await api<InterviewPayload>(`/projects/${projectId}/interviews`, {
      method: 'POST',
      body: { ...body, id: crypto.randomUUID(), deviceId },
    });
    if (!(await store.get(p.interview.id)))
      await store.adopt(p.interview.id, {
        seq: p.lastSeq,
        acked: p.lastSeq,
        state: p.interview.state,
        position: null,
        activeMs: p.interview.activeMs,
        totalMs: p.interview.totalMs,
      });
    return p;
  } finally {
    store.close();
  }
}

const hasState = (s: unknown): s is Partial<InterviewState> =>
  !!s && typeof s === 'object' && Object.keys(s).length > 0;

/**
 * The interview on screen: the engine session, its copy on this device, the sync loop and the
 * timing. Every change is written to the device first, then sent; "Saved" means the server
 * has acknowledged everything.
 */
export function useInterview(id: string) {
  const [payload, setPayload] = useState<InterviewPayload | null>(null);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [problem, setProblem] = useState<string | null>(null);
  const [lowSpace, setLowSpace] = useState(false);
  const [, setTick] = useState(0);
  const ref = useRef<{
    store: InterviewStore;
    syncer: Syncer;
    clock: InterviewClock;
    session: InterviewSession;
    lastKey: string | null;
    writes: Promise<unknown>;
  } | null>(null);

  const refreshSave = useCallback(async () => {
    const r = ref.current;
    if (!r) return;
    const local = await r.store.get(id);
    const code = r.syncer.problems.get(id);
    setProblem(code ?? null);
    if (code) setSave('error');
    else setSave(local && local.seq > local.acked ? 'local' : 'saved');
  }, [id]);

  const sync = useCallback(
    async (opts: { force?: boolean; keepalive?: boolean } = {}) => {
      const r = ref.current;
      if (!r) return;
      await r.writes;
      const local = await r.store.get(id);
      if (!local || local.seq <= local.acked) return refreshSave();
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return setSave('local');
      setSave('saving');
      try {
        await r.syncer.flush([id], opts);
      } catch {
        // Kept on the device; the next try comes after a back-off.
      }
      await refreshSave();
    },
    [id, refreshSave],
  );

  /** Writes ops and the snapshot to the device, in order, then sends them. */
  const record = useCallback(
    (ops: NewOp[]) => {
      const r = ref.current;
      if (!r) return;
      const s = r.session;
      const snapshot = {
        state: s.state(),
        position: s.currentKey(),
        activeMs: r.clock.activeMs(),
        totalMs: r.clock.totalMs(),
      };
      r.writes = r.writes
        .then(() => r.store.record(id, ops, snapshot))
        .then(
          () => {
            setSave((st) => (st === 'error' ? st : 'local'));
            void sync();
          },
          () => setSave('error'),
        );
    },
    [id, sync],
  );

  const paradata = useCallback(
    (type: string, payloadData: Record<string, unknown> = {}): NewOp => ({
      kind: 'paradata',
      type,
      ...ref.current!.clock.at(),
      payload: payloadData,
    }),
    [],
  );

  // Load: the server copy, or this device's when it has changes the server lacks.
  useEffect(() => {
    let cancelled = false;
    let store: InterviewStore | null = null;
    void (async () => {
      try {
        store = await InterviewStore.open();
        const deviceId = await store.deviceId();
        const p = await api<InterviewPayload>(`/interviews/${id}`);
        let local = await store.get(id);
        if (!local || local.seq < p.lastSeq) {
          await store.adopt(id, {
            seq: p.lastSeq,
            acked: p.lastSeq,
            state: p.interview.state,
            position: null,
            activeMs: p.interview.activeMs,
            totalMs: p.interview.totalMs,
          });
          local = await store.get(id);
        }
        const state = hasState(local?.state) ? local!.state : p.interview.state;
        const s = createInterview(p.compiled, {
          mode: p.interview.mode,
          language: p.interview.language,
          seed: p.interview.id,
          now: () => new Date(p.interview.startedAt),
          context: { case: p.context.case ?? {} },
          ...(hasState(state) ? { state: state as Partial<InterviewState> } : {}),
        });
        s.drainEvents();
        const clock = new InterviewClock(p.serverTime, undefined, {
          activeMs: local?.activeMs ?? p.interview.activeMs,
          totalMs: local?.totalMs ?? p.interview.totalMs,
        });
        if (cancelled) return;
        ref.current = {
          store,
          syncer: new Syncer(store, deviceId),
          clock,
          session: s,
          lastKey: s.currentKey(),
          writes: Promise.resolve(),
        };
        clock.enter(s.currentKey());
        setPayload(p);
        setSession(s);
        record([paradata('enter_question', { key: s.currentKey(), resumed: true })]);
        setLowSpace(await lowOnSpace());
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
      store?.close();
    };
  }, [id, record, paradata]);

  /** After every change in the runner: answer history, navigation paradata, then save. */
  const onChange = useCallback(() => {
    const r = ref.current;
    if (!r) return;
    const s = r.session;
    const ops: NewOp[] = s.drainEvents().map((e) => ({
      kind: 'answer',
      variable: e.key,
      oldValue: e.oldValue ?? null,
      newValue: e.newValue ?? null,
      at: r.clock.at().at,
      source: e.source,
      reason: e.reason ?? null,
    }));
    const cleared = ops.filter((o) => o.kind === 'answer' && o.reason === 'path_change');
    if (cleared.length)
      ops.push(
        paradata('answers_cleared', {
          keys: cleared.map((o) => (o.kind === 'answer' ? o.variable : '')),
        }),
      );
    const key = s.currentKey();
    if (key !== r.lastKey) {
      const left = r.clock.enter(key);
      if (left) ops.push(paradata('leave_question', { key: left.left, ms: left.ms }));
      const path = s.pathKeys();
      if (key && r.lastKey && path.indexOf(key) < path.indexOf(r.lastKey))
        ops.push(paradata('navigate_back', { from: r.lastKey, to: key }));
      if (key) ops.push(paradata('enter_question', { key }));
      r.lastKey = key;
    }
    if (ops.length) record(ops);
    setTick((n) => n + 1);
  }, [record, paradata]);

  // Send every few seconds, when back online, and when the page is hidden or closed.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
    const online = () => void sync({ force: true });
    const offline = () => setSave((s) => (s === 'saved' ? s : 'local'));
    const visibility = () => {
      const r = ref.current;
      if (!r) return;
      if (document.visibilityState === 'hidden') {
        r.clock.hidden();
        record([paradata('focus_lost')]);
        void sync({ force: true, keepalive: true });
      } else {
        const ms = r.clock.visible();
        record([paradata('focus_gained', { hiddenMs: Math.round(ms) })]);
      }
    };
    const leave = () => void sync({ force: true, keepalive: true });
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leave);
    };
  }, [session, sync, record, paradata]);

  const pause = useCallback(() => {
    ref.current?.clock.pause();
    record([paradata('pause', { key: ref.current?.session.currentKey() })]);
    setTick((n) => n + 1);
  }, [record, paradata]);

  const resume = useCallback(() => {
    const ms = ref.current?.clock.resume() ?? 0;
    record([paradata('resume', { ms: Math.round(ms) })]);
    setTick((n) => n + 1);
  }, [record, paradata]);

  const note = useCallback(
    (text: string) =>
      record([paradata('note_added', { key: ref.current?.session.currentKey(), text })]),
    [record, paradata],
  );

  const setLanguage = useCallback(
    (lang: string) => {
      const r = ref.current;
      if (!r) return;
      const from = r.session.state().language;
      r.session.setLanguage(lang);
      record([paradata('language_switch', { from, to: lang })]);
      setTick((n) => n + 1);
    },
    [record, paradata],
  );

  /** Sends everything, then submits; the server re-checks the path. */
  const submit = useCallback(async () => {
    const r = ref.current!;
    for (let i = 0; i < 3; i++) {
      await sync({ force: true });
      const local = await r.store.get(id);
      if (local && local.seq <= local.acked) break;
    }
    const local = await r.store.get(id);
    const res = await api<{ status: string; disposition: string }>(`/interviews/${id}/submit`, {
      method: 'POST',
      body: {
        deviceId: await r.store.deviceId(),
        seq: local?.seq ?? 0,
        path: r.session.pathKeys(),
      },
    });
    await r.store.remove(id);
    return res;
  }, [id, sync]);

  return {
    payload,
    session,
    error,
    save,
    problem,
    lowSpace,
    clock: ref.current?.clock ?? null,
    onChange,
    pause,
    resume,
    note,
    setLanguage,
    submit,
    sync,
  };
}
