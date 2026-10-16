import type { InterviewSession } from '@wansurvey/logic';
import { InterviewRunner, pick } from '@wansurvey/renderer';
import type { Mode } from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sectionsOf, shown } from '../interview/InterviewPage.js';
import { Shell } from '../respondent/RespondentPage.js';

const chrome =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 disabled:opacity-60';

/**
 * The interview exactly as the people in the field see it: the interviewer's screen (case
 * details, sections, answers so far and the footer buttons) on a desktop for CATI or a tablet
 * for CAPI, and the respondent's page on a phone or a computer for CAWI. The buttons that need
 * a real case (note, pause, suspend) are shown but inactive.
 */
export function AsSeenFrame({
  session,
  mode,
  lang,
  onChange,
  context,
}: {
  session: InterviewSession;
  mode: Exclude<Mode, 'PAPI'>;
  lang: string;
  onChange(): void;
  context: { case?: Record<string, unknown> };
}) {
  const { t } = useTranslation();
  const [device, setDevice] = useState<'phone' | 'computer'>('phone');
  const title = pick(session.compiled.questionnaire.title, lang) ?? '';

  if (mode === 'CAWI') {
    const narrow = device === 'phone';
    return (
      <div className="flex flex-col items-center gap-3">
        <div role="group" aria-label={t('preview.asSeen.device')} className="flex gap-1">
          {(['phone', 'computer'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              className="rounded-md border border-slate-300 px-3 py-1 text-sm aria-pressed:border-indigo-600 aria-pressed:bg-indigo-50 aria-pressed:font-semibold"
              onClick={() => setDevice(d)}
            >
              {t(`preview.asSeen.${d}`)}
            </button>
          ))}
        </div>
        <div
          className={
            narrow
              ? 'w-[390px] max-w-full overflow-hidden rounded-[2.25rem] border-[10px] border-slate-800 shadow-xl'
              : 'w-full overflow-hidden rounded-lg border border-slate-300 shadow-lg'
          }
          data-testid="as-seen-cawi"
          data-device={device}
        >
          {!narrow ? (
            <div
              aria-hidden
              className="flex gap-1.5 border-b border-slate-200 bg-slate-100 px-3 py-2"
            >
              <span className="size-2.5 rounded-full bg-red-400" />
              <span className="size-2.5 rounded-full bg-amber-400" />
              <span className="size-2.5 rounded-full bg-emerald-400" />
            </div>
          ) : null}
          <div className={narrow ? 'h-[720px] overflow-y-auto' : 'max-h-[760px] overflow-y-auto'}>
            <Shell embedded title={title} status={t('preview.asSeen.saved')}>
              <InterviewRunner
                key={`cawi-${device}`}
                session={session}
                mode="CAWI"
                lang={lang}
                onChange={onChange}
                narrow={narrow}
              />
            </Shell>
          </div>
        </div>
      </div>
    );
  }

  const sections = sectionsOf(session, lang);
  const answered = session
    .path()
    .filter((e) => e.kind === 'question')
    .map((e) => ({ key: e.key, value: session.getAnswer(e.key) }))
    .filter((a) => a.value !== null && a.value !== undefined);
  const caseData = context.case ?? {};
  const screen = (
    <div className="flex flex-col gap-4 bg-slate-50 p-4" data-testid="as-seen-interviewer">
      <header className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-2">
        <h2 className="text-lg font-semibold">{t('preview.asSeen.case')}</h2>
        <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-ink-800">
          {mode}
        </span>
        <dl className="flex gap-4 text-sm">
          <div>
            <dt className="text-xs text-slate-600">{t('interview.elapsed')}</dt>
            <dd className="font-mono">00:00</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-600">{t('interview.onQuestion')}</dt>
            <dd className="font-mono">00:00</dd>
          </div>
        </dl>
        <span className="ml-auto text-sm font-medium text-emerald-ink-800">
          {t('interview.save.saved')}
        </span>
      </header>
      <div className="grid gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
        <aside
          aria-label={t('interview.side')}
          className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 text-sm"
        >
          <section>
            <h3 className="mb-1 font-semibold">{t('interview.sections')}</h3>
            <ol className="flex flex-col gap-1">
              {sections.map((s) => (
                <li
                  key={s.id}
                  className={`flex justify-between gap-2 rounded px-2 py-1 ${s.status === 'current' ? 'bg-indigo-100' : ''}`}
                >
                  <span>{s.title}</span>
                  <span className="text-xs">{t(`interview.section.${s.status}`)}</span>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h3 className="mb-1 font-semibold">{t('interview.sample')}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {Object.entries(caseData).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-slate-600">{k}</dt>
                  <dd>{v === null || v === undefined ? '—' : String(v)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3 className="mb-1 font-semibold">{t('interview.answers')}</h3>
            {answered.length ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {answered.map((a) => (
                  <div key={a.key} className="contents">
                    <dt className="font-mono text-slate-600">{a.key}</dt>
                    <dd>{shown(a.value, session, a.key.replace(/\[.*$/, '').split('.').pop()!)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-slate-600">{t('interview.noAnswers')}</p>
            )}
          </section>
        </aside>
        <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <InterviewRunner
            key={`iv-${mode}`}
            session={session}
            mode={mode}
            lang={lang}
            onChange={onChange}
          />
        </section>
      </div>
      <footer className="flex flex-wrap items-center gap-2">
        {(['hideSide', 'note', 'pause', 'suspend', 'help'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={chrome}
            disabled
            title={t('preview.asSeen.inactive')}
          >
            {t(`interview.${k}`)}
          </button>
        ))}
      </footer>
    </div>
  );

  return mode === 'CAPI' ? (
    <div className="flex justify-center">
      <div
        className="w-full max-w-[1100px] overflow-hidden rounded-[1.75rem] border-[14px] border-slate-800 shadow-xl"
        data-device="tablet"
      >
        {screen}
      </div>
    </div>
  ) : (
    <div
      className="overflow-hidden rounded-lg border border-slate-300 shadow-lg"
      data-device="desktop"
    >
      <div aria-hidden className="flex gap-1.5 border-b border-slate-200 bg-slate-100 px-3 py-2">
        <span className="size-2.5 rounded-full bg-red-400" />
        <span className="size-2.5 rounded-full bg-amber-400" />
        <span className="size-2.5 rounded-full bg-emerald-400" />
      </div>
      {screen}
    </div>
  );
}
