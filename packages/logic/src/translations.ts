import type { ContainerItem, LocalizedText, Questionnaire, Section } from '@wansurvey/schema';

/**
 * Every translatable text of a questionnaire, with a stable key built from ids and codes so a
 * file sent to translators can be applied back even after items were reordered:
 *
 *   title · SEC.title · Q1.text · Q1.title · Q1.unit · Q1.minLabel · Q1.maxLabel ·
 *   Q1.option.2 · Q1.row.3 · Q1.check.<rule id> · Q1.CATI.text|instruction|help ·
 *   answerSet.<name>.<code> · special.DK · script.<id>
 */
export interface TextEntry {
  key: string;
  /** A short English description for translators, e.g. "Question Q1 (AGE): wording". */
  context: string;
  texts: LocalizedText;
  /** Where the text lives in the questionnaire JSON. */
  path: (string | number)[];
}

type Path = (string | number)[];

export function extractTexts(q: Questionnaire): TextEntry[] {
  const out: TextEntry[] = [];
  const add = (key: string, context: string, texts: LocalizedText | undefined, path: Path) => {
    if (texts) out.push({ key, context, texts: { ...texts }, path });
  };
  add('title', 'Questionnaire title', q.title, ['title']);

  const item = (it: ContainerItem | Section, path: Path) => {
    const kind = 'kind' in it ? it.kind : 'section';
    const name = 'name' in it && it.name && it.name !== it.id ? ` (${it.name})` : '';
    const what = `${kind[0]!.toUpperCase()}${kind.slice(1)} ${it.id}${name}`;
    if ('title' in it) add(`${it.id}.title`, `${what}: title`, it.title, [...path, 'title']);
    if ('text' in it) add(`${it.id}.text`, `${what}: wording`, it.text, [...path, 'text']);
    if ('kind' in it && it.kind === 'question') {
      add(`${it.id}.unit`, `${what}: unit`, it.unit, [...path, 'unit']);
      if (it.scale) {
        add(`${it.id}.minLabel`, `${what}: label of the lowest value`, it.scale.minLabel, [
          ...path,
          'scale',
          'minLabel',
        ]);
        add(`${it.id}.maxLabel`, `${what}: label of the highest value`, it.scale.maxLabel, [
          ...path,
          'scale',
          'maxLabel',
        ]);
      }
      it.options?.forEach((o, i) =>
        add(`${it.id}.option.${o.code}`, `${what}: option ${o.code}`, o.label, [
          ...path,
          'options',
          i,
          'label',
        ]),
      );
      it.rows?.forEach((r, i) =>
        add(`${it.id}.row.${r.code}`, `${what}: grid row ${r.code}`, r.label, [
          ...path,
          'rows',
          i,
          'label',
        ]),
      );
      it.validations?.forEach((v, i) =>
        add(`${it.id}.check.${v.id}`, `${what}: message of check ${v.id}`, v.message, [
          ...path,
          'validations',
          i,
          'message',
        ]),
      );
    }
    if ('variants' in it && it.variants)
      for (const [mode, v] of Object.entries(it.variants)) {
        if (!v) continue;
        const vp = [...path, 'variants', mode];
        add(`${it.id}.${mode}.text`, `${what}: ${mode} wording`, v.text, [...vp, 'text']);
        add(
          `${it.id}.${mode}.instruction`,
          `${what}: ${mode} interviewer instruction`,
          v.interviewerInstruction,
          [...vp, 'interviewerInstruction'],
        );
        add(`${it.id}.${mode}.help`, `${what}: ${mode} help`, v.helpText, [...vp, 'helpText']);
      }
    if ('items' in it && Array.isArray(it.items))
      it.items.forEach((child, i) => item(child, [...path, 'items', i]));
  };
  q.sections.forEach((s, i) => item(s, ['sections', i]));

  for (const [name, options] of Object.entries(q.answerSets ?? {}))
    options.forEach((o, i) =>
      add(`answerSet.${name}.${o.code}`, `Answer set ${name}: option ${o.code}`, o.label, [
        'answerSets',
        name,
        i,
        'label',
      ]),
    );
  for (const kind of ['DK', 'RF', 'NA'] as const)
    add(`special.${kind}`, `Special code ${kind}`, q.settings?.specialCodes?.[kind]?.label, [
      'settings',
      'specialCodes',
      kind,
      'label',
    ]);
  (q.scripts ?? []).forEach((s, i) =>
    add(`script.${s.id}`, `Interviewer script ${s.id}`, s.body, ['scripts', i, 'body']),
  );
  return out;
}

export interface TextRow {
  key: string;
  texts: Record<string, string>;
}

export interface ApplyResult {
  questionnaire: Questionnaire;
  changes: { key: string; lang: string; from: string; to: string }[];
  /** Keys in the file that the questionnaire does not have (removed or renamed items). */
  unknownKeys: string[];
  /** Languages in the file that the questionnaire does not use; they are not applied. */
  ignoredLanguages: string[];
  /** Texts still missing after the import, per questionnaire language (special codes aside). */
  missing: { key: string; lang: string }[];
}

/**
 * Writes translated texts back. Empty cells leave the text as it is (a file never erases a
 * translation); languages the questionnaire does not use are reported, not added.
 */
export function applyTexts(q: Questionnaire, rows: TextRow[]): ApplyResult {
  const next = JSON.parse(JSON.stringify(q)) as Questionnaire;
  const entries = new Map(extractTexts(next).map((e) => [e.key, e]));
  const langs = new Set(next.languages);
  const changes: ApplyResult['changes'] = [];
  const unknownKeys: string[] = [];
  const ignored = new Set<string>();
  for (const row of rows) {
    const entry = entries.get(row.key);
    if (!entry) {
      unknownKeys.push(row.key);
      continue;
    }
    const target = at(next, entry.path) as LocalizedText;
    for (const [lang, raw] of Object.entries(row.texts)) {
      if (!langs.has(lang)) {
        ignored.add(lang);
        continue;
      }
      const to = raw.trim() ? raw : '';
      const from = target[lang] ?? '';
      if (!to || to === from) continue;
      target[lang] = to;
      changes.push({ key: row.key, lang, from, to });
    }
  }
  // Special-code labels fall back to the interface's own words, so they are never missing.
  const missing = extractTexts(next)
    .filter((e) => !e.key.startsWith('special.'))
    .flatMap((e) =>
      next.languages.filter((l) => !e.texts[l]?.trim()).map((lang) => ({ key: e.key, lang })),
    );
  return {
    questionnaire: next,
    changes,
    unknownKeys,
    ignoredLanguages: [...ignored].sort(),
    missing,
  };
}

function at(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], root);
}

// ---- CSV -----------------------------------------------------------------------------------

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** key, context, then one column per questionnaire language. Starts with a BOM for Excel. */
export function textsToCsv(q: Questionnaire): string {
  const lines = [['key', 'context', ...q.languages]];
  for (const e of extractTexts(q))
    lines.push([e.key, e.context, ...q.languages.map((l) => e.texts[l] ?? '')]);
  return '\uFEFF' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Reads RFC 4180 CSV (comma or semicolon, quoted fields with newlines). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Rows of a translations CSV: a `key` column and one column per language (others ignored). */
export function textsFromCsv(text: string): TextRow[] {
  const [header, ...body] = parseCsv(text);
  const cols = (header ?? []).map((h) => h.trim());
  const keyAt = cols.indexOf('key');
  if (keyAt < 0) throw new Error('The file has no "key" column');
  const langCols = cols
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i !== keyAt && c && c !== 'context');
  return body
    .filter((r) => r[keyAt]?.trim())
    .map((r) => ({
      key: r[keyAt]!.trim(),
      texts: Object.fromEntries(langCols.map(({ c, i }) => [c, r[i] ?? ''])),
    }));
}

// ---- XLIFF 2.0 -----------------------------------------------------------------------------

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** One XLIFF 2.0 file per target language; existing translations are filled in as targets. */
export function textsToXliff(q: Questionnaire, srcLang: string, trgLang: string): string {
  const units = extractTexts(q).map((e) => {
    const target = e.texts[trgLang];
    return [
      `    <unit id="${xmlEscape(e.key)}">`,
      `      <notes><note>${xmlEscape(e.context)}</note></notes>`,
      `      <segment${target ? ' state="translated"' : ''}>`,
      `        <source>${xmlEscape(e.texts[srcLang] ?? '')}</source>`,
      ...(target ? [`        <target>${xmlEscape(target)}</target>`] : []),
      `      </segment>`,
      `    </unit>`,
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${xmlEscape(srcLang)}" trgLang="${xmlEscape(trgLang)}">`,
    `  <file id="${xmlEscape(q.id)}">`,
    ...units,
    '  </file>',
    '</xliff>',
    '',
  ].join('\n');
}

/** Targets of an XLIFF 2.0 file, as rows for `applyTexts`. */
export function textsFromXliff(xml: string): { trgLang: string; rows: TextRow[] } {
  const root = /<xliff\b([^>]*)>/.exec(xml);
  if (!root || !/version="2\.\d"/.test(root[1]!)) throw new Error('Not an XLIFF 2 file');
  const trgLang = /trgLang="([^"]+)"/.exec(root[1]!)?.[1];
  if (!trgLang) throw new Error('The XLIFF file names no target language (trgLang)');
  const rows: TextRow[] = [];
  for (const unit of xml.matchAll(/<unit\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/unit>/g)) {
    const targets = [...unit[2]!.matchAll(/<target\b[^>]*>([\s\S]*?)<\/target>/g)].map((m) =>
      xmlUnescape(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')),
    );
    if (targets.length)
      rows.push({ key: xmlUnescape(unit[1]!), texts: { [trgLang]: targets.join('') } });
  }
  return { trgLang, rows };
}
