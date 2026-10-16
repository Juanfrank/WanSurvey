import { useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Shell } from '../respondent/RespondentPage.js';
import { respondentLang } from '../respondent/text.js';
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
  },
};

interface Point {
  question: Record<string, string>;
  faces: 3 | 5;
  askComment: boolean;
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
  const [answer, setAnswer] = useState<{ id: string; key?: string } | null>(null);
  const [comment, setComment] = useState('');
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
      const r = await api<{ id: string; key?: string }>(`/public/f/${slug}`, {
        method: 'POST',
        body: { score, channel, ...(ref ? { ref } : {}) },
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
            className="flex flex-col items-center gap-1 rounded-xl border-2 border-transparent p-2 transition hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-pressed:border-indigo-600 aria-pressed:bg-indigo-50 disabled:cursor-default disabled:hover:scale-100 [&:disabled:not([aria-pressed=true])]:opacity-40"
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
          {answer.key && !commented ? (
            <form
              className="flex w-full flex-col gap-2 text-left"
              onSubmit={(e) => {
                e.preventDefault();
                if (!comment.trim()) return;
                void api(`/public/f/${slug}/comment`, {
                  method: 'POST',
                  body: { id: answer.id, key: answer.key, comment: comment.trim() },
                }).then(
                  () => setCommented(true),
                  () => setProblem('failed'),
                );
              }}
            >
              <label htmlFor="fb-comment" className="text-sm">
                {t.tellMore}
              </label>
              <textarea
                id="fb-comment"
                rows={3}
                maxLength={2000}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button
                type="submit"
                disabled={!comment.trim()}
                className="self-end rounded-md bg-indigo-600 px-4 py-2 font-medium text-on-fill disabled:bg-indigo-300"
              >
                {t.send}
              </button>
            </form>
          ) : commented ? (
            <p role="status">{t.sent}</p>
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
