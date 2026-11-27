import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ScriptBox } from '@wansurvey/renderer';
import {
  CALL_OUTCOMES,
  needsCallbackTime,
  utcToZoned,
  withinHours,
  zonedToUtc,
  exitReasonLabel,
  type CallOutcome,
  type ExitReason,
} from '@wansurvey/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiFull } from '../api.js';
import { dateTime, number } from '../format.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
import { deviceId, keepOnDevice, type InterviewPayload } from '../interview/useInterview.js';
import { PhoneIcon } from '../routes/icons.js';
import { CallbackReminders } from '../routes/Notifications.js';
import { SideDrawer, useDrawer } from '../routes/SideDrawer.js';
import { Button } from '../routes/ui.js';
import {
  allDay,
  fromNow,
  groupOutcomes,
  keyIndex,
  longWhen,
  outcomeKey,
  phoneKind,
  startOfDay,
  type OutcomeGroup,
} from './calls-logic.js';

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
    /** Labels of the sample fields that have one. */
    fieldLabels?: Record<string, string>;
  };
  phones: { id: string; value: string; label: string | null }[];
  history: CallRow[];
  callingHours: { from: string; to: string };
  earlyExit: { reasons: ExitReason[]; required: boolean };
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
  /** The caller made this one the next to call. */
  pinned: boolean;
  forUserName: string | null;
  timezone: string;
  kind: 'callback' | 'appointment';
  bookedBy: string | null;
  note: string | null;
  attempts: number;
  callableNow: boolean;
  reason: string | null;
}

interface Shift {
  calls: number;
  contacts: number;
  completes: number;
  talkMs: number;
}

/** How each group of outcomes looks: answered stands out, the final ones read as such. */
const GROUP_CLS: Record<OutcomeGroup, string> = {
  reached:
    'border-indigo-300 bg-indigo-50/60 font-semibold has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-100',
  notReached: 'border-slate-200 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50',
  reschedule: 'border-slate-200 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50',
  final: 'border-red-200 bg-red-50/40 has-[:checked]:border-red-600 has-[:checked]:bg-red-50',
};

/**
 * Outcomes an answered call can still end with, when its interview stopped early (in the order
 * their groups are shown, so the keys read 1–4).
 */
const INTERRUPTED: CallOutcome[] = ['refusal', 'do_not_contact', 'callback', 'appointment'];

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
 * callbacks are booked in the respondent's time zone. Keyboard-first: N, Alt+1–3, 1–9 and 0
 * (the tenth outcome), and Ctrl+Enter.
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
  /** A new case has been asked for and has not come yet. */
  const [seeking, setSeeking] = useState(false);
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
  const [exitReason, setExitReason] = useState('');
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

  // The caller's day so far, shown while no case is open.
  const since = startOfDay(now).toISOString();
  const shift = useQuery({
    queryKey: ['cati-shift', projectId, since],
    queryFn: () =>
      api<Shift>(`/projects/${projectId}/cati/shift?since=${encodeURIComponent(since)}`),
    enabled: !served,
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
    setExitReason('');
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
      if (!current) {
        setMessage('');
        setIdle(null);
        setSeeking(true);
      }
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
        setSeeking(false);
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
  const anyHour = allDay(hours);
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
  const exitMissing = interrupted && !!served?.earlyExit.required && !exitReason;
  const canSave =
    !!served &&
    !!outcome &&
    !busy &&
    !callbackProblem &&
    !exitMissing &&
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
        ...(interrupted && exitReason ? { exitReason } : {}),
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
                time: dateTime(r.nextContactAt),
              })
            : t('cati.saved', { outcome: label }),
      );
      setServed(null);
      setIdle(null);
      reset();
      void qc.invalidateQueries({ queryKey: ['cati-callbacks', projectId] });
      void qc.invalidateQueries({ queryKey: ['cati-shift', projectId] });
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
    exitReason,
    interrupted,
    qid,
    navigate,
    projectId,
    t,
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
      } else if (served && keyIndex(e.key) >= 0) {
        const o = choices[keyIndex(e.key)];
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
          <p className="text-sm text-slate-700">{t('cati.shortcuts')}</p>
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
        {!served && seeking ? (
          <p className="text-slate-700" data-testid="queue-loading">
            {t('cati.loading')}
          </p>
        ) : null}
        {!served && idle ? (
          <p className="text-slate-700" data-testid="queue-empty">
            {t(`cati.reason.${idle.reason}`, { defaultValue: t('cati.reason.empty') })}{' '}
            {idle.nextAt
              ? t('cati.nextCallback', {
                  time: dateTime(idle.nextAt),
                })
              : null}
          </p>
        ) : null}
        {!served && shift.data ? <ShiftSummary shift={shift.data} /> : null}

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
              {served.phones.map((p, i) => {
                const kind = phoneKind(p.label);
                return (
                  <div key={p.id} className="flex items-stretch gap-1.5" data-testid="phone">
                    <label className="flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50">
                      <input
                        type="radio"
                        name="phone"
                        checked={phone === i}
                        onChange={() => setPhone(i)}
                        aria-keyshortcuts={i < 3 ? `Alt+${i + 1}` : undefined}
                      />
                      <span className="font-mono">{p.value}</span>
                      {p.label ? (
                        <span className="text-slate-600">
                          {kind ? t(`cati.phoneKind.${kind}`) : p.label}
                        </span>
                      ) : null}
                      {i < 3 ? (
                        <kbd className="text-xs text-slate-600">
                          {t('cati.phoneKey', { n: i + 1 })}
                        </kbd>
                      ) : null}
                    </label>
                    <a
                      href={`tel:${p.value}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 text-sm font-semibold text-on-fill hover:bg-indigo-500"
                      aria-label={t('cati.dial', { number: p.value })}
                    >
                      <PhoneIcon className="h-4 w-4" />
                      {t('cati.dialShort')}
                    </a>
                  </div>
                );
              })}
            </fieldset>

            <section aria-labelledby="calls-sample" className="text-sm">
              <h4 id="calls-sample" className="mb-1 font-semibold">
                {t('cati.sample')}
              </h4>
              <dl className="flex flex-wrap gap-x-5 gap-y-1" data-testid="case-sample">
                {Object.entries(served.case.sample).map(([k, v]) => {
                  const label = served.case.fieldLabels?.[k];
                  return (
                    <div key={k} className="flex gap-1.5">
                      <dt className={label ? 'text-slate-600' : 'font-mono text-slate-600'}>
                        {label ?? k}
                      </dt>
                      <dd className="font-medium">
                        {v === null || v === undefined ? '—' : String(v)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>

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
                {served.earlyExit.reasons.length ? (
                  <label className="flex flex-col gap-1">
                    <span className="font-medium">
                      {t('cati.exitReason')}
                      {served.earlyExit.required ? ' *' : ''}
                    </span>
                    <select
                      className={controlCls}
                      value={exitReason}
                      required={served.earlyExit.required}
                      onChange={(e) => setExitReason(e.target.value)}
                      data-testid="exit-reason"
                    >
                      <option value="">{t('cati.exitReasonPick')}</option>
                      {served.earlyExit.reasons.map((r) => (
                        <option key={r.code} value={r.code}>
                          {exitReasonLabel(r, i18n.resolvedLanguage ?? 'es')}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : served.scripts?.intro.length ? (
              <ScriptBox scripts={served.scripts.intro} />
            ) : null}

            <fieldset ref={outcomeRef} className="flex flex-col gap-2" data-testid="outcomes">
              <legend className="mb-1 text-sm font-medium">{t('cati.outcome')}</legend>
              {groupOutcomes(choices).map((g) => (
                <div
                  key={g.id}
                  role="group"
                  aria-labelledby={`outcomes-${g.id}`}
                  data-group={g.id}
                  className="flex flex-col gap-1"
                >
                  <span
                    id={`outcomes-${g.id}`}
                    className={`text-xs font-semibold ${g.id === 'final' ? 'text-red-ink-800' : 'text-slate-600'}`}
                  >
                    {t(`cati.outcomeGroup.${g.id}`)}
                  </span>
                  <div
                    className={
                      g.id === 'reached' ? 'grid gap-1' : 'grid gap-1 sm:grid-cols-2 lg:grid-cols-4'
                    }
                  >
                    {g.outcomes.map((o) => {
                      const key = outcomeKey(choices.indexOf(o));
                      return (
                        <label
                          key={o}
                          className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${GROUP_CLS[g.id]}`}
                        >
                          <input
                            type="radio"
                            name="outcome"
                            value={o}
                            checked={outcome === o}
                            onChange={() => choose(o)}
                            aria-keyshortcuts={key ?? undefined}
                          />
                          {key ? <kbd className="w-4 text-xs text-slate-600">{key}</kbd> : null}
                          {t(`cati.outcomes.${o}`)}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </fieldset>

            {outcome && served.scripts?.outcomes[outcome]?.length ? (
              <ScriptBox scripts={served.scripts.outcomes[outcome]!} />
            ) : null}

            {outcome === 'do_not_contact' ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm" role="note">
                {t('cati.doNotContactHint')}
              </p>
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
                    aria-describedby="callback-when callback-hours callback-problem"
                    aria-invalid={callbackProblem ? true : undefined}
                  />
                </label>
                <p
                  id="callback-when"
                  className="empty:hidden font-medium"
                  aria-live="polite"
                  data-testid="callback-when"
                >
                  {callbackDate && !Number.isNaN(callbackDate.getTime())
                    ? t('cati.callbackWhen', {
                        when: longWhen(callbackDate, tz, i18n.language),
                        rel: fromNow(callbackDate, now, i18n.language),
                      })
                    : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => setCallback(localAt(tz, { minutes: 60 }))}
                  >
                    {t('cati.inHour')}
                  </button>
                  {[anyHour ? '10:00' : hours.from, '18:00'].map((hhmm) => (
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
                  {anyHour ? t('cati.callbackAnyHour') : t('cati.callbackHours', hours)}
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
              <Button
                type="submit"
                disabled={!canSave}
                aria-keyshortcuts="Control+Enter"
                aria-describedby="save-why"
              >
                {outcome === 'answered' ? t('cati.start') : t('cati.save')}{' '}
                <kbd className="ml-1 text-xs opacity-80">{t('cati.saveKey')}</kbd>
              </Button>
              {!interrupted ? (
                <button type="button" className={smallBtn} onClick={() => void skip()}>
                  {t('cati.skip')}
                </button>
              ) : null}
              <span id="save-why" className="empty:hidden text-sm text-slate-600">
                {!outcome
                  ? t('cati.why.outcome')
                  : callbackProblem === 'none'
                    ? t('cati.why.time')
                    : callbackProblem
                      ? t('cati.why.fixTime')
                      : exitMissing
                        ? t('cati.why.exit')
                        : outcome === 'answered' && !qid && !served.questionnaireId
                          ? t('cati.why.questionnaire')
                          : ''}
              </span>
            </div>

            <section aria-labelledby="calls-history" className="text-sm">
              <h4 id="calls-history" className="mb-1 font-semibold">
                {t('cati.history')}
              </h4>
              <CallList rows={served.history.filter((h) => h.id !== served.attempt.id)} />
            </section>
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
        <CallbackReminders />
        <Callbacks
          rows={callbacks.data ?? []}
          now={now}
          canCall={!served && !busy}
          onCall={(c) => {
            drawer.setOpen(false);
            void next(false, c.caseId);
          }}
          onPin={async (c) => {
            try {
              await api(`/projects/${projectId}/cati/callbacks/${c.caseId}/pin`, {
                method: c.pinned ? 'DELETE' : 'POST',
              });
              await qc.invalidateQueries({ queryKey: ['cati-callbacks', projectId] });
            } catch (e) {
              setMessage(localiseError(t, e));
            }
          }}
        />
      </SideDrawer>
    </div>
  );
}

/** The caller's day so far: calls, contacts (and the contact rate), completes, time on the phone. */
function ShiftSummary({ shift }: { shift: Shift }) {
  const { t } = useTranslation();
  const mins = Math.round(shift.talkMs / 60_000);
  const rate = shift.calls ? Math.round((shift.contacts / shift.calls) * 100) : null;
  const items = [
    ['calls', number(shift.calls)],
    [
      'contacts',
      rate === null ? number(shift.contacts) : `${number(shift.contacts)} (${number(rate)} %)`,
    ],
    ['completes', number(shift.completes)],
    ['talk', t('cati.shift.minutes', { count: mins, n: number(mins) })],
  ] as const;
  return (
    <section
      aria-labelledby="calls-shift"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      data-testid="shift-summary"
    >
      <h3 id="calls-shift" className="eyebrow mb-2">
        {t('cati.shift.title')}
      </h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-slate-600">{t(`cati.shift.${k}`)}</dt>
            <dd className="text-xl font-semibold tabular-nums text-navy">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
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
  onPin,
}: {
  rows: Callback[];
  now: number;
  canCall: boolean;
  onCall(c: Callback): void;
  onPin(c: Callback): void | Promise<void>;
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
                      {c.pinned ? (
                        <span className="rounded-full bg-indigo-600 px-2 text-xs font-semibold text-on-fill">
                          {t('cati.pinnedTag')}
                        </span>
                      ) : null}
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
                      <button
                        type="button"
                        className={smallBtn}
                        aria-pressed={c.pinned}
                        aria-label={t(c.pinned ? 'cati.unpinCase' : 'cati.pinCase', {
                          id: c.externalId,
                        })}
                        onClick={() => void onPin(c)}
                      >
                        {t(c.pinned ? 'cati.unpin' : 'cati.pin')}
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
