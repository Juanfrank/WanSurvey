import { own, type ChangeResult, type InterviewSession, type TraceEntry } from '@wansurvey/logic';
import type { AnswerValue, Mode, Question, Roster, SpecialKind } from '@wansurvey/schema';
import {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { RENDERER_NS } from './i18n.js';
import { isTypingTarget, matchTypedCode, TYPED_CODE_TIMEOUT_MS } from './keyboard.js';
import { QuestionView } from './QuestionView.js';
import { pick } from './text.js';
import { ScriptBox, scriptsAt } from './scripts.js';

export interface InterviewRunnerProps {
  session: InterviewSession;
  mode: Mode;
  lang: string;
  /** Called after every change, so a host (e.g. the path tracer) can re-render. */
  onChange?(): void;
  /** Respondent page grouping; defaults to one question per page on narrow screens. */
  layout?: 'item' | 'page';
  /** Force the narrow (phone) layout; detected from the viewport otherwise. */
  narrow?: boolean;
  /** Keys for don't know and refused (a project setting); F7 and F8 by default. */
  specialKeys?: SpecialKeys;
}

export interface SpecialKeys {
  DK: string;
  RF: string;
}
export const DEFAULT_SPECIAL_KEYS: SpecialKeys = { DK: 'F7', RF: 'F8' };

function useNarrow(force?: boolean): boolean {
  const query = '(max-width: 640px)';
  const get = () =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return force ?? narrow;
}

/** Pages for respondent mode: path items grouped until a page break or a new section. */
function buildPages(session: InterviewSession): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) pages.push(current);
    current = [];
  };
  for (const e of session.trace()) {
    if (e.status !== 'active') continue;
    if (e.kind === 'pagebreak' || (e.kind === 'section' && e.depth === 0)) flush();
    else if (e.kind === 'question' || e.kind === 'static') current.push(e.key);
  }
  flush();
  return pages;
}

/** Open rosters ("add another") that end just before `key` on the path. */
function openRostersBefore(session: InterviewSession, key: string | null): TraceEntry[] {
  const trace = session.trace().filter((e) => e.status === 'active');
  const out: TraceEntry[] = [];
  trace.forEach((e, i) => {
    if (e.kind !== 'roster') return;
    const node = session.compiled.nodes[own(session.compiled.byId, e.id)!]!;
    const r = node.def as Roster;
    if (r.count.type !== 'open') return;
    const rows = session.getAnswer(e.key);
    if (Array.isArray(rows) && rows.length >= (r.count.max ?? 100)) return;
    // First navigable item after the roster's subtree.
    const after = trace
      .slice(i + 1)
      .find(
        (x) =>
          (x.kind === 'question' || x.kind === 'static') &&
          !x.frames.some((f) => f.name === r.name),
      );
    if ((after?.key ?? null) === key) out.push(e);
  });
  return out;
}

/**
 * Runs an interview for one mode: one question per screen for interviewers, pages for
 * respondents. Keyboard: digits pick codes, Enter = next, Shift+Enter / Alt+← = back, F7/F8 = DK/RF
 * (or the project's keys).
 */
export function InterviewRunner(p: InterviewRunnerProps) {
  const { i18n } = useTranslation(RENDERER_NS);
  // Respondents (CAWI) see buttons and messages in the questionnaire's language; interviewers
  // keep the interface language they chose.
  const respondentI18n = useMemo(() => {
    if (p.mode !== 'CAWI') return null;
    const clone = i18n.cloneInstance({ lng: p.lang, initAsync: false });
    void clone.changeLanguage(p.lang);
    return clone;
  }, [i18n, p.mode, p.lang]);
  if (respondentI18n)
    return (
      <I18nextProvider i18n={respondentI18n}>
        <Runner {...p} />
      </I18nextProvider>
    );
  return <Runner {...p} />;
}

function Runner(p: InterviewRunnerProps) {
  const { t } = useTranslation(RENDERER_NS);
  const { session } = p;
  const [, setRev] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const typed = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timer: null,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(p.narrow);
  const respondent = p.mode === 'CAWI';
  const layout = p.layout ?? (respondent && !narrow ? 'page' : 'item');

  const refresh = useCallback(() => {
    setRev((r) => r + 1);
    p.onChange?.();
  }, [p.onChange]);

  const announce = useCallback(
    (r: ChangeResult) => {
      if (!r.ok) {
        setAlert(t('question.shapeError', { error: r.error }));
        return;
      }
      const parts: string[] = [];
      if (r.cleared.length)
        parts.push(
          t('notice.cleared', {
            count: r.cleared.length,
            keys: r.cleared.map((c) => c.key).join(', '),
          }),
        );
      if (r.restored.length)
        parts.push(
          t('notice.restored', {
            count: r.restored.length,
            keys: r.restored.map((c) => c.key).join(', '),
          }),
        );
      setNotice(parts.length ? parts.join(' ') : null);
    },
    [t],
  );

  const answer = useCallback(
    (key: string, value: AnswerValue) => {
      const r = session.setAnswer(key, value, respondent ? 'respondent' : 'interviewer');
      announce(r);
      refresh();
    },
    [session, respondent, announce, refresh],
  );

  const special = useCallback(
    (key: string, kind: SpecialKind | null) => {
      const r = kind ? session.setSpecial(key, kind) : session.clearAnswer(key);
      announce(r);
      refresh();
    },
    [session, announce, refresh],
  );

  const revert = useCallback(
    (key: string) => {
      const r = session.revertToPrefill(key, respondent ? 'respondent' : 'interviewer');
      announce(r);
      refresh();
    },
    [session, respondent, announce, refresh],
  );

  const confirm = useCallback(
    (key: string, ruleId: string) => {
      session.confirmWarning(key, ruleId);
      refresh();
    },
    [session, refresh],
  );

  // Questionnaire wording follows the interface language (idempotent, so safe during render).
  if (session.language !== p.lang) session.setLanguage(p.lang);

  const status = session.status();
  const currentKey = session.currentKey();
  const pages = layout === 'page' ? buildPages(session) : [];
  const pageKeys =
    layout === 'page'
      ? (pages.find((pg) => currentKey !== null && pg.includes(currentKey)) ?? [])
      : [];
  const visibleKeys = layout === 'page' ? pageKeys : currentKey ? [currentKey] : [];
  const entries = visibleKeys
    .map((k) => session.trace().find((e) => e.key === k && e.status === 'active'))
    .filter((e): e is TraceEntry => !!e);

  const next = useCallback(() => {
    setAlert(null);
    const keys = layout === 'page' ? pageKeys : currentKey ? [currentKey] : [];
    for (let i = 0; i < Math.max(1, keys.length); i++) {
      const res = session.next();
      if (!res.ok) {
        setShowErrors(true);
        setAlert(t('notice.errors'));
        refresh();
        return;
      }
      if (res.done || (layout === 'page' && res.key && !keys.includes(res.key))) break;
    }
    setShowErrors(false);
    setNotice(null);
    refresh();
  }, [layout, pageKeys, currentKey, session, refresh, t]);

  const back = useCallback(() => {
    setAlert(null);
    setShowErrors(false);
    if (layout === 'page' && currentKey !== null) {
      const idx = pages.findIndex((pg) => pg.includes(currentKey));
      const target = idx > 0 ? pages[idx - 1]![0] : undefined;
      if (target) session.jumpTo(target);
      else session.prev();
    } else {
      session.prev();
    }
    refresh();
  }, [layout, currentKey, pages, session, refresh]);

  const addRow = useCallback(
    (roster: TraceEntry) => {
      const row = session.addRosterRow(roster.key);
      const node = session.compiled.nodes[own(session.compiled.byId, roster.id)!]!;
      const name = (node.def as Roster).name;
      const first = session
        .path()
        .find((e) => e.frames.some((f) => f.name === name && f.row === row));
      if (first) session.jumpTo(first.key);
      refresh();
    },
    [session, refresh],
  );

  // Focus the first control whenever the screen changes.
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(
      '[data-qbody] input:not([type=hidden]):not([disabled]), [data-qbody] select, [data-qbody] textarea, [data-qbody] button, [data-focus-first]',
    );
    // Static texts have no control: focus the item itself so keys still reach the runner.
    (el ?? containerRef.current?.querySelector<HTMLElement>('[data-qkey]'))?.focus();
  }, [currentKey, status.state]);

  const focusedKey = (target: EventTarget | null): string | null => {
    const el = target instanceof HTMLElement ? target.closest('[data-qkey]') : null;
    return el?.getAttribute('data-qkey') ?? visibleKeys[0] ?? null;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const keys = p.specialKeys ?? DEFAULT_SPECIAL_KEYS;
    if (e.key === keys.DK || e.key === keys.RF) {
      e.preventDefault();
      const kind = e.key === keys.DK ? 'DK' : 'RF';
      const key = focusedKey(target);
      if (key && session.optionsFor(key).special.includes(kind)) special(key, kind);
      return;
    }
    if ((e.key === 'Enter' && e.shiftKey) || (e.key === 'ArrowLeft' && e.altKey)) {
      e.preventDefault();
      back();
      return;
    }
    if (
      e.key === 'Enter' &&
      !(target instanceof HTMLTextAreaElement) &&
      !(target instanceof HTMLButtonElement)
    ) {
      e.preventDefault();
      next();
      return;
    }
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(target)) {
      const key = focusedKey(target);
      if (!key) return;
      const entry = session.trace().find((x) => x.key === key && x.status === 'active');
      if (!entry || entry.kind !== 'question') return;
      const q = session.compiled.nodes[own(session.compiled.byId, entry.id)!]!.def as Question;
      const codes =
        q.type === 'scale'
          ? (() => {
              const out: number[] = [];
              const s = q.scale!;
              if (s.style === 'slider') return out;
              for (let n = s.min; n <= s.max; n += s.step ?? 1) out.push(n);
              return out;
            })()
          : session.optionsFor(key).options.map((o) => o.code);
      if (!['single', 'yesno', 'multi', 'scale'].includes(q.type) || codes.length === 0) return;
      e.preventDefault();
      const state = typed.current;
      if (state.timer) clearTimeout(state.timer);
      state.buffer += e.key;
      const m = matchTypedCode(state.buffer, codes);
      if (m.code !== null) {
        if (q.type === 'multi') {
          const cur = session.getAnswer(key);
          const arr = Array.isArray(cur) ? (cur as (string | number)[]) : [];
          const has = arr.some((c) => String(c) === String(m.code));
          const opt = session
            .optionsFor(key)
            .options.find((o) => String(o.code) === String(m.code));
          const exclusive = new Set(
            session
              .optionsFor(key)
              .options.filter((o) => o.exclusive)
              .map((o) => String(o.code)),
          );
          const nextValue = has
            ? arr.filter((c) => String(c) !== String(m.code))
            : opt?.exclusive
              ? [m.code]
              : [...arr.filter((c) => !exclusive.has(String(c))), m.code];
          answer(key, nextValue);
        } else {
          answer(key, m.code);
        }
        const input = containerRef.current?.querySelector<HTMLInputElement>(
          `[data-qkey="${CSS.escape(key)}"] input[data-code="${CSS.escape(String(m.code))}"]`,
        );
        input?.focus();
      }
      state.timer = m.wait ? setTimeout(() => (state.buffer = ''), TYPED_CODE_TIMEOUT_MS) : null;
      if (!m.wait) state.buffer = '';
    }
  };

  const pendingRosters = openRostersBefore(session, currentKey);
  const finished = status.state !== 'in_progress';
  const percent = Math.round(status.progress * 100);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-6"
      onKeyDown={onKeyDown}
      data-mode={p.mode}
      data-testid="runner"
    >
      <div>
        <div className="flex justify-between text-sm text-slate-600">
          <span>{t('nav.progress')}</span>
          <span>{t('nav.progressValue', { percent })}</span>
        </div>
        <div
          role="progressbar"
          aria-label={t('nav.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200"
        >
          <div
            className="h-full bg-indigo-600 motion-safe:transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        className="empty:hidden rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-ink-900"
      >
        {notice}
      </div>
      <div
        role="alert"
        className="empty:hidden rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-ink-800"
      >
        {alert}
      </div>

      {finished ? (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-slate-200 bg-white p-6">
          <p className="text-lg font-medium" data-focus-first tabIndex={-1}>
            {respondent
              ? t('done.respondent')
              : status.state === 'ended'
                ? t('done.ended', { disposition: status.disposition })
                : t('done.complete')}
          </p>
          <button
            type="button"
            className="rounded-md border border-slate-300 px-4 py-2"
            onClick={back}
          >
            {t('done.reviewAnswers')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {!respondent && currentKey ? (
            <ScriptBox scripts={scriptsAt(session, currentKey)} />
          ) : null}
          {entries.map((entry) => (
            <QuestionView
              key={entry.key}
              session={session}
              entry={entry}
              mode={p.mode}
              lang={p.lang}
              onAnswer={answer}
              onSpecial={special}
              onConfirm={confirm}
              onRevertPrefill={revert}
              showAllErrors={showErrors}
              touch={respondent}
              specialKeys={p.specialKeys ?? DEFAULT_SPECIAL_KEYS}
            />
          ))}
        </div>
      )}

      {pendingRosters.length ? (
        <div className="flex flex-wrap gap-2">
          {pendingRosters.map((r) => {
            const def = session.compiled.nodes[own(session.compiled.byId, r.id)!]!.def as Roster;
            return (
              <button
                key={r.key}
                type="button"
                className="rounded-md border border-indigo-600 px-3 py-1.5 text-indigo-ink-700"
                onClick={() => addRow(r)}
              >
                {t('question.addRow')}
                {def.title ? `: ${pick(def.title, p.lang)}` : ''}
              </button>
            );
          })}
        </div>
      ) : null}

      {!finished ? (
        <div className="flex justify-between gap-3 border-t border-slate-200 pt-4">
          <button
            type="button"
            className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 disabled:opacity-40"
            onClick={back}
            disabled={session.path()[0]?.key === currentKey}
          >
            {t('nav.back')}
            <span className="ml-2 text-xs text-slate-500">{t('nav.backKey')}</span>
          </button>
          <button
            type="button"
            className="min-h-11 rounded-md bg-indigo-600 px-5 py-2 font-medium text-on-fill hover:bg-indigo-700"
            onClick={next}
          >
            {t('nav.next')}
            <span className="ml-2 text-xs text-on-fill/80">{t('nav.nextKey')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
