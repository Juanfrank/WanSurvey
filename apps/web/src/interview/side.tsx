import { own, type InterviewSession } from '@wansurvey/logic';
import type { Question } from '@wansurvey/schema';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

const MASK = '•••';

/** The variable name of an answer key (`HH[2].M_AGE` → `M_AGE`). */
const nameOf = (key: string) => key.split('[', 1)[0]!.split('.').pop()!;

function questionOf(session: InterviewSession, name: string): Question | null {
  const info = own(session.compiled.vars, name);
  if (!info || info.kind !== 'question') return null;
  return session.compiled.nodes[info.node]!.def as Question;
}

/** An answer as the interviewer reads it: option labels, special answers, scale points. */
export function shown(v: unknown, session: InterviewSession, name: string, t?: TFunction): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object' && v && '$special' in v)
    return session.specialLabel((v as { $special: 'DK' }).$special);
  if (typeof v === 'number' || typeof v === 'string') {
    const label = session.labelOf(name, v);
    if (label) return label;
    // A scale point alone ("2") says little: give the scale's range with it.
    const scale = questionOf(session, name)?.scale;
    if (t && scale && typeof v === 'number')
      return t('interview.scaleValue', { value: v, min: scale.min, max: scale.max });
    return String(v);
  }
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object'))
    return v.map((x) => session.labelOf(name, x as string) ?? String(x)).join(', ');
  return JSON.stringify(v);
}

/** A sample column's name for people: a known one translated, else the code tidied up. */
export function fieldLabel(t: TFunction, key: string): string {
  const none = '\u0000';
  const known = t(`interview.fields.${key.toLowerCase()}`, { defaultValue: none });
  if (known !== none) return known;
  const words = key.replace(/[_\-.]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** Questions prefilled straight from a sample column (`case.region`), by column. */
function prefilledFrom(session: InterviewSession): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of session.compiled.nodes) {
    if (node.kind !== 'question' || !node.name) continue;
    const m = /^\s*case\.([A-Za-z_][\w]*)\s*$/.exec((node.def as Question).prefill ?? '');
    if (m && !out.has(m[1]!)) out.set(m[1]!, node.name);
  }
  return out;
}

/** A label above its code, both in one cell, so the eye finds "City" and not `city`. */
function Term({ label, code }: { label: string; code: string }) {
  return (
    <dt className="min-w-0 text-slate-700">
      {label}
      {label.toLowerCase() !== code.toLowerCase() ? (
        <span className="ml-1 font-mono text-xs text-slate-500">{code}</span>
      ) : null}
    </dt>
  );
}

/**
 * The case's sample data with readable names; a coded column that a question is prefilled
 * from shows that question's label for the code ("South (2)").
 */
export function SampleData({
  session,
  data,
  headingId,
  as: H = 'h2',
}: {
  session: InterviewSession;
  data: Record<string, unknown>;
  headingId?: string;
  as?: 'h2' | 'h3';
}) {
  const { t } = useTranslation();
  const from = prefilledFrom(session);
  return (
    <section aria-labelledby={headingId}>
      <H id={headingId} className="mb-1 font-semibold">
        {t('interview.sample')}
      </H>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5" data-testid="sample-data">
        {Object.entries(data).map(([k, v]) => {
          const q = from.get(k);
          const label =
            q && v !== MASK && (typeof v === 'number' || typeof v === 'string')
              ? session.labelOf(q, v)
              : null;
          return (
            <div key={k} className="contents">
              <Term label={fieldLabel(t, k)} code={k} />
              <dd className="min-w-0 break-words">
                {v === null || v === undefined
                  ? '—'
                  : label && label !== String(v)
                    ? `${label} (${String(v)})`
                    : String(v)}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * Face to face, what the project marks as needed to reach the household (an address field of
 * the sample, the case's addresses). No other personal data is listed: the questionnaire shows
 * what it needs where it needs it.
 */
export function FieldworkData({
  data,
  addresses,
  headingId,
}: {
  data: Record<string, unknown>;
  addresses: { value: string; label: string | null }[];
  headingId?: string;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby={headingId} data-testid="fieldwork-data">
      <h2 id={headingId} className="mb-1 font-semibold">
        {t('interview.fieldwork')}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="contents">
            <Term label={fieldLabel(t, k)} code={k} />
            <dd className="min-w-0 break-words">
              {v === null || v === undefined ? '—' : String(v)}
            </dd>
          </div>
        ))}
        {addresses.map((a, i) => (
          <div key={`address-${i}`} className="contents">
            <dt className="min-w-0 text-slate-700">{a.label ?? t('interview.address')}</dt>
            <dd className="min-w-0 break-words">{a.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The answers given so far, each under its question's wording with the variable in small
 * print. Answers that came from the sample and whose question has not been reached yet are
 * apart, as data to confirm: seen as answers, they invite not asking the question.
 */
export function AnswersSoFar({
  session,
  headingId,
  as: H = 'h2',
}: {
  session: InterviewSession;
  headingId?: string;
  as?: 'h2' | 'h3';
}) {
  const { t } = useTranslation();
  const visited = new Set(session.state().visited);
  const all = session
    .path()
    .filter((e) => e.kind === 'question')
    .map((e) => ({ key: e.key, value: session.getAnswer(e.key) }))
    .filter((a) => a.value !== null && a.value !== undefined);
  // Still as it came from the sample, on a question not reached yet.
  const pending = (key: string) => !visited.has(key) && session.matchesPrefill(key);
  const given = all.filter((a) => !pending(a.key));
  const toConfirm = all.filter((a) => pending(a.key));
  const list = (items: typeof all, testId: string) => (
    <dl className="flex flex-col gap-1" data-testid={testId}>
      {items.map((a) => {
        const text = session.text(a.key);
        return (
          <div key={a.key} className="min-w-0">
            <dt className="flex items-baseline gap-1 text-slate-700">
              {text ? (
                <span className="min-w-0 truncate" title={text}>
                  {text}
                </span>
              ) : null}
              <span className="shrink-0 font-mono text-xs text-slate-500">{a.key}</span>
            </dt>
            <dd className="min-w-0 break-words font-medium">
              {shown(a.value, session, nameOf(a.key), t)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
  return (
    <>
      <section aria-labelledby={headingId}>
        <H id={headingId} className="mb-1 font-semibold">
          {t('interview.answers')}
        </H>
        {given.length ? (
          list(given, 'answers-so-far')
        ) : (
          <p className="text-slate-600">{t('interview.noAnswers')}</p>
        )}
      </section>
      {toConfirm.length ? (
        <section aria-labelledby={headingId ? `${headingId}-prefilled` : undefined}>
          <H id={headingId ? `${headingId}-prefilled` : undefined} className="font-semibold">
            {t('interview.prefilled')}
          </H>
          <p className="mb-1 text-xs text-slate-600">{t('interview.prefilledHint')}</p>
          {list(toConfirm, 'prefilled-answers')}
        </section>
      ) : null}
    </>
  );
}

/** "2 hours ago", in the interface language. */
export function ago(lang: string, iso: string, now = Date.now()): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const s = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86_400), 'day');
}
