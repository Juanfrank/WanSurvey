import { useNavigate, useParams } from '@tanstack/react-router';
import { own, type InterviewSession } from '@wansurvey/logic';
import { InterviewRunner, ScriptBox } from '@wansurvey/renderer';
import { DEFAULT_SHORTCUTS, type LocalizedText } from '@wansurvey/schema';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../designer/Dialog.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';
import { api } from '../api.js';
import type { ReviewComment } from '../review/ReviewPage.js';
import { useInterview, type SaveState } from './useInterview.js';

const MASK = '•••';

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${h}:` : ''}${pad(m)}:${pad(s % 60)}`;
}

function shown(v: unknown, session: InterviewSession, name: string): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object' && v && '$special' in v)
    return session.specialLabel((v as { $special: 'DK' }).$special);
  if (typeof v === 'number' || typeof v === 'string') return session.labelOf(name, v) ?? String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object'))
    return v.map((x) => session.labelOf(name, x as string) ?? String(x)).join(', ');
  return JSON.stringify(v);
}

interface SectionInfo {
  id: string;
  title: string;
  first: string | null;
  status: 'done' | 'visited' | 'locked' | 'current';
}

/** Sections on the path with how far the interview got in each. */
function sectionsOf(session: InterviewSession, lang: string): SectionInfo[] {
  const trace = session.trace();
  const visited = new Set(session.state().visited);
  const current = session.currentKey();
  const out: SectionInfo[] = [];
  let sec: SectionInfo | null = null;
  let questions: string[] = [];
  const close = () => {
    if (!sec) return;
    const answered = questions.every((k) => {
      const a = session.getAnswer(k);
      return a !== null && a !== undefined;
    });
    if (questions.includes(current ?? '')) sec.status = 'current';
    else if (questions.length && answered && questions.every((k) => visited.has(k)))
      sec.status = 'done';
    else if (questions.some((k) => visited.has(k))) sec.status = 'visited';
    out.push(sec);
  };
  for (const e of trace) {
    if (e.kind === 'section' && e.depth === 0) {
      close();
      const def = session.compiled.nodes[own(session.compiled.byId, e.id)!]!.def as {
        title?: LocalizedText;
      };
      sec = { id: e.id, title: def.title?.[lang] || e.id, first: null, status: 'locked' };
      questions = [];
    } else if (sec && e.status === 'active' && (e.kind === 'question' || e.kind === 'static')) {
      sec.first ??= e.key;
      if (e.kind === 'question') questions.push(e.key);
    }
  }
  close();
  return out;
}

/**
 * The shared interviewer screen (CATI, CAPI, PAPI entry): case and timing in the header, case
 * details and a section navigator at the side, the questionnaire in the middle, and notes,
 * pause, suspend and submit at the bottom. Everything works from the keyboard.
 */
export function InterviewPage() {
  const { projectId, interviewId } = useParams({ strict: false }) as {
    projectId: string;
    interviewId: string;
  };
  const { t } = useTranslation();
  const navigate = useNavigate();
  const iv = useInterview(interviewId);
  const [side, setSide] = useState(true);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [help, setHelp] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [, setNow] = useState(0);
  const navRef = useRef<HTMLOListElement>(null);

  // Clocks in the header.
  useEffect(() => {
    const timer = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (iv.error) return <p role="alert">{t('interview.failed')}</p>;
  const { payload, session } = iv;
  if (!payload || !session) return <p aria-busy="true">{t('interview.loading')}</p>;

  const lang = session.state().language;
  const languages = payload.compiled.questionnaire.languages;
  const finished = session.status().state !== 'in_progress';
  const paused = !!iv.clock?.paused;
  const sections = sectionsOf(session, lang);
  const answered = session
    .path()
    .filter((e) => e.kind === 'question')
    .map((e) => ({ key: e.key, value: session.getAnswer(e.key) }))
    .filter((a) => a.value !== null && a.value !== undefined);
  const caseData = payload.context.case ?? {};
  const name = ['first_name', 'last_name', 'nombre', 'apellido', 'name']
    .map((k) => caseData[k])
    .filter((v) => typeof v === 'string' && v && v !== MASK)
    .join(' ');

  // The project's shortcut keys (A11).
  const keys = payload.settings?.shortcuts ?? DEFAULT_SHORTCUTS;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Choice buttons are not typing: `?` on a radio still opens the help.
    const typing = (e.target as HTMLElement).closest(
      'textarea, select, input:not([type=radio]):not([type=checkbox])',
    );
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === keys.note) {
      e.preventDefault();
      setNoteOpen(true);
    } else if ((e.ctrlKey || e.metaKey) && k === keys.navigator) {
      e.preventDefault();
      setSide(true);
      requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>('button')?.focus());
    } else if ((e.ctrlKey || e.metaKey) && k === keys.pause) {
      e.preventDefault();
      if (paused) iv.resume();
      else iv.pause();
    } else if (e.key === '?' && !typing) {
      e.preventDefault();
      setHelp(true);
    }
  };

  /**
   * Back to the project; telephone interviews go back to the calls workspace, and interviews
   * of cases downloaded to this device go back to the device page.
   */
  const leave = (done = false, queued = false) =>
    iv.onDevice
      ? navigate({
          to: '/projects/$projectId/device',
          params: { projectId },
          search: queued ? { notice: 'queued' } : {},
        })
      : payload.interview.mode === 'PAPI'
        ? navigate({
            to: '/projects/$projectId',
            params: { projectId },
            search: { tab: 'paper', ...(done ? { notice: 'entry_done' } : {}) },
          })
        : payload.interview.mode === 'CATI'
          ? navigate({
              to: '/projects/$projectId',
              params: { projectId },
              search: { tab: 'calls', ...(done ? { notice: 'interview_done' } : {}) },
            })
          : navigate({ to: '/projects/$projectId', params: { projectId } });

  const submit = async () => {
    setSubmitting(true);
    setMessage('');
    try {
      const r = await iv.submit();
      await leave(true, r.status === 'queued');
    } catch (e) {
      setMessage(localiseError(t, e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <h1 className="text-lg font-semibold">
          {t('interview.case', { id: payload.context.externalId ?? '' })}
          {name ? <span className="ml-2 font-normal text-slate-700">{name}</span> : null}
        </h1>
        {payload.interview.interviewer ? (
          <span className="text-sm text-slate-600">
            {t('interview.interviewer', { name: payload.interview.interviewer })}
          </span>
        ) : null}
        <dl className="flex gap-4 text-sm">
          <div>
            <dt className="text-xs text-slate-600">{t('interview.elapsed')}</dt>
            <dd className="font-mono" data-testid="elapsed">
              {clock(iv.clock?.activeMs() ?? 0)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-600">{t('interview.onQuestion')}</dt>
            <dd className="font-mono">{clock(iv.clock?.onQuestionMs() ?? 0)}</dd>
          </div>
        </dl>
        {languages.length > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span>{t('interview.language')}</span>
            <select
              className="rounded-md border border-slate-300 px-2 py-1"
              value={lang}
              onChange={(e) => iv.setLanguage(e.target.value)}
            >
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {payload.offline ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-ink-900">
            {t('device.offlineCopy')}
          </span>
        ) : null}
        {payload.settings?.capi?.gps === 'start_end' && payload.interview.mode === 'CAPI' ? (
          <span className="text-xs text-slate-600" title={payload.settings.capi.gpsNotice}>
            {t('device.gpsOn')}
          </span>
        ) : null}
        <SaveBadge state={iv.save} />
      </header>
      {payload.interview.status === 'returned' ? (
        <ReturnedComments interviewId={interviewId} />
      ) : null}
      {payload.interview.mode === 'PAPI' ? (
        <PaperMeta
          second={payload.interview.entryPass === 2}
          onSave={(meta) => iv.paperMeta(meta)}
        />
      ) : null}
      {iv.problem ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-ink-900">
          {t(`interview.problem.${iv.problem}`, { defaultValue: iv.problem })}
        </p>
      ) : null}
      {iv.lowSpace ? (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900">
          {t('interview.lowSpace')}
        </p>
      ) : null}

      <div className={`grid gap-4 ${side ? 'lg:grid-cols-[18rem_minmax(0,1fr)]' : ''}`}>
        {side ? (
          <aside
            aria-label={t('interview.side')}
            className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm"
          >
            <section aria-labelledby="iv-sections">
              <h2 id="iv-sections" className="mb-1 font-semibold">
                {t('interview.sections')}
              </h2>
              <ol ref={navRef} className="flex flex-col gap-1" data-testid="section-nav">
                {sections.map((s) => {
                  const can = !!s.first && s.status !== 'locked' && session.canJumpTo(s.first);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        disabled={!can || paused}
                        aria-current={s.status === 'current' ? 'step' : undefined}
                        className="flex w-full justify-between gap-2 rounded px-2 py-1 text-left hover:bg-indigo-50 disabled:text-slate-500 aria-[current=step]:bg-indigo-100"
                        onClick={() => {
                          session.jumpTo(s.first!);
                          iv.onChange();
                        }}
                      >
                        <span>{s.title}</span>
                        <span className="text-xs">{t(`interview.section.${s.status}`)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
            <section aria-labelledby="iv-sample">
              <h2 id="iv-sample" className="mb-1 font-semibold">
                {t('interview.sample')}
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {Object.entries(caseData).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-slate-600">{k}</dt>
                    <dd>{v === null || v === undefined ? '—' : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {payload.context.contacts?.length ? (
              <section aria-labelledby="iv-contacts">
                <h2 id="iv-contacts" className="mb-1 font-semibold">
                  {t('interview.contacts')}
                </h2>
                <ul>
                  {payload.context.contacts.map((c, i) => (
                    <li key={i}>
                      <span className="text-slate-600">{c.label ?? c.type}:</span> {c.value}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section aria-labelledby="iv-answers">
              <h2 id="iv-answers" className="mb-1 font-semibold">
                {t('interview.answers')}
              </h2>
              {answered.length ? (
                <dl
                  className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
                  data-testid="answers-so-far"
                >
                  {answered.map((a) => (
                    <div key={a.key} className="contents">
                      <dt className="font-mono text-slate-600">{a.key}</dt>
                      <dd>
                        {shown(a.value, session, a.key.replace(/\[.*$/, '').split('.').pop()!)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-slate-600">{t('interview.noAnswers')}</p>
              )}
            </section>
          </aside>
        ) : null}

        <section
          aria-label={t('interview.title', { id: payload.context.externalId ?? '' })}
          className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          {paused ? (
            <div className="flex flex-col items-start gap-3" data-testid="paused">
              <p role="status">{t('interview.paused')}</p>
              <Button type="button" onClick={iv.resume}>
                {t('interview.resume')}
              </Button>
            </div>
          ) : (
            <InterviewRunner
              session={session}
              mode={payload.interview.mode}
              lang={lang}
              onChange={iv.onChange}
              specialKeys={{ DK: keys.dontKnow, RF: keys.refused }}
            />
          )}
          {finished ? (
            <div className="mt-4 flex flex-col items-start gap-2 border-t border-slate-200 pt-4">
              <ScriptBox scripts={session.scriptsFor({ at: 'end' })} />
              <p>{t('interview.ready')}</p>
              <Button type="button" disabled={submitting} onClick={() => void submit()}>
                {t('interview.submit')}
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-2">
        <button type="button" className={smallBtn} onClick={() => setSide((s) => !s)}>
          {side ? t('interview.hideSide') : t('interview.showSide')}
        </button>
        <button
          type="button"
          className={smallBtn}
          onClick={() => setNoteOpen(true)}
          aria-keyshortcuts="Control+M"
        >
          {t('interview.note')}
        </button>
        <button
          type="button"
          className={smallBtn}
          onClick={paused ? iv.resume : iv.pause}
          aria-keyshortcuts="Control+P"
        >
          {paused ? t('interview.resume') : t('interview.pause')}
        </button>
        <button
          type="button"
          className={smallBtn}
          onClick={async () => {
            await iv.sync({ force: true });
            await leave();
          }}
        >
          {t('interview.suspend')}
        </button>
        <button
          type="button"
          className={smallBtn}
          onClick={() => setHelp(true)}
          aria-keyshortcuts="?"
        >
          {t('interview.help')}
        </button>
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      </footer>

      {noteOpen ? (
        <Dialog
          title={t('interview.noteTitle', { key: session.currentKey() ?? '' })}
          onClose={() => setNoteOpen(false)}
        >
          <form
            className="flex flex-col gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!noteText.trim()) return;
              iv.note(noteText.trim());
              setNoteText('');
              setNoteOpen(false);
              setMessage(t('interview.noteAdded'));
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('interview.noteText')}</span>
              <textarea
                className={`${inputCls} min-h-[5rem]`}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setNoteOpen(false)}>
                {t('interview.close')}
              </Button>
              <Button type="submit" disabled={!noteText.trim()}>
                {t('interview.noteSave')}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {help ? (
        <Dialog title={t('interview.help')} onClose={() => setHelp(false)}>
          <ul className="flex flex-col gap-1 text-sm" data-testid="shortcuts">
            {(['next', 'back', 'codes', 'special', 'note', 'goTo', 'pause', 'help'] as const).map(
              (k) => (
                <li key={k}>
                  {t(`interview.keys.${k}`, {
                    dk: keys.dontKnow,
                    rf: keys.refused,
                    note: keys.note.toUpperCase(),
                    nav: keys.navigator.toUpperCase(),
                    pause: keys.pause.toUpperCase(),
                  })}
                </li>
              ),
            )}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button type="button" onClick={() => setHelp(false)}>
              {t('interview.close')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  const cls: Record<SaveState, string> = {
    saved: 'text-emerald-ink-800',
    saving: 'text-slate-600',
    local: 'text-amber-ink-800',
    error: 'text-red-ink-800',
  };
  return (
    <span
      role="status"
      aria-live="polite"
      className={`ml-auto text-sm font-medium ${cls[state]}`}
      data-testid="save-status"
      data-status={state}
    >
      {t(`interview.save.${state}`)}
    </span>
  );
}

/** The date and duration written on the paper form, recorded as paradata (P4). */
function PaperMeta({
  second,
  onSave,
}: {
  second: boolean;
  onSave(meta: { date: string | null; minutes: number | null }): void;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [minutes, setMinutes] = useState('');
  const save = (d: string, m: string) =>
    onSave({ date: d || null, minutes: m ? Math.max(0, Math.round(Number(m))) : null });
  return (
    <section
      aria-label={t('papi.meta.title')}
      className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm"
      data-testid="paper-meta"
    >
      {second ? (
        <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-ink-900">
          {t('papi.meta.second')}
        </span>
      ) : null}
      <label className="flex flex-col gap-1">
        <span>{t('papi.meta.date')}</span>
        <input
          type="date"
          className="rounded-md border border-slate-300 px-2 py-1"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onBlur={() => save(date, minutes)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>{t('papi.meta.minutes')}</span>
        <input
          type="number"
          min={0}
          max={600}
          className="w-24 rounded-md border border-slate-300 px-2 py-1"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={() => save(date, minutes)}
        />
      </label>
    </section>
  );
}

/** What the reviewer asked to fix, beside the interview being corrected (R1). */
function ReturnedComments({ interviewId }: { interviewId: string }) {
  const { t } = useTranslation();
  const [comments, setComments] = useState<ReviewComment[]>([]);
  useEffect(() => {
    void api<{ comments: ReviewComment[] }>(`/review/interviews/${interviewId}`).then(
      (d) => setComments(d.comments),
      () => setComments([]),
    );
  }, [interviewId]);
  if (!comments.length) return null;
  return (
    <section
      aria-label={t('review.returned.comments')}
      className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm"
      data-testid="returned-comments"
    >
      <h2 className="mb-1 font-semibold">{t('review.returned.comments')}</h2>
      <ul className="flex flex-col gap-1">
        {comments.map((c) => (
          <li key={c.id}>
            {c.variable ? <span className="mr-1 font-mono text-xs">{c.variable}</span> : null}
            {c.body} <span className="text-xs text-slate-600">— {c.author}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
