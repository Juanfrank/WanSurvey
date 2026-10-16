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
import { InterviewStore, type NewOp } from '../interview/store.js';
import { Syncer, type SyncResult } from '../interview/sync.js';
import { respondentText } from './text.js';

interface RespondentPayload {
  interview: {
    id: string;
    language: string;
    status: string;
    startedAt: string;
    state: Partial<InterviewState>;
    activeMs: number;
    totalMs: number;
  };
  context: { case: Record<string, unknown> };
  compiled: CompiledQuestionnaire;
  lastSeq: number;
  completion: { message: string; redirectUrl: string };
}

const hasState = (s: unknown): s is Partial<InterviewState> =>
  !!s && typeof s === 'object' && Object.keys(s).length > 0;

/**
 * The respondent's survey (`/s/$token`): the link is the credential. Pages on wide screens,
 * one question per page on phones; every change is kept on the device and sent at once, so a
 * respondent can stop and come back with the same link, on any device.
 */
/**
 * The link's parameters (`?sede=2`): questions with that link parameter take them. They are
 * remembered for this invitation, so coming back without them keeps the same answers.
 */
export function linkParams(token: string): Record<string, string> {
  const fresh: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((v, k) => {
    if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && !['lang', 'ref'].includes(k))
      fresh[k] = v.slice(0, 200);
  });
  const key = `ws.params.${token}`;
  try {
    if (Object.keys(fresh).length) localStorage.setItem(key, JSON.stringify(fresh));
    else return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>;
  } catch {
    // Without storage the parameters still work for this visit.
  }
  return fresh;
}

export function RespondentPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [payload, setPayload] = useState<RespondentPayload | null>(null);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState<'notFound' | 'closed' | 'failed' | null>(null);
  const [save, setSave] = useState<'saved' | 'saving' | 'offline'>('saved');
  const [phase, setPhase] = useState<'answering' | 'sending' | 'done' | 'already'>('answering');
  const [problem, setProblem] = useState('');
  const [, setTick] = useState(0);
  const ref = useRef<{
    store: InterviewStore;
    syncer: Syncer;
    session: InterviewSession;
    writes: Promise<unknown>;
    lastKey: string | null;
  } | null>(null);

  useEffect(() => {
    let store: InterviewStore | null = null;
    let cancelled = false;
    void (async () => {
      try {
        store = await InterviewStore.open();
        const deviceId = await store.deviceId();
        const p = await api<RespondentPayload>(
          `/public/s/${token}?device=${encodeURIComponent(deviceId)}`,
        );
        if (cancelled) return;
        document.documentElement.lang = p.interview.language;
        if (p.interview.status !== 'in_progress') {
          setPayload(p);
          setPhase('already');
          return;
        }
        const id = p.interview.id;
        const local = await store.get(id);
        if (!local || local.seq < p.lastSeq)
          await store.adopt(id, {
            seq: p.lastSeq,
            acked: p.lastSeq,
            state: p.interview.state,
            position: null,
            activeMs: p.interview.activeMs,
            totalMs: p.interview.totalMs,
          });
        const kept = await store.get(id);
        const state = hasState(kept?.state) ? kept!.state : p.interview.state;
        const s = createInterview(p.compiled, {
          mode: 'CAWI',
          language: p.interview.language,
          seed: id,
          now: () => new Date(p.interview.startedAt),
          context: {
            case: p.context.case,
            respondent: respondentFromCase(p.context.case),
            params: linkParams(token),
          },
          ...(hasState(state) ? { state: state as Partial<InterviewState> } : {}),
        });
        s.drainEvents();
        const send = async (body: unknown): Promise<SyncResult> => {
          const b = body as { deviceId: string; interviews: Record<string, unknown>[] };
          const { id: _id, ...item } = b.interviews[0]!;
          return api<SyncResult>(`/public/s/${token}/sync`, {
            method: 'POST',
            body: { deviceId: b.deviceId, ...item },
          });
        };
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
        setError(
          e instanceof ApiError && e.status === 404
            ? 'notFound'
            : e instanceof ApiError && e.status === 410
              ? 'closed'
              : 'failed',
        );
      }
    })();
    return () => {
      cancelled = true;
      store?.close();
    };
  }, [token]);

  const sync = useCallback(async () => {
    const r = ref.current;
    if (!r || !payload) return;
    await r.writes;
    if (!navigator.onLine) return setSave('offline');
    setSave('saving');
    try {
      await r.syncer.flush([payload.interview.id], { force: true });
      const local = await r.store.get(payload.interview.id);
      setSave(local && local.seq > local.acked ? 'offline' : 'saved');
    } catch {
      setSave('offline');
    }
  }, [payload]);

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
    r.writes = r.writes.then(() => r.store.record(payload.interview.id, ops, snapshot));
    // Sent once written (the send itself waits for the writes, so it is not chained to them).
    void r.writes.then(() => sync());
    setTick((n) => n + 1);
  }, [payload, sync]);

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
      <Shell title={title}>
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
  if (!session) return <Shell title={title}>{<p aria-busy="true">{t.loading}</p>}</Shell>;
  const finished = session.status().state !== 'in_progress';
  return (
    <Shell
      title={title}
      status={save === 'saving' ? t.saving : save === 'offline' ? t.offline : t.saved}
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
}: {
  title: string;
  status?: string;
  children: React.ReactNode;
  /** Inside the staff preview: no page landmarks, no full-screen height. */
  embedded?: boolean;
}) {
  const Heading = embedded ? 'p' : 'h1';
  const Body = embedded ? 'div' : 'main';
  return (
    <div className={`${embedded ? '' : 'min-h-screen'} bg-slate-50`}>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Heading className="text-base font-semibold text-indigo-ink-800">{title}</Heading>
          {status ? (
            <p className="text-xs text-slate-600" role="status" data-testid="respondent-save">
              {status}
            </p>
          ) : null}
        </div>
      </header>
      <Body {...(embedded ? {} : { id: 'main' })} className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">{children}</div>
      </Body>
    </div>
  );
}
