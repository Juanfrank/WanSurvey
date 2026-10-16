import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ScriptBox } from '@wansurvey/renderer';
import {
  CALL_OUTCOMES,
  needsCallbackTime,
  utcToZoned,
  withinHours,
  zonedToUtc,
  type CallOutcome,
} from '@wansurvey/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiFull } from '../api.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
import { deviceId, keepOnDevice, type InterviewPayload } from '../interview/useInterview.js';
import { PhoneIcon } from '../routes/icons.js';
import { SideDrawer, useDrawer } from '../routes/SideDrawer.js';
import { Button } from '../routes/ui.js';

interface Script {
  id: string;
  text: string;
}

export interface CallRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  outcome: CallOutcome | null;
  disposition: string | null;
  callbackAt: string | null;
  numberMasked: string | null;
  connectedMs: number | null;
  note: string | null;
  interviewer: string | null;
}

interface Served {
  attempt: { id: string; startedAt: string; outcome: string | null; interviewId: string | null };
  case: {
    id: string;
    externalId: string;
    attempts: number;
    timezone: string;
    sample: Record<string, unknown>;
  };
  phones: { id: string; value: string; label: string | null }[];
  history: CallRow[];
  callingHours: { from: string; to: string };
  questionnaires: { id: string; name: string }[];
  questionnaireId: string | null;
  scripts: { intro: Script[]; outcomes: Record<string, Script[]> } | null;
}

interface Callback {
  caseId: string;
  externalId: string;
  at: string;
  due: boolean;
  mine: boolean;
  forUserName: string | null;
  timezone: string;
  kind: 'callback' | 'appointment';
  bookedBy: string | null;
  note: string | null;
  attempts: number;
  callableNow: boolean;
  reason: string | null;
}

/** Outcomes an answered call can still end with, when its interview stopped early. */
const INTERRUPTED: CallOutcome[] = ['callback', 'appointment', 'refusal'];

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

const isTyping = (el: EventTarget | null) =>
  !!(el as HTMLElement | null)?.closest?.(
    'textarea, select, input:not([type=radio]):not([type=checkbox])',
  );

/** `YYYY-MM-DDTHH:mm` in the respondent's zone, `days` from now at `hhmm` (or now + minutes). */
function localAt(tz: string, opts: { minutes?: number; days?: number; hhmm?: string }) {
  if (opts.minutes !== undefined)
    return utcToZoned(new Date(Date.now() + opts.minutes * 60_000), tz);
  const today = utcToZoned(new Date(), tz).slice(0, 10);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (opts.days ?? 0));
  return `${d.toISOString().slice(0, 10)}T${opts.hhmm ?? '10:00'}`;
}

/**
 * The telephone interviewer's workspace: the next case to call, its numbers and data, the
 * introduction to read, then what happened on the call. Answered starts the interview;
 * callbacks are booked in the respondent's time zone. Keyboard-first: N, Alt+1–3, 1–9 and
 * Ctrl+Enter.
 */
export function CallsTab({
  projectId,
  notice,
  call,
}: {
  projectId: string;
  notice?: string;
  /** A case to call at once, chosen in its drawer. */
  call?: string;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [served, setServed] = useState<Served | null>(null);
  const [idle, setIdle] = useState<{ reason: string; nextAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    notice === 'interview_done' ? t('cati.interviewDone') : '',
  );
  // Also when the workspace was already open as the interview ended.
  useEffect(() => {
    if (notice === 'interview_done') setMessage(t('cati.interviewDone'));
  }, [notice, t]);
  const [phone, setPhone] = useState(0);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [callback, setCallback] = useState('');
  const [callbackFor, setCallbackFor] = useState<'me' | 'anyone'>('me');
  const [note, setNote] = useState('');
  const [qid, setQid] = useState('');
  const [servedAt, setServedAt] = useState(0);
  const [outcomeAt, setOutcomeAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const nextRef = useRef<HTMLButtonElement>(null);
  const outcomeRef = useRef<HTMLFieldSetElement>(null);
  const announced = useRef(new Set<string>());
  const [due, setDue] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const drawer = useDrawer('ws.callbacks.pinned');
  const callbacks = useQuery({
    queryKey: ['cati-callbacks', projectId],
    queryFn: () => api<Callback[]>(`/projects/${projectId}/cati/callbacks`),
    refetchInterval: 30_000,
  });

  // A callback coming due is announced once.
  useEffect(() => {
    for (const c of callbacks.data ?? []) {
      if (new Date(c.at).getTime() <= now && !announced.current.has(c.caseId)) {
        announced.current.add(c.caseId);
        setDue(c.externalId);
      }
    }
  }, [callbacks.data, now, t]);

  const reset = () => {
    setPhone(0);
    setOutcome(null);
    setCallback('');
    setCallbackFor('me');
    setNote('');
    setOutcomeAt(0);
  };

  // A request for a case made while another request runs (N pressed as the tab opens and
  // checks for an open call, say) is served when that one ends, not dropped.
  // A case chosen in its drawer is called once the open call (if any) has been checked.
  const pending = useRef<{ caseId?: string } | null>(call ? { caseId: call } : null);

  /** `current`: only the caller's open call, if any (opening the tab never takes a case). */
  const next = useCallback(
    async (current = false, caseId?: string) => {
      if (busy) {
        if (!current) pending.current = { caseId };
        return;
      }
      setBusy(true);
      if (!current) setMessage('');
      setDue('');
      try {
        const r = current
          ? await apiFull<Served>(`/projects/${projectId}/cati/current`)
          : await apiFull<Served>(`/projects/${projectId}/cati/next`, {
              method: 'POST',
              body: { ...(qid ? { questionnaireId: qid } : {}), ...(caseId ? { caseId } : {}) },
            });
        if (current && r.status === 204) return;
        reset();
        if (r.status === 204 || !r.body) {
          setServed(null);
          setIdle({
            reason: r.headers.get('x-queue-reason') ?? 'empty',
            nextAt: r.headers.get('x-next-callback'),
          });
        } else {
          setIdle(null);
          setServed(r.body);
          setServedAt(Date.now());
          setQid(r.body.questionnaireId ?? '');
          requestAnimationFrame(() =>
            outcomeRef.current?.querySelector<HTMLInputElement>('input')?.focus(),
          );
        }
      } catch (e) {
        setMessage(localiseError(t, e));
        if (caseId) void qc.invalidateQueries({ queryKey: ['cati-callbacks', projectId] });
      } finally {
        setBusy(false);
      }
    },
    [busy, projectId, qid, t, qc],
  );

  // An open call (after a reload or coming back from the interview) is shown straight away.
  const latest = useRef(next);
  latest.current = next;
  useEffect(() => {
    void latest.current(true);
  }, [projectId]);
  useEffect(() => {
    if (busy || !pending.current) return;
    const p = pending.current;
    pending.current = null;
    // An open call shown meanwhile is kept: the queue returns it again rather than a new case.
    void latest.current(false, p.caseId);
  }, [busy]);

  const interrupted = served?.attempt.outcome === 'answered';
  const choices = interrupted ? INTERRUPTED : [...CALL_OUTCOMES];
  const tz = served?.case.timezone ?? 'UTC';
  const hours = served?.callingHours ?? { from: '09:00', to: '21:00' };
  const callbackDate = callback ? zonedToUtc(callback, tz) : null;
  const callbackProblem =
    outcome && needsCallbackTime(outcome)
      ? !callbackDate
        ? 'none'
        : callbackDate.getTime() < now - 60_000
          ? 'past'
          : !withinHours(callbackDate, tz, hours)
            ? 'hours'
            : null
      : null;
  const canSave =
    !!served &&
    !!outcome &&
    !busy &&
    !callbackProblem &&
    (outcome !== 'answered' || !!qid || !!served.questionnaireId);

  const choose = (o: CallOutcome) => {
    setOutcome(o);
    setOutcomeAt((at) => at || Date.now());
    if (needsCallbackTime(o) && !callback) setCallback(localAt(tz, { minutes: 60 }));
  };

  const save = useCallback(async () => {
    if (!served || !outcome || !canSave) return;
    setBusy(true);
    setMessage('');
    const stop = outcomeAt || Date.now();
    try {
      const body: Record<string, unknown> = {
        outcome,
        note: note.trim() || undefined,
        connectedMs: Math.round(stop - servedAt),
        wrapUpMs: Math.round(Date.now() - stop),
        ...(served.phones[phone] ? { contactId: served.phones[phone]!.id } : {}),
        ...(callbackDate && needsCallbackTime(outcome)
          ? { callbackAt: callbackDate.toISOString(), callbackFor }
          : {}),
      };
      if (outcome === 'answered')
        body.interview = {
          id: crypto.randomUUID(),
          deviceId: await deviceId(),
          questionnaireId: qid || served.questionnaireId,
        };
      const r = await api<{
        outcome: CallOutcome;
        disposition?: string;
        final?: boolean;
        nextContactAt?: string | null;
        interview?: InterviewPayload;
      }>(`/cati/attempts/${served.attempt.id}/outcome`, { method: 'POST', body });
      if (r.interview) {
        await keepOnDevice(r.interview);
        await navigate({
          to: '/projects/$projectId/interviews/$interviewId',
          params: { projectId, interviewId: r.interview.interview.id },
        });
        return;
      }
      const label = t(`cati.outcomes.${outcome}`);
      setMessage(
        r.final
          ? t('cati.savedFinal', {
              outcome: label,
              disposition: dispositionLabel(t, r.disposition ?? ''),
            })
          : r.nextContactAt
            ? t('cati.savedRetry', {
                outcome: label,
                time: new Date(r.nextContactAt).toLocaleString(i18n.language),
              })
            : t('cati.saved', { outcome: label }),
      );
      setServed(null);
      setIdle(null);
      reset();
      await qc.invalidateQueries({ queryKey: ['cati-callbacks', projectId] });
      requestAnimationFrame(() => nextRef.current?.focus());
    } catch (e) {
      setMessage(localiseError(t, e));
    } finally {
      setBusy(false);
    }
  }, [
    served,
    outcome,
    canSave,
    outcomeAt,
    note,
    servedAt,
    phone,
    callbackDate,
    callbackFor,
    qid,
    navigate,
    projectId,
    t,
    i18n.language,
    qc,
  ]);

  const skip = async () => {
    if (!served) return;
    setBusy(true);
    try {
      await api(`/cati/attempts/${served.attempt.id}/release`, { method: 'POST' });
      setServed(null);
      reset();
      requestAnimationFrame(() => nextRef.current?.focus());
    } catch (e) {
      setMessage(localiseError(t, e));
    } finally {
      setBusy(false);
    }
  };

  // Shortcuts work anywhere on the tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.altKey && /^Digit[1-3]$/.test(e.code) && served) {
        const i = Number(e.code.slice(5)) - 1;
        if (served.phones[i]) {
          e.preventDefault();
          setPhone(i);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key.toLowerCase() === 'n' && !served) {
        e.preventDefault();
        void next();
      } else if (served && /^[1-9]$/.test(e.key)) {
        const o = choices[Number(e.key) - 1];
        if (o) {
          e.preventDefault();
          choose(o);
          requestAnimationFrame(() =>
            outcomeRef.current?.querySelector<HTMLInputElement>(`input[value="${o}"]`)?.focus(),
          );
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const theirTime = (at: Date, zone: string) =>
    at.toLocaleString(i18n.language, {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_3rem] gap-4 min-[900px]:grid-cols-1"
      data-testid="calls"
    >
      <section aria-labelledby="calls-title" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="calls-title" className="text-lg font-semibold">
            {t('cati.title')}
          </h2>
          {!served ? (
            <button
              ref={nextRef}
              type="button"
              className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-on-fill hover:bg-indigo-700 disabled:bg-indigo-300"
              disabled={busy}
              onClick={() => void next()}
              aria-keyshortcuts="N"
            >
              {t('cati.next')} <kbd className="ml-1 text-xs opacity-80">N</kbd>
            </button>
          ) : null}
          <p className="text-xs text-slate-600">{t('cati.shortcuts')}</p>
        </div>
        <p
          role="status"
          aria-live="polite"
          className="empty:hidden text-sm"
          data-testid="calls-message"
        >
          {message}
        </p>
        <p
          role="status"
          aria-live="assertive"
          className="empty:hidden rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900"
          data-testid="callback-due"
        >
          {due ? t('cati.callbackDue', { id: due }) : ''}
        </p>
        {!served && idle ? (
          <p className="text-slate-700" data-testid="queue-empty">
            {t(`cati.reason.${idle.reason}`, { defaultValue: t('cati.reason.empty') })}{' '}
            {idle.nextAt
              ? t('cati.nextCallback', {
                  time: new Date(idle.nextAt).toLocaleString(i18n.language),
                })
              : null}
          </p>
        ) : null}

        {served ? (
          <form
            className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            aria-label={t('cati.case', { id: served.case.externalId })}
            data-case={served.case.externalId}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <header className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <h3 className="text-lg font-semibold">
                {t('cati.case', { id: served.case.externalId })}
              </h3>
              <span className="text-sm text-slate-600">
                {t('cati.attempts', { count: served.case.attempts })}
              </span>
              <span className="text-sm" data-testid="their-time">
                {t('cati.theirTime', { time: theirTime(new Date(now), tz), tz })}
              </span>
              <dl className="flex gap-4 text-sm">
                <div>
                  <dt className="text-xs text-slate-600">{t('cati.callTime')}</dt>
                  <dd className="font-mono" data-testid="call-timer">
                    {clock((outcomeAt || now) - servedAt)}
                  </dd>
                </div>
                {outcomeAt ? (
                  <div>
                    <dt className="text-xs text-slate-600">{t('cati.wrapUp')}</dt>
                    <dd className="font-mono">{clock(now - outcomeAt)}</dd>
                  </div>
                ) : null}
              </dl>
            </header>

            <fieldset className="flex flex-wrap gap-2">
              <legend className="mb-1 text-sm font-medium">{t('cati.phones')}</legend>
              {served.phones.map((p, i) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
                >
                  <input
                    type="radio"
                    name="phone"
                    checked={phone === i}
                    onChange={() => setPhone(i)}
                    aria-keyshortcuts={i < 3 ? `Alt+${i + 1}` : undefined}
                  />
                  <span className="font-mono">{p.value}</span>
                  {p.label ? <span className="text-slate-600">{p.label}</span> : null}
                  {i < 3 ? (
                    <kbd className="text-xs text-slate-600">{t('cati.phoneKey', { n: i + 1 })}</kbd>
                  ) : null}
                  <a
                    href={`tel:${p.value}`}
                    className="text-sm text-indigo-ink-700 underline"
                    aria-label={t('cati.dial', { number: p.value })}
                  >
                    ☎
                  </a>
                </label>
              ))}
            </fieldset>

            {interrupted ? (
              <div className="flex flex-col items-start gap-2 rounded-md bg-amber-50 p-3 text-sm">
                <p>{t('cati.interrupted')}</p>
                {served.attempt.interviewId ? (
                  <Button
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: '/projects/$projectId/interviews/$interviewId',
                        params: { projectId, interviewId: served.attempt.interviewId! },
                      })
                    }
                  >
                    {t('cati.continue')}
                  </Button>
                ) : null}
                <p>{t('cati.interruptedOutcome')}</p>
              </div>
            ) : served.scripts?.intro.length ? (
              <ScriptBox scripts={served.scripts.intro} />
            ) : null}

            <fieldset ref={outcomeRef} className="grid gap-1 sm:grid-cols-3" data-testid="outcomes">
              <legend className="mb-1 text-sm font-medium">{t('cati.outcome')}</legend>
              {choices.map((o, i) => (
                <label
                  key={o}
                  className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
                >
                  <input
                    type="radio"
                    name="outcome"
                    value={o}
                    checked={outcome === o}
                    onChange={() => choose(o)}
                    aria-keyshortcuts={String(i + 1)}
                  />
                  <kbd className="w-4 text-xs text-slate-600">{i + 1}</kbd>
                  {t(`cati.outcomes.${o}`)}
                </label>
              ))}
            </fieldset>

            {outcome && served.scripts?.outcomes[outcome]?.length ? (
              <ScriptBox scripts={served.scripts.outcomes[outcome]!} />
            ) : null}

            {outcome && needsCallbackTime(outcome) ? (
              <div
                className="flex flex-col gap-2 rounded-md border border-indigo-200 bg-indigo-50/50 p-3 text-sm"
                data-testid="callback-picker"
              >
                <label className="flex flex-col gap-1">
                  <span className="font-medium">{t('cati.callbackAt', { tz })}</span>
                  <input
                    type="datetime-local"
                    className={`${controlCls} w-auto`}
                    value={callback}
                    min={utcToZoned(new Date(now), tz)}
                    onChange={(e) => setCallback(e.target.value)}
                    aria-describedby="callback-hours callback-problem"
                    aria-invalid={callbackProblem ? true : undefined}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => setCallback(localAt(tz, { minutes: 60 }))}
                  >
                    {t('cati.inHour')}
                  </button>
                  {[hours.from === hours.to ? '10:00' : hours.from, '18:00'].map((hhmm) => (
                    <button
                      key={hhmm}
                      type="button"
                      className={smallBtn}
                      onClick={() => setCallback(localAt(tz, { days: 1, hhmm }))}
                    >
                      {t('cati.tomorrowAt', { time: hhmm })}
                    </button>
                  ))}
                </div>
                <p id="callback-hours" className="text-slate-600">
                  {t('cati.callbackHours', hours)}
                </p>
                <p id="callback-problem" className="empty:hidden font-medium text-red-ink-800">
                  {callbackProblem === 'hours'
                    ? t('cati.outsideHours')
                    : callbackProblem === 'past'
                      ? t('cati.inPast')
                      : ''}
                </p>
                <fieldset className="flex gap-4">
                  <legend className="mb-1 font-medium">{t('cati.callbackFor')}</legend>
                  {(['me', 'anyone'] as const).map((w) => (
                    <label key={w} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="callback-for"
                        checked={callbackFor === w}
                        onChange={() => setCallbackFor(w)}
                      />
                      {w === 'me' ? t('cati.forMe') : t('cati.forAnyone')}
                    </label>
                  ))}
                </fieldset>
              </div>
            ) : null}

            {outcome === 'answered' && served.questionnaires.length > 1 ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('cati.questionnaire')}</span>
                <select
                  className={`${controlCls} w-auto`}
                  value={qid}
                  onChange={(e) => setQid(e.target.value)}
                >
                  {served.questionnaires.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('cati.note')}</span>
              <textarea
                className={`${inputCls} min-h-[3rem]`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!canSave} aria-keyshortcuts="Control+Enter">
                {outcome === 'answered' ? t('cati.start') : t('cati.save')}{' '}
                <kbd className="ml-1 text-xs opacity-80">{t('cati.saveKey')}</kbd>
              </Button>
              {!interrupted ? (
                <button type="button" className={smallBtn} onClick={() => void skip()}>
                  {t('cati.skip')}
                </button>
              ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <section aria-labelledby="calls-sample" className="text-sm">
                <h4 id="calls-sample" className="mb-1 font-semibold">
                  {t('cati.sample')}
                </h4>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  {Object.entries(served.case.sample).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-mono text-slate-600">{k}</dt>
                      <dd>{v === null || v === undefined ? '—' : String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section aria-labelledby="calls-history" className="text-sm">
                <h4 id="calls-history" className="mb-1 font-semibold">
                  {t('cati.history')}
                </h4>
                <CallList rows={served.history.filter((h) => h.id !== served.attempt.id)} />
              </section>
            </div>
          </form>
        ) : null}
      </section>

      <SideDrawer
        id="calls-callbacks-drawer"
        drawer={drawer}
        side="right"
        label={t('cati.callbacks')}
        width="21rem"
        icon={<PhoneIcon className="h-[18px] w-[18px]" />}
        badge={callbacks.data?.filter((c) => new Date(c.at).getTime() <= now).length}
        className="text-sm"
      >
        <Callbacks
          rows={callbacks.data ?? []}
          now={now}
          canCall={!served && !busy}
          onCall={(c) => {
            drawer.setOpen(false);
            void next(false, c.caseId);
          }}
        />
      </SideDrawer>
    </div>
  );
}

/**
 * The caller's callbacks and appointments, in three groups: due now, later today and coming
 * up. Each says when (in the caller's and the respondent's time), for whom, who booked it and
 * why, and can be called straight away when the queue rules allow it.
 */
function Callbacks({
  rows,
  now,
  canCall,
  onCall,
}: {
  rows: Callback[];
  now: number;
  canCall: boolean;
  onCall(c: Callback): void;
}) {
  const { t, i18n } = useTranslation();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const group = (c: Callback) => {
    const at = new Date(c.at).getTime();
    return at <= now ? 'overdue' : at <= endOfDay.getTime() ? 'today' : 'later';
  };
  const groups = (['overdue', 'today', 'later'] as const)
    .map((g) => ({ g, items: rows.filter((c) => group(c) === g) }))
    .filter((x) => x.items.length);
  const fmt = (at: Date, opts: Intl.DateTimeFormatOptions) =>
    at.toLocaleString(i18n.language, opts);

  return (
    <section aria-labelledby="calls-callbacks" className="flex flex-col gap-3">
      <h3 id="calls-callbacks" className="text-base font-bold">
        {t('cati.callbacks')}
      </h3>
      {!groups.length ? <p className="text-slate-600">{t('cati.noCallbacks')}</p> : null}
      <div className="flex flex-col gap-4" data-testid="callbacks">
        {groups.map(({ g, items }) => (
          <section key={g} aria-labelledby={`cb-${g}`} data-testid={`callbacks-${g}`}>
            <h4 id={`cb-${g}`} className="eyebrow mb-1.5">
              {t(`cati.callbacksGroup.${g}`)} · {items.length}
            </h4>
            <ul className="flex flex-col gap-2">
              {items.map((c) => {
                const at = new Date(c.at);
                const sameDay = at.toDateString() === new Date(now).toDateString();
                const when = fmt(
                  at,
                  sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
                );
                return (
                  <li
                    key={c.caseId}
                    data-case-id={c.caseId}
                    className={`flex flex-col gap-1 rounded-lg border bg-white p-3 shadow-sm ${
                      g === 'overdue' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <b className="text-navy">{c.externalId}</b>
                      <span className="rounded-full bg-indigo-50 px-2 text-xs font-semibold text-indigo-ink-700">
                        {t(`cati.kind.${c.kind}`)}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 text-xs font-semibold text-slate-700">
                        {c.mine
                          ? t('cati.forMeTag')
                          : c.forUserName
                            ? t('cati.forOther', { name: c.forUserName })
                            : t('cati.forAnyoneTag')}
                      </span>
                      {g === 'overdue' ? (
                        <span className="text-xs font-semibold text-amber-ink-900">
                          ({t('cati.due')})
                        </span>
                      ) : null}
                    </div>
                    <p className="tabular-nums">
                      {t('cati.yourTime', { time: when })}
                      <span className="block text-xs text-slate-600">
                        {t('cati.theirTime', {
                          time: fmt(at, {
                            timeZone: c.timezone,
                            weekday: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          }),
                          tz: c.timezone,
                        })}
                      </span>
                    </p>
                    {c.bookedBy || c.note ? (
                      <p className="text-xs text-slate-600">
                        {c.bookedBy ? t('cati.bookedBy', { name: c.bookedBy }) : null}
                        {c.note ? <span className="block italic">“{c.note}”</span> : null}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-on-fill hover:bg-indigo-500 disabled:bg-slate-200 disabled:text-slate-600"
                        disabled={!canCall || !c.callableNow}
                        aria-label={t('cati.callNowCase', { id: c.externalId })}
                        onClick={() => onCall(c)}
                      >
                        <PhoneIcon className="h-3.5 w-3.5" />
                        {t('cati.callNow')}
                      </button>
                      {!c.callableNow && c.reason ? (
                        <span className="text-xs text-slate-600">
                          {t(`cati.notCallable.${c.reason}`, { defaultValue: c.reason })}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

/** Past calls of a case (the case drawer and the calls workspace). */
export function CallList({ rows }: { rows: CallRow[] }) {
  const { t, i18n } = useTranslation();
  if (!rows.length) return <p className="text-slate-600">{t('cati.noHistory')}</p>;
  return (
    <ul className="flex flex-col gap-1" data-testid="call-history">
      {rows.map((r) => (
        <li key={r.id}>
          {t('cati.historyRow', {
            when: new Date(r.startedAt).toLocaleString(i18n.language, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
            outcome: r.outcome ? t(`cati.outcomes.${r.outcome}`) : '—',
            who: r.interviewer ?? '—',
          })}
          {r.numberMasked ? (
            <>
              {' · '}
              <span className="font-mono text-slate-600">{r.numberMasked}</span>
            </>
          ) : null}
          {r.note ? <span className="block text-slate-600">“{r.note}”</span> : null}
        </li>
      ))}
    </ul>
  );
}
