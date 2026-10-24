import { useParams } from '@tanstack/react-router';
import {
  createInterview,
  respondentFromCase,
  type CompiledQuestionnaire,
  type InterviewSession,
  type InterviewState,
} from '@wansurvey/logic';
import { InterviewRunner, pick } from '@wansurvey/renderer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import {
  alignCopy,
  InterviewStore,
  MemoryStore,
  serverCopy,
  type LocalStore,
  type NewOp,
} from '../interview/store.js';
import { Syncer, type SyncResult } from '../interview/sync.js';
import { respondentText } from './text.js';
import { themeStyle, type Branding } from './theme.js';

interface RespondentPayload {
  interview: {
    id: string;
    language: string;
    status: string;
    startedAt: string;
    state: Partial<InterviewState>;
    stateVersion?: number;
    ownState?: boolean;
    activeMs: number;
    totalMs: number;
  };
  /** `params`: the link's parameters (`?sede=2`), as the server kept them for this interview. */
  context: { case: Record<string, unknown>; params?: Record<string, string> };
  compiled: CompiledQuestionnaire;
  lastSeq: number;
  completion: { message: string; redirectUrl: string };
  /** The project's look: colours, type, corners and logo (project settings). */
  branding?: Branding;
}

const hasState = (s: unknown): s is Partial<InterviewState> =>
  !!s && typeof s === 'object' && Object.keys(s).length > 0;

/**
 * The respondent's survey (`/s/$token`): the link is the credential. Pages on wide screens,
 * one question per page on phones; every change is kept on the device and sent at once, so a
 * respondent can stop and come back with the same link, on any device.
 */
export type ClosedReason = 'notFound' | 'closed' | 'unavailable' | 'ended' | 'failed';

/** Why a survey cannot be opened, in the respondent's words. */
export function closedReason(e: unknown): ClosedReason {
  if (!(e instanceof ApiError)) return 'failed';
  if (e.status === 404) return 'notFound';
  if (e.status !== 410) return 'failed';
  return e.code === 'QUESTIONNAIRE_DISABLED'
    ? 'unavailable'
    : e.code === 'QUESTIONNAIRE_COMPLETED'
      ? 'ended'
      : 'closed';
}

export function RespondentPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [payload, setPayload] = useState<RespondentPayload | null>(null);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState<ClosedReason | null>(null);
  const [save, setSave] = useState<'saved' | 'saving' | 'offline'>('saved');
  const [phase, setPhase] = useState<'answering' | 'sending' | 'done' | 'already'>('answering');
  const [problem, setProblem] = useState('');
  /** This device's storage failed: the answers are only in this page until sent. */
  const [inMemory, setInMemory] = useState(false);
  const [, setTick] = useState(0);
  const ref = useRef<{
    store: LocalStore;
    syncer: Syncer;
    session: InterviewSession;
    writes: Promise<unknown>;
    lastKey: string | null;
  } | null>(null);

  /** Opens the survey for this device (which takes it over from any other). */
  const open = useCallback(
    (deviceId: string) =>
      api<RespondentPayload>(
        `/public/s/${token}?device=${encodeURIComponent(deviceId)}` +
          (window.location.search
            ? `&params=${encodeURIComponent(window.location.search.slice(1))}`
            : ''),
      ),
    [token],
  );
  const send = useCallback(
    async (body: unknown): Promise<SyncResult> => {
      const b = body as { deviceId: string; interviews: Record<string, unknown>[] };
      const { id: _id, ...item } = b.interviews[0]!;
      return api<SyncResult>(`/public/s/${token}/sync`, {
        method: 'POST',
        body: { deviceId: b.deviceId, ...item },
      });
    },
    [token],
  );

  useEffect(() => {
    let store: LocalStore | null = null;
    let cancelled = false;
    void (async () => {
      try {
        // A browser that cannot store data (or refuses to) still answers, from memory.
        store = await InterviewStore.open().catch(() => {
          setInMemory(true);
          return new MemoryStore();
        });
        const deviceId = await store.deviceId();
        const p = await open(deviceId);
        if (cancelled) return;
        document.documentElement.lang = p.interview.language;
        if (p.interview.status !== 'in_progress') {
          setPayload(p);
          setPhase('already');
          return;
        }
        const id = p.interview.id;
        // The link may have been answered on another device since this one last had it: the
        // server's copy wins unless this device has its own changes on the same state to send.
        const kept = await alignCopy(store, serverCopy(p));
        const state = hasState(kept?.state) ? kept!.state : p.interview.state;
        const s = createInterview(p.compiled, {
          mode: 'CAWI',
          language: p.interview.language,
          seed: id,
          now: () => new Date(p.interview.startedAt),
          context: {
            case: p.context.case,
            respondent: respondentFromCase(p.context.case),
            params: p.context.params ?? {},
          },
          ...(hasState(state) ? { state: state as Partial<InterviewState> } : {}),
        });
        s.drainEvents();
        ref.current = {
          store,
          syncer: new Syncer(store, deviceId, send),
          session: s,
          writes: Promise.resolve(),
          lastKey: s.currentKey(),
        };
        setPayload(p);
        setSession(s);
      } catch (e) {
        if (cancelled) return;
        // A completed questionnaire may continue in another one: go there.
        const next = e instanceof ApiError ? e.body?.next : null;
        if (typeof next === 'string' && next.startsWith('/o/')) {
          window.location.replace(next);
          return;
        }
        setError(closedReason(e));
      }
    })();
    return () => {
      cancelled = true;
      store?.close();
    };
  }, [token, open, send]);

  const sync = useCallback(async () => {
    const r = ref.current;
    if (!r || !payload) return;
    await r.writes;
    if (!navigator.onLine) return setSave('offline');
    setSave('saving');
    try {
      await r.syncer.flush([payload.interview.id], { force: true });
      // Answered meanwhile on another device: show the survey as the server has it now.
      if (r.syncer.problems.get(payload.interview.id) === 'STALE_STATE')
        return window.location.reload();
      const local = await r.store.get(payload.interview.id);
      setSave(local && local.seq > local.acked ? 'offline' : 'saved');
    } catch {
      setSave('offline');
    }
  }, [payload]);

  /**
   * This device's storage failed: the page goes on with a copy in memory, under a device id of
   * its own that the survey is handed over to, so its answers still reach the server.
   */
  const toMemory = useCallback(async () => {
    const r = ref.current!;
    const mem = new MemoryStore();
    const device = await mem.deviceId();
    const p = await open(device);
    const id = p.interview.id;
    await mem.adopt(id, {
      seq: p.lastSeq,
      acked: p.lastSeq,
      state: r.session.state(),
      position: null,
      activeMs: 0,
      totalMs: 0,
      ...(p.interview.stateVersion !== undefined ? { base: p.interview.stateVersion } : {}),
    });
    r.store = mem;
    r.syncer = new Syncer(mem, device, send);
  }, [open, send]);

  useEffect(() => {
    const back = () => void sync();
    window.addEventListener('online', back);
    const timer = setInterval(back, 10_000);
    return () => {
      window.removeEventListener('online', back);
      clearInterval(timer);
    };
  }, [sync]);

  const onChange = useCallback(() => {
    const r = ref.current;
    if (!r || !payload) return;
    const s = r.session;
    const ops: NewOp[] = s.drainEvents().map((e) => ({
      kind: 'answer',
      variable: e.key,
      oldValue: e.oldValue ?? null,
      newValue: e.newValue ?? null,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    // Moving between pages is recorded too, so the position (and the end) reaches the server.
    const key = s.currentKey();
    if (key !== r.lastKey) {
      const at = new Date().toISOString();
      if (r.lastKey)
        ops.push({ kind: 'paradata', type: 'leave_question', at, payload: { key: r.lastKey } });
      if (key) ops.push({ kind: 'paradata', type: 'enter_question', at, payload: { key } });
      r.lastKey = key;
    }
    if (!ops.length) return setTick((n) => n + 1);
    const snapshot = { state: s.state(), position: key, activeMs: 0, totalMs: 0 };
    const id = payload.interview.id;
    // A failed write does not stop the ones after it: the page goes on in memory (or tries
    // again with the next change, when even that cannot be set up).
    r.writes = r.writes
      .then(() => r.store.record(id, ops, snapshot))
      .catch(async () => {
        setInMemory(true);
        if (!(r.store instanceof MemoryStore)) await toMemory();
        await r.store.record(id, ops, snapshot);
      })
      .catch(() => setSave('offline'));
    // Sent once written (the send itself waits for the writes, so it is not chained to them).
    void r.writes.then(() => sync());
    setTick((n) => n + 1);
  }, [payload, sync, toMemory]);

  const t = respondentText(payload?.interview.language ?? document.documentElement.lang ?? 'es');

  const submit = async () => {
    const r = ref.current!;
    setPhase('sending');
    setProblem('');
    try {
      await r.writes;
      await sync();
      const local = await r.store.get(payload!.interview.id);
      await api(`/public/s/${token}/submit`, {
        method: 'POST',
        body: {
          deviceId: await r.store.deviceId(),
          seq: local?.seq ?? 0,
          path: r.session.pathKeys(),
        },
      });
      await r.store.remove(payload!.interview.id);
      setPhase('done');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SUBMITTED') setPhase('done');
      else {
        setProblem(t.sendFailed);
        setPhase('answering');
      }
    }
  };

  const title = payload
    ? (pick(payload.compiled.questionnaire.title, payload.interview.language) ?? '')
    : '';
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (error)
    return (
      <Shell title="">
        <p role="alert">{t[error]}</p>
      </Shell>
    );
  if (!payload) return <Shell title="">{<p aria-busy="true">{t.loading}</p>}</Shell>;
  if (phase === 'done' || phase === 'already') {
    const message = phase === 'already' ? t.already : payload.completion.message || t.thanks;
    return (
      <Shell title={title} branding={payload.branding}>
        <div className="flex flex-col items-start gap-4" data-testid="completed">
          <p className="text-lg font-medium" role="status">
            {message}
          </p>
          {payload.completion.redirectUrl ? (
            <a
              className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-on-fill"
              href={payload.completion.redirectUrl}
            >
              {t.continue}
            </a>
          ) : null}
        </div>
      </Shell>
    );
  }
  if (!session)
    return (
      <Shell title={title} branding={payload.branding}>
        {<p aria-busy="true">{t.loading}</p>}
      </Shell>
    );
  const finished = session.status().state !== 'in_progress';
  return (
    <Shell
      title={title}
      branding={payload.branding}
      status={
        save === 'saving'
          ? t.saving
          : save === 'saved'
            ? t.saved
            : // Not on the server yet, and not on this device either.
              inMemory
              ? t.notKept
              : t.offline
      }
    >
      <InterviewRunner
        session={session}
        mode="CAWI"
        lang={payload.interview.language}
        onChange={onChange}
      />
      {finished ? (
        <div className="mt-6 flex flex-col items-start gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            className="rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-on-fill disabled:bg-indigo-300"
            disabled={phase === 'sending'}
            onClick={() => void submit()}
          >
            {phase === 'sending' ? t.sending : t.send}
          </button>
          <p role="alert" className="empty:hidden text-red-ink-800">
            {problem}
          </p>
        </div>
      ) : null}
    </Shell>
  );
}

/** A plain page for respondents: the survey's title and nothing of the staff application. */
export function Shell({
  title,
  status,
  children,
  embedded,
  branding,
}: {
  title: string;
  status?: string;
  children: React.ReactNode;
  /** Inside the staff preview: no page landmarks, no full-screen height. */
  embedded?: boolean;
  branding?: Branding;
}) {
  const Heading = embedded ? 'p' : 'h1';
  const Body = embedded ? 'div' : 'main';
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const logoAt = branding?.logo ? branding.theme.logo : 'hidden';
  const logo =
    branding?.logo && logoAt !== 'hidden' ? (
      <img src={branding.logo} alt="" className="h-10 w-auto max-w-[10rem] object-contain" />
    ) : null;
  return (
    <div
      className={`${embedded ? '' : 'min-h-screen'} bg-slate-50`}
      style={themeStyle(branding?.theme, dark)}
      data-testid="respondent-shell"
    >
      <header className="border-b border-slate-200 bg-white">
        {logoAt === 'center' && logo ? (
          <div className="mx-auto flex max-w-3xl justify-center px-4 pt-3">{logo}</div>
        ) : null}
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <span className="flex min-w-0 items-center gap-3">
            {logoAt === 'left' ? logo : null}
            {/* Pages that name themselves (the feedback question) pass no title: no empty h1. */}
            {title ? (
              <Heading className="text-base font-semibold text-indigo-ink-800">{title}</Heading>
            ) : null}
          </span>
          <p
            className="text-xs text-slate-600 empty:hidden"
            role="status"
            data-testid="respondent-save"
          >
            {status || null}
          </p>
        </div>
      </header>
      <Body {...(embedded ? {} : { id: 'main' })} className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">{children}</div>
      </Body>
    </div>
  );
}
