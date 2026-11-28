import { PaperMeta } from '../papi/PaperMeta.js';
import { ScanPanel } from '../papi/ScanPanel.js';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { own, type InterviewSession } from '@wansurvey/logic';
import { InterviewRunner, ScriptBox } from '@wansurvey/renderer';
import { DEFAULT_SHORTCUTS, type LocalizedText } from '@wansurvey/schema';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../designer/Dialog.js';
import { useCan } from '../designer/hooks.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';
import { api } from '../api.js';
import type { ReviewComment } from '../review/ReviewPage.js';
import { ago, AnswersSoFar, Contacts, SampleData } from './side.js';
import { useInterview, type SaveState } from './useInterview.js';

export { shown } from './side.js';

const MASK = '•••';

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${h}:` : ''}${pad(m)}:${pad(s % 60)}`;
}

interface SectionInfo {
  id: string;
  title: string;
  first: string | null;
  status: 'done' | 'visited' | 'locked' | 'current';
}

/** Sections on the path with how far the interview got in each. */
export function sectionsOf(session: InterviewSession, lang: string): SectionInfo[] {
  const trace = session.trace();
  const visited = new Set(session.state().visited);
  const current = session.currentKey();
  const out: SectionInfo[] = [];
  let sec: SectionInfo | null = null;
  let questions: string[] = [];
  /** Questions and texts: a section is current on its opening text too. */
  let items: string[] = [];
  const close = () => {
    if (!sec) return;
    const answered = questions.every((k) => {
      const a = session.getAnswer(k);
      return a !== null && a !== undefined;
    });
    if (items.includes(current ?? '')) sec.status = 'current';
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
      items = [];
    } else if (sec && e.status === 'active' && (e.kind === 'question' || e.kind === 'static')) {
      sec.first ??= e.key;
      items.push(e.key);
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
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const iv = useInterview(interviewId);
  // On a tablet or phone the question comes first; the case details open on demand.
  const [side, setSide] = useState(
    () => typeof window === 'undefined' || !window.matchMedia?.('(max-width: 1023px)').matches,
  );
  const [resumeSeen, setResumeSeen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [help, setHelp] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [, setNow] = useState(0);
  const navRef = useRef<HTMLOListElement>(null);
  // The project's name for the breadcrumb (usually cached from the project page).
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ name: string }>(`/projects/${projectId}`),
    retry: false,
  });
  const canCasesAll = useCan('cases.read_all', projectId);

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
  const visited = new Set(session.state().visited);
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
            search: {
              tab: 'paper',
              q: payload.interview.questionnaireId,
              ...(done ? { notice: 'entry_done' } : {}),
            },
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

  // Where the interview belongs (64): the device page, the paper forms or the calls it was
  // opened from, else the interviewer's cases.
  const parent: { label: string; to: string; search: Record<string, string> } = iv.onDevice
    ? { label: t('device.title'), to: '/projects/$projectId/device', search: {} }
    : payload.interview.mode === 'PAPI'
      ? {
          label: t('cases.tabs.paper'),
          to: '/projects/$projectId',
          search: { tab: 'paper', q: payload.interview.questionnaireId },
        }
      : payload.interview.mode === 'CATI'
        ? { label: t('cases.tabs.calls'), to: '/projects/$projectId', search: { tab: 'calls' } }
        : {
            label: canCasesAll ? t('cases.tabs.cases') : t('cases.list.mine'),
            to: '/projects/$projectId',
            search: { tab: 'cases' },
          };
  /** A breadcrumb link that first sends what is still on this device. */
  const crumb = (label: string, to: string, search: Record<string, string> = {}) => (
    <Link
      to={to}
      params={{ projectId }}
      search={search}
      // Only the case is the current page (a fuzzy match would mark every crumb as current).
      activeOptions={{ exact: true, includeSearch: true }}
      className="hover:underline"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        void iv
          .sync({ force: true })
          .finally(() => void navigate({ to, params: { projectId }, search }));
      }}
    >
      {label}
    </Link>
  );

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <nav aria-label={t('designer.breadcrumb')} className="text-sm text-slate-600">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>{crumb(t('designer.projects'), '/projects')}</li>
          {project.data ? (
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true">/</span>
              {crumb(project.data.name, '/projects/$projectId')}
            </li>
          ) : null}
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            {crumb(parent.label, parent.to, parent.search)}
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="font-medium text-slate-700">
              {payload.context.externalId ?? t('interview.case', { id: '' }).trim()}
            </span>
          </li>
        </ol>
      </nav>
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <h1 className="text-lg font-semibold">
          {t('interview.case', { id: payload.context.externalId ?? '' })}
          {name ? (
            <>
              {' '}
              <span className="ml-2 font-normal text-slate-700">{name}</span>
            </>
          ) : null}
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
        {iv.audio === 'recording' ? (
          <span className="flex items-center gap-2 text-xs" data-testid="recording">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-rose-600" />
            {t('interview.audio.recording')}
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50"
              onClick={() => void iv.stopRecording()}
            >
              {t('interview.audio.stop')}
            </button>
          </span>
        ) : null}
        <SaveBadge state={iv.save} />
      </header>
      {iv.audio === 'ask' ? (
        <Dialog title={t('interview.audio.title')} onClose={() => void iv.answerConsent(false)}>
          <div className="flex flex-col gap-4" data-testid="audio-consent">
            <p className="whitespace-pre-line">{payload.settings?.audio?.consentText}</p>
            <div className="flex gap-3">
              <Button onClick={() => void iv.answerConsent(true)}>
                {t('interview.audio.yes')}
              </Button>
              <Button variant="secondary" onClick={() => void iv.answerConsent(false)}>
                {t('interview.audio.no')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {payload.interview.status === 'returned' ? (
        <ReturnedComments
          interviewId={interviewId}
          onGoTo={
            paused
              ? undefined
              : (key) => {
                  if (!session.canJumpTo(key)) return false;
                  session.jumpTo(key);
                  iv.onChange();
                  return true;
                }
          }
        />
      ) : null}
      {payload.interview.mode === 'PAPI' ? (
        <PaperMeta
          second={payload.interview.entryPass === 2}
          onSave={(meta) => iv.paperMeta(meta)}
        />
      ) : null}
      {payload.interview.mode === 'PAPI' ? (
        <ScanPanel
          interviewId={interviewId}
          currentKey={session.currentKey()}
          pathKeys={session.pathKeys()}
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
            <SampleData session={session} data={caseData} headingId="iv-sample" />
            {payload.context.contacts?.length ? (
              <Contacts contacts={payload.context.contacts} headingId="iv-contacts" />
            ) : null}
            <AnswersSoFar session={session} headingId="iv-answers" />
          </aside>
        ) : null}

        <section
          aria-label={t('interview.title', { id: payload.context.externalId ?? '' })}
          className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          {iv.resumed && !resumeSeen && !paused && !finished ? (
            <ResumeCard
              where={(() => {
                const key = session.currentKey();
                const sec = sections.find((x) => x.status === 'current');
                const text = key ? (session.text(key) ?? key) : '';
                return sec
                  ? t('interview.resumed.at', { section: sec.title, question: text })
                  : t('interview.resumed.atQuestion', { question: text });
              })()}
              when={
                iv.resumed.updatedAt
                  ? ago(i18n.language, iv.resumed.updatedAt, Date.parse(iv.resumed.serverTime))
                  : null
              }
              count={answered.filter((a) => visited.has(a.key)).length}
              note={iv.resumed.note}
              lastAnswered={(() => {
                const current = session.currentKey();
                const before = answered.filter((a) => visited.has(a.key) && a.key !== current);
                const last = before[before.length - 1]?.key;
                return last && session.canJumpTo(last) ? last : null;
              })()}
              onJump={(key) => {
                session.jumpTo(key);
                iv.onChange();
                setResumeSeen(true);
              }}
              onDismiss={() => setResumeSeen(true)}
            />
          ) : null}
          {paused ? (
            <div className="flex flex-col items-start gap-3" data-testid="paused">
              <p role="status">{t('interview.paused')}</p>
              <div className="flex flex-wrap gap-3">
                <Button type="button" onClick={iv.resume}>
                  {t('interview.resume')}
                </Button>
                {finished ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={submitting}
                    onClick={() => void submit()}
                  >
                    {t('interview.submit')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <InterviewRunner
              session={session}
              mode={payload.interview.mode}
              lang={lang}
              onChange={() => {
                // Once the interviewer goes on, where it stopped is no longer news.
                setResumeSeen(true);
                iv.onChange();
              }}
              specialKeys={{ DK: keys.dontKnow, RF: keys.refused }}
              done={{
                details: (
                  <EndSummary
                    session={session}
                    duration={clock(iv.clock?.activeMs() ?? 0)}
                    answered={answered.length}
                  />
                ),
                action: (
                  <Button type="button" disabled={submitting} onClick={() => void submit()}>
                    {t('interview.submit')}
                  </Button>
                ),
              }}
            />
          )}
        </section>
      </div>

      {/* On a tablet the bar stays at the bottom of the screen, under the thumb. On a phone's
          touch screen that place is the runner's Back and Next: this bar follows the question. */}
      <footer
        className="sticky bottom-0 z-10 max-sm:pointer-coarse:static -mx-1 flex flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50/95 px-1 py-2 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 [&_button]:pointer-coarse:min-h-11"
        data-testid="interview-actions"
      >
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
        {/* Keyboard shortcuts mean nothing on a touch screen. */}
        <button
          type="button"
          className={`${smallBtn} pointer-coarse:hidden`}
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

/** What the reviewer asked to fix, beside the interview being corrected (R1). */
function ReturnedComments({
  interviewId,
  onGoTo,
}: {
  interviewId: string;
  /** Moves the interview to a commented question; false when it cannot be reached. */
  onGoTo?: (key: string) => boolean;
}) {
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
            {c.resolvedAt ? (
              <span className="ml-1 text-xs text-slate-600">({t('review.screen.resolved')})</span>
            ) : null}
            {c.variable && onGoTo ? (
              <button
                type="button"
                className="ml-2 text-xs text-indigo-ink-700 underline"
                onClick={() => onGoTo(c.variable!)}
              >
                {t('review.returned.goTo', { key: c.variable })}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shown when an interview is taken up again: where it stopped, and how long ago (176). */
function ResumeCard({
  where,
  when,
  count,
  note,
  lastAnswered,
  onJump,
  onDismiss,
}: {
  where: string;
  when: string | null;
  count: number;
  /** The interviewer's latest note on the interview. */
  note: string | null;
  lastAnswered: string | null;
  onJump(key: string): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('interview.resumed.title')}
      className="mb-4 flex flex-col gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-ink-900"
      data-testid="resume-card"
    >
      <h2 className="font-semibold">{t('interview.resumed.title')}</h2>
      <p>
        {where} {when ? t('interview.resumed.ago', { when }) : null}{' '}
        {t('interview.resumed.answered', { count })}
      </p>
      {note ? (
        <p data-testid="resume-note">
          <span className="font-medium">{t('interview.resumed.note')}</span>{' '}
          <q className="whitespace-pre-wrap">{note}</q>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {lastAnswered ? (
          <button type="button" className={smallBtn} onClick={() => onJump(lastAnswered)}>
            {t('interview.resumed.lastAnswer')}
          </button>
        ) : null}
        <button type="button" className={smallBtn} onClick={onDismiss}>
          {t('interview.resumed.dismiss')}
        </button>
      </div>
    </section>
  );
}

/** What the interview came to, above the submit button in the end card (175). */
function EndSummary({
  session,
  duration,
  answered,
}: {
  session: InterviewSession;
  duration: string;
  answered: number;
}) {
  const { t } = useTranslation();
  const questions = session.path().filter((e) => e.kind === 'question');
  const values = questions.map((e) => session.getAnswer(e.key));
  const unanswered = values.filter((v) => v === null || v === undefined).length;
  const special = values.filter((v) => !!v && typeof v === 'object' && '$special' in v).length;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="end-summary">
      <ScriptBox scripts={session.scriptsFor({ at: 'end' })} />
      <p>
        {[
          t('interview.end.summary', { duration }),
          t('interview.end.answered', { count: answered }),
          unanswered ? t('interview.end.unanswered', { count: unanswered }) : null,
          special ? t('interview.end.special', { count: special }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className="text-slate-600">{t('interview.end.hint')}</p>
    </div>
  );
}
