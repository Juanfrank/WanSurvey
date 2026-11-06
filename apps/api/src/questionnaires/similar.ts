/**
 * Finding questions that already exist: the text of a question as a set of meaningful words
 * (lower case, no accents or punctuation, no filler words), compared with the Dice coefficient
 * on the words and on their pairs. Good enough to see "¿Cuál es su edad?" in "Edad de la persona"
 * without a language model, and quick enough to run over every question of an organisation.
 */
const STOP = new Set(
  (
    'a al con de del el en es la las lo los me mi o para por que qué se su sus tu tus usted ustedes un una uno y ' +
    'cual cuál cuales cuáles como cómo cuando cuándo donde dónde ' +
    'the a an and are is of on or to what which how do does you your in for with'
  )
    .split(' ')
    .map((w) => fold(w)),
);

function fold(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** The words that carry the meaning of a text; markup and `{{piped}}` values are dropped. */
export function words(text: string): string[] {
  return fold(text.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' '))
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

const dice = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return (2 * both) / (a.size + b.size);
};

const pairs = (w: string[]) => new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));

/** 0 to 1: how alike two question texts are. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const single = dice(new Set(wa), new Set(wb));
  // The order of the words counts a little: the pairs only break ties among equal word sets.
  const order = wa.length > 1 && wb.length > 1 ? dice(pairs(wa), pairs(wb)) : single;
  return Math.round((0.8 * single + 0.2 * order) * 1000) / 1000;
}

export interface QuestionSource {
  /** Where it was found. */
  origin: { kind: 'questionnaire' | 'library'; id: string; name: string; projectId: string | null };
  variable: string | null;
  text: string;
}

/** The questions of a definition (also in sections, blocks and rosters), with their wording. */
export function questionsOf(
  definition: unknown,
  lang?: string,
): { variable: string; text: string }[] {
  const out: { variable: string; text: string }[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.kind === 'question' && typeof o.name === 'string') {
      const t = o.text as Record<string, string> | undefined;
      const text = t ? (lang && t[lang]) || Object.values(t)[0] : undefined;
      if (text) out.push({ variable: o.name, text });
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk((definition as { sections?: unknown })?.sections ?? definition);
  return out;
}

/** The best matches for a text among the sources, above a threshold, best first. */
export function rankSimilar(
  text: string,
  sources: QuestionSource[],
  opts: { min?: number; limit?: number } = {},
) {
  const min = opts.min ?? 0.5;
  return sources
    .map((s) => ({ ...s, score: similarity(text, s.text) }))
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
    .slice(0, opts.limit ?? 10);
}
