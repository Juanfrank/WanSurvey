import { useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Shell } from '../respondent/RespondentPage.js';
import { respondentLang } from '../respondent/text.js';
import type { FeedbackItem } from '@wansurvey/schema/feedback';
import { Face } from './Faces.js';

/** The page's words, in the respondent's language (Spanish first), like the survey pages. */
const TEXT = {
  es: {
    loading: 'Cargando…',
    notFound: 'Este enlace no es válido o ya no está disponible.',
    failed: 'No se pudo guardar su respuesta. Inténtelo de nuevo.',
    thanks: '¡Gracias por su opinión!',
    tellMore: '¿Quiere contarnos algo más? (opcional)',
    send: 'Enviar comentario',
    sent: 'Comentario enviado. ¡Gracias!',
    faces3: ['Mal', 'Regular', 'Bien'],
    faces5: ['Muy mal', 'Mal', 'Regular', 'Bien', 'Muy bien'],
    choose: 'Elija una carita',
    sendAll: 'Enviar',
    sentAll: 'Respuestas enviadas. ¡Gracias!',
    required: 'Responda esta pregunta.',
    invalidAnswer: 'Revise esta respuesta.',
    yes: 'Sí',
    no: 'No',
    optional: '(opcional)',
  },
  en: {
    loading: 'Loading…',
    notFound: 'This link is not valid or no longer available.',
    failed: 'Your answer could not be saved. Please try again.',
    thanks: 'Thank you for your feedback!',
    tellMore: 'Anything else you would like to tell us? (optional)',
    send: 'Send comment',
    sent: 'Comment sent. Thank you!',
    faces3: ['Bad', 'OK', 'Good'],
    faces5: ['Very bad', 'Bad', 'OK', 'Good', 'Very good'],
    choose: 'Choose a face',
    sendAll: 'Send',
    sentAll: 'Answers sent. Thank you!',
    required: 'Please answer this question.',
    invalidAnswer: 'Please check this answer.',
    yes: 'Yes',
    no: 'No',
    optional: '(optional)',
  },
};

interface Point {
  question: Record<string, string>;
  faces: 3 | 5;
  askComment: boolean;
  items?: FeedbackItem[];
}

type Answer = string | number | number[] | null;

/** Link parameters other than the face, the reference and the widget flag (`?sede=2`). */
function linkParams(): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((v, k) => {
    if (!['r', 'ref', 'embed'].includes(k) && /^[a-z][a-z0-9_]{0,31}$/.test(k))
      out[k] = v.slice(0, 200);
  });
  return out;
}

const seen = (slug: string, r: number, ref: string) => `wansurvey.fb.${slug}.${r}.${ref}`;

/**
 * Quick feedback (`/f/$slug`). With `?r=2` (the link of a face in an e-mail or a web page) the
 * page records that face as it opens, once per browser and link; without it, the faces are
 * shown to choose from. `?embed=1` is the compact widget for an iframe; `?ref=` says what the
 * answer is about (a ticket, a branch…).
 */
export function FeedbackPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search = useSearch({ strict: false }) as { r?: number; ref?: string; embed?: boolean };
  const browser = respondentLang(navigator.language) as 'es' | 'en';
  const [point, setPoint] = useState<Point | null>(null);
  const [problem, setProblem] = useState<'notFound' | 'failed' | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [answer, setAnswer] = useState<{ id: string; key?: string; preset?: string[] } | null>(
    null,
  );
  const [values, setValues] = useState<Record<string, Answer>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [commented, setCommented] = useState(false);
  const started = useRef(false);
  // The question's language: the browser's when the question has it, else its first.
  const lang = (!point || point.question[browser] ? browser : Object.keys(point.question)[0]) as
    'es' | 'en';
  const t = TEXT[lang] ?? TEXT.es;
  const ref = (search.ref ?? '').slice(0, 120);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const record = async (score: number, channel: 'link' | 'widget') => {
    setChosen(score);
    setProblem(null);
    try {
      const r = await api<{ id: string; key?: string; preset?: string[] }>(`/public/f/${slug}`, {
        method: 'POST',
        body: { score, channel, ...(ref ? { ref } : {}), params: linkParams() },
      });
      setAnswer(r);
      try {
        sessionStorage.setItem(seen(slug, score, ref), JSON.stringify(r));
      } catch {
        // Without storage, a reload records the face again.
      }
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 404 ? 'notFound' : 'failed');
    }
  };

  useEffect(() => {
    void api<Point>(`/public/f/${slug}`).then(
      (p) => {
        setPoint(p);
        const r = Number(search.r);
        if (started.current || !Number.isInteger(r) || r < 1 || r > p.faces) return;
        started.current = true;
        let before: string | null = null;
        try {
          before = sessionStorage.getItem(seen(slug, r, ref));
        } catch {
          before = null;
        }
        if (before) {
          setChosen(r);
          setAnswer(JSON.parse(before) as { id: string; key?: string });
        } else void record(r, 'link');
      },
      (e) => setProblem(e instanceof ApiError && e.status === 404 ? 'notFound' : 'failed'),
    );
  }, [slug]);

  const question = point ? (point.question[lang] ?? Object.values(point.question)[0] ?? '') : '';
  const labels = point ? (point.faces === 5 ? t.faces5 : t.faces3) : [];
  // The questions after the face: not those the link answered, and only those for this face.
  const followUps = (point?.items ?? []).filter(
    (it) =>
      !answer?.preset?.includes(it.id) &&
      (!it.showIf || (chosen !== null && chosen >= it.showIf.min && chosen <= it.showIf.max)),
  );

  const body = !point ? (
    problem ? (
      <p role="alert">{t[problem]}</p>
    ) : (
      <p aria-busy="true">{t.loading}</p>
    )
  ) : (
    <div className="flex flex-col items-center gap-5 text-center" data-testid="feedback">
      <h1 className="text-lg font-semibold text-slate-900">{question}</h1>
      <div role="group" aria-label={t.choose} className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: point.faces }, (_, i) => i + 1).map((score) => (
          <button
            key={score}
            type="button"
            aria-pressed={chosen === score}
            disabled={!!answer}
            className="flex flex-col items-center gap-1 rounded-xl border-2 border-transparent p-2 transition hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-pressed:border-indigo-600 aria-pressed:bg-indigo-50 disabled:cursor-default disabled:hover:scale-100 [&:disabled:not([aria-pressed=true])]:opacity-40"
            onClick={() => void record(score, search.embed ? 'widget' : 'link')}
          >
            <Face score={score} faces={point.faces} size={search.embed ? 44 : 60} />
            <span className="text-sm">{labels[score - 1]}</span>
          </button>
        ))}
      </div>
      <p role="alert" className="text-red-ink-800 empty:hidden">
        {problem ? t[problem] : ''}
      </p>
      {answer ? (
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          <p role="status" className="text-base font-medium text-emerald-ink-800">
            {t.thanks}
          </p>
          {answer.key && !commented && followUps.length ? (
            <form
              className="flex w-full flex-col gap-4 text-left"
              data-testid="feedback-followups"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                const missing: Record<string, string> = {};
                for (const it of followUps) {
                  const v = values[it.id];
                  if (
                    it.required &&
                    (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))
                  )
                    missing[it.id] = 'required';
                }
                setProblems(missing);
                const form = e.currentTarget;
                // The first question to fix gets the focus, so its message is read out.
                const focusFirst = (bad: Record<string, string>) => {
                  const first = followUps.find((it) => bad[it.id]);
                  if (!first) return;
                  requestAnimationFrame(() =>
                    form
                      .querySelector<HTMLElement>(
                        `[data-followup="${CSS.escape(first.id)}"] :is(input, textarea, select, button)`,
                      )
                      ?.focus(),
                  );
                };
                if (Object.keys(missing).length) return focusFirst(missing);
                void api(`/public/f/${slug}/answers`, {
                  method: 'POST',
                  body: { id: answer.id, key: answer.key, answers: values },
                }).then(
                  () => setCommented(true),
                  (err) => {
                    const pr =
                      (err instanceof ApiError
                        ? (err.body as { problems?: Record<string, string> }).problems
                        : undefined) ?? {};
                    if (Object.keys(pr).length) {
                      setProblems(pr);
                      focusFirst(pr);
                    } else setProblem('failed');
                  },
                );
              }}
            >
              {followUps.map((it) => (
                <FollowUp
                  key={it.id}
                  item={it}
                  lang={lang}
                  t={t}
                  value={values[it.id] ?? null}
                  problem={
                    problems[it.id]
                      ? problems[it.id] === 'required'
                        ? t.required
                        : t.invalidAnswer
                      : ''
                  }
                  onChange={(v) => setValues((x) => ({ ...x, [it.id]: v }))}
                />
              ))}
              <button
                type="submit"
                className="self-end rounded-md bg-indigo-600 px-4 py-2 font-medium text-on-fill"
              >
                {t.sendAll}
              </button>
            </form>
          ) : commented ? (
            <p role="status">{t.sentAll}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  // The widget is bare (for an iframe); the link opens a plain respondent page.
  return search.embed ? (
    <main className="bg-transparent p-3">{body}</main>
  ) : (
    <Shell title="">{body}</Shell>
  );
}

type Texts = (typeof TEXT)['es'];

/** One follow-up question on the respondent's page. */
function FollowUp({
  item,
  lang,
  t,
  value,
  problem,
  onChange,
}: {
  item: FeedbackItem;
  lang: string;
  t: Texts;
  value: Answer;
  problem: string;
  onChange(v: Answer): void;
}) {
  const label = item.text[lang] ?? Object.values(item.text)[0] ?? item.id;
  const id = `fb-${item.id}`;
  const err = problem ? (
    <p id={`${id}-err`} className="text-sm text-red-ink-800">
      {problem}
    </p>
  ) : null;
  const described = problem ? { 'aria-describedby': `${id}-err`, 'aria-invalid': true } : {};
  const text = (
    <>
      {label} {item.required ? null : <span className="text-slate-500">{t.optional}</span>}
    </>
  );
  const optLabel = (o: { label: Record<string, string> }) =>
    o.label[lang] ?? Object.values(o.label)[0] ?? '';
  if (item.type === 'text' || item.type === 'number')
    return (
      <div className="flex flex-col gap-1" data-followup={item.id}>
        <label htmlFor={id} className="text-sm font-medium">
          {text}
        </label>
        {item.type === 'text' && item.long ? (
          <textarea
            id={id}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            {...described}
          />
        ) : (
          <input
            id={id}
            inputMode={item.type === 'number' ? 'decimal' : undefined}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
            value={value === null ? '' : String(value)}
            onChange={(e) => {
              if (item.type === 'text') return onChange(e.target.value);
              const n = Number(e.target.value.replace(',', '.'));
              onChange(e.target.value.trim() === '' ? null : Number.isFinite(n) ? n : null);
            }}
            {...described}
          />
        )}
        {err}
      </div>
    );
  const options =
    item.type === 'yesno'
      ? [
          { code: 1, label: { [lang]: t.yes } },
          { code: 2, label: { [lang]: t.no } },
        ]
      : (item.options ?? []);
  const multi = item.type === 'multi';
  const picked = Array.isArray(value) ? value : [];
  return (
    <fieldset className="flex flex-col gap-1.5" data-followup={item.id} {...described}>
      <legend className="mb-1 text-sm font-medium">{text}</legend>
      {options.map((o) => (
        <label
          key={o.code}
          className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
        >
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={id}
            checked={multi ? picked.includes(o.code) : value === o.code}
            onChange={(e) =>
              onChange(
                multi
                  ? e.target.checked
                    ? [...picked, o.code]
                    : picked.filter((c) => c !== o.code)
                  : o.code,
              )
            }
          />
          {optLabel(o)}
        </label>
      ))}
      {err}
    </fieldset>
  );
}
