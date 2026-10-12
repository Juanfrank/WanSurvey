import {
  createInterview,
  respondentFromCase,
  type CompiledQuestionnaire,
  type InterviewSession,
  type InterviewState,
} from '@wansurvey/logic';
import type { Mode } from '@wansurvey/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { InterviewClock } from './paradata.js';
import { isOffline } from './device.js';
import { InterviewStore, lowOnSpace, type LocalInterview, type NewOp } from './store.js';
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
  settings?: { capi?: { gps: 'off' | 'start_end'; gpsNotice: string } };
  lastSeq: number;
  serverTime: string;
  /** Opened from this device's copy, with no connection. */
  offline?: boolean;
}

/**
 * - `saved`: the server has every change;
 * - `saving`: sending now;
 * - `local`: kept on this device, not yet on the server (offline or waiting);
 * - `error`: could not be kept on this device.
 */
export type SaveState = 'saved' | 'saving' | 'local' | 'error';

const SYNC_EVERY_MS = 3000;

/** Keeps a copy on this device of an interview the server has just started or resumed. */
export async function keepOnDevice(p: InterviewPayload, store?: InterviewStore) {
  const own = store ?? (await InterviewStore.open());
  try {
    if (!(await own.get(p.interview.id)))
      await own.adopt(p.interview.id, {
        seq: p.lastSeq,
        acked: p.lastSeq,
        state: p.interview.state,
        position: null,
        activeMs: p.interview.activeMs,
        totalMs: p.interview.totalMs,
      });
  } finally {
    if (!store) own.close();
  }
}

/** This device's id (made on first use). */
export async function deviceId() {
  const store = await InterviewStore.open();
  try {
    return await store.deviceId();
  } finally {
    store.close();
  }
}

/** Starts (or resumes) an interview on a case and keeps a copy on this device. */
export async function startInterview(
  projectId: string,
  body: { caseId: string; questionnaireId: string; mode: Mode },
): Promise<InterviewPayload> {
  const store = await InterviewStore.open();
  try {
    const device = await store.deviceId();
    const p = await api<InterviewPayload>(`/projects/${projectId}/interviews`, {
      method: 'POST',
      body: { ...body, id: crypto.randomUUID(), deviceId: device },
    });
    await keepOnDevice(p, store);
    return p;
  } finally {
    store.close();
  }
}

const hasState = (s: unknown): s is Partial<InterviewState> =>
  !!s && typeof s === 'object' && Object.keys(s).length > 0;

/** The interview as this device has it, for opening with no connection (D2). */
async function localPayload(
  store: InterviewStore,
  local: LocalInterview,
): Promise<InterviewPayload | null> {
  const m = local.meta;
  if (!m) return null;
  const v = await store.getVersion(m.questionnaireVersionId);
  const c = await store.getCase(m.caseId);
  if (!v) return null;
  return {
    interview: {
      id: local.id,
      projectId: m.projectId,
      caseId: m.caseId,
      questionnaireId: '',
      version: v.version,
      mode: m.mode as Mode,
      language: m.language,
      status: 'in_progress',
      disposition: null,
      startedAt: m.startedAt,
      state: (local.state ?? {}) as Partial<InterviewState>,
      activeMs: local.activeMs,
      totalMs: local.totalMs,
      deviceId: await store.deviceId(),
      interviewer: null,
    },
    context: m.context as InterviewPayload['context'],
    compiled: v.compiled as CompiledQuestionnaire,
    ...(c ? { settings: { capi: c.capi } } : {}),
    lastSeq: local.acked,
    serverTime: new Date().toISOString(),
    offline: true,
  };
}

/** The device's position, or why it could not be read (`gps` paradata, D4). */
function position(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation)
      return resolve({ error: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: Math.round(p.coords.latitude * 1e6) / 1e6,
          lng: Math.round(p.coords.longitude * 1e6) / 1e6,
          accuracy: Math.round(p.coords.accuracy),
        }),
      (e) => resolve({ error: e.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

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
  /** The case is downloaded to this device (offline work). */
  const [onDevice, setOnDevice] = useState(false);
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
        let local = await store.get(id);
        let p: InterviewPayload;
        // Started on this device and not yet on the server, or no connection: the device copy.
        const fromDevice = local?.start ? await localPayload(store, local) : null;
        if (fromDevice) p = fromDevice;
        else
          try {
            p = await api<InterviewPayload>(`/interviews/${id}`);
          } catch (e) {
            const copy = local && isOffline(e) ? await localPayload(store, local) : null;
            if (!copy) throw e;
            p = copy;
          }
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
          context: {
            case: p.context.case ?? {},
            respondent: respondentFromCase(p.context.case ?? {}),
          },
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
        setOnDevice(!!local?.meta);
        setPayload(p);
        setSession(s);
        const fresh = !hasState(state);
        record([paradata('enter_question', { key: s.currentKey(), resumed: !fresh })]);
        if (fresh && p.settings?.capi?.gps === 'start_end' && p.interview.mode === 'CAPI')
          void position().then((at) => record([paradata('gps', { when: 'start', ...at })]));
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

  /**
   * Sends everything, then submits; the server re-checks the path. With no connection (or an
   * interview the server has not seen yet) the submission waits on the device and is sent by
   * the next sync: `queued`.
   */
  const submit = useCallback(async (): Promise<{ status: string; disposition: string | null }> => {
    const r = ref.current!;
    if (payload?.settings?.capi?.gps === 'start_end' && payload.interview.mode === 'CAPI')
      record([paradata('gps', { when: 'end', ...(await position()) })]);
    await r.writes;
    for (let i = 0; i < 3; i++) {
      await sync({ force: true });
      const local = await r.store.get(id);
      if (local && local.seq <= local.acked && !local.start) break;
    }
    const local = await r.store.get(id);
    const body = { seq: local?.seq ?? 0, path: r.session.pathKeys() };
    const disposition = r.session.status().disposition ?? 'COMPLETE';
    const queue = async () => {
      await r.store.patch(id, { submit: body });
      if (local?.meta)
        await r.store.patchCase(local.meta.caseId, { status: 'queued', disposition });
      return { status: 'queued', disposition };
    };
    if (local?.start || (local && local.seq > local.acked)) return queue();
    try {
      const res = await api<{ status: string; disposition: string }>(`/interviews/${id}/submit`, {
        method: 'POST',
        body: { deviceId: await r.store.deviceId(), ...body },
      });
      await r.store.remove(id);
      if (local?.meta)
        await r.store.patchCase(local.meta.caseId, {
          status: 'done',
          disposition: res.disposition,
        });
      return res;
    } catch (e) {
      if (isOffline(e)) return queue();
      throw e;
    }
  }, [id, sync, payload, record, paradata]);

  return {
    payload,
    session,
    error,
    save,
    problem,
    lowSpace,
    onDevice,
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
