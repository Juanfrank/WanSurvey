import { questionOptions, type CompiledQuestionnaire } from '@wansurvey/logic';
import type { LocalizedText, Question, SpecialKind } from '@wansurvey/schema';

/**
 * The layout of a machine-readable paper form: every mark, box and text at an exact place on
 * an A4 page (points, origin at the top left). The same function draws the form and, from the
 * version and language in each page's code, tells the reader where to look.
 */
export const LAYOUT_VERSION = 1;
export const PAGE = { w: 595.28, h: 841.89 };
export const MARGIN = 36;
/** Solid squares at the four corners: where the page is in a scan. */
export const FIDUCIAL = 14;
export const QR_SIZE = 80;
export const BUBBLE_R = 5.5;
const TOP = MARGIN + QR_SIZE + 22;
const BOTTOM = PAGE.h - MARGIN - 26;
const LEFT = MARGIN + 6;
const WIDTH = PAGE.w - 2 * MARGIN - 12;
const LINE = 11.5;
const TEXT = 9.5;

export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A bubble: an option (`code`), a special answer, or a grid cell (`row`). */
export interface Bubble {
  page: number;
  x: number;
  y: number;
  code?: string | number;
  special?: SpecialKind;
  row?: string | number;
}

export interface LaidQuestion {
  name: string;
  type: Question['type'];
  /** `marks`: read from the bubbles; `manual`: written by hand, keyed in the second round. */
  reading: 'marks' | 'manual';
  /** Scale points are numbers; the others codes. */
  numeric: boolean;
  bubbles: Bubble[];
  /** Where it is on paper, for the cut-out shown in the second round. */
  rects: Rect[];
}

export type DrawOp =
  | { page: number; op: 'text'; x: number; y: number; size: number; text: string; font: Font }
  | { page: number; op: 'bubble'; x: number; y: number }
  | { page: number; op: 'box'; x: number; y: number; w: number; h: number }
  | { page: number; op: 'line'; x: number; y: number; w: number };

export type Font = 'regular' | 'bold' | 'mono';
export type Measure = (text: string, size: number, font: Font) => number;

export interface FormLayout {
  pages: number;
  questions: LaidQuestion[];
  ops: DrawOp[];
}

/** Texts printed in the layout's language. */
export interface LayoutWords {
  markAll: string;
  writeHere: string;
  continued: string;
  special: Record<SpecialKind, string>;
}

const tx = (t: LocalizedText | undefined, lang: string) =>
  t ? (t[lang] ?? Object.values(t)[0] ?? '') : '';

/** Only what the standard PDF fonts can print; pipes become a blank to fill. */
export function printable(s: string) {
  return s
    .replace(/\{\{[^}]*\}\}/g, '…')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/→/g, '->')
    .replace(/\s+/g, ' ')
    .replace(/[^\u0020-\u007e\u00a0-\u00ff\u2026\u2022\u20ac]/g, '?')
    .trim();
}

/** Lines of `text` that fit `width`. */
export function wrap(text: string, width: number, size: number, font: Font, measure: Measure) {
  const words = printable(text).split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next, size, font) > width) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** A piece of a question that stays on one page. */
interface Row {
  h: number;
  draw(page: number, y: number): { ops: DrawOp[]; bubbles: Bubble[] };
}

/**
 * Lays out the questions of a version in order. Questions in rosters and those hidden on paper
 * are not on the form; rosters are keyed in the second round.
 */
export function layoutForm(
  compiled: CompiledQuestionnaire,
  lang: string,
  words: LayoutWords,
  measure: Measure,
): FormLayout {
  const ops: DrawOp[] = [];
  const questions: LaidQuestion[] = [];
  const settings = compiled.questionnaire.settings;
  let page = 1;
  let y = TOP;
  let number = 0;

  const textRows = (s: string, size: number, font: Font, x: number, w: number): Row[] =>
    wrap(s, w, size, font, measure).map((line) => ({
      h: size + 3,
      draw: (p, yy) => ({
        ops: [{ page: p, op: 'text', x, y: yy + size, size, text: line, font }],
        bubbles: [],
      }),
    }));

  const place = (rows: Row[], header: () => Row[], q?: LaidQuestion) => {
    const total = rows.reduce((a, r) => a + r.h, 0);
    // A short question is kept whole; a long one breaks between its rows.
    if (y + Math.min(total, BOTTOM - TOP) > BOTTOM && y > TOP) {
      page++;
      y = TOP;
    }
    let start = y;
    rows.forEach((r, i) => {
      if (y + r.h > BOTTOM) {
        if (q) q.rects.push({ page, x: LEFT - 4, y: start - 3, w: WIDTH + 8, h: y - start + 6 });
        page++;
        y = TOP;
        start = y;
        for (const hr of header()) {
          const d = hr.draw(page, y);
          ops.push(...d.ops);
          y += hr.h;
        }
      }
      const d = r.draw(page, y);
      ops.push(...d.ops);
      if (q) q.bubbles.push(...d.bubbles);
      y += r.h;
      void i;
    });
    if (q) q.rects.push({ page, x: LEFT - 4, y: start - 3, w: WIDTH + 8, h: y - start + 6 });
    y += 9;
  };

  const specialsOf = (q: Question): SpecialKind[] => {
    const out: SpecialKind[] = [];
    if (q.allowDK !== false && settings.specialCodes.DK.offeredIn.includes('PAPI')) out.push('DK');
    if (q.allowRefused !== false && settings.specialCodes.RF.offeredIn.includes('PAPI'))
      out.push('RF');
    return out;
  };

  /** A row of bubbles with their labels, side by side. */
  const bubbleRow = (
    items: { label: string; code?: string | number; special?: SpecialKind; row?: string }[],
    x0: number,
    w: number,
  ): Row => {
    const step = w / Math.max(1, items.length);
    return {
      h: LINE + 4,
      draw: (p, yy) => {
        const out: { ops: DrawOp[]; bubbles: Bubble[] } = { ops: [], bubbles: [] };
        items.forEach((it, i) => {
          const bx = x0 + i * step + BUBBLE_R + 1;
          const by = yy + BUBBLE_R + 2;
          out.ops.push({ page: p, op: 'bubble', x: bx, y: by });
          const b: Bubble = { page: p, x: bx, y: by };
          if (it.code !== undefined) b.code = it.code;
          if (it.special) b.special = it.special;
          if (it.row !== undefined) b.row = it.row;
          out.bubbles.push(b);
          out.ops.push({
            page: p,
            op: 'text',
            x: bx + BUBBLE_R + 3,
            y: by + 3,
            size: 8,
            text: printable(it.label).slice(0, 40),
            font: 'regular',
          });
        });
        return out;
      },
    };
  };

  for (const node of compiled.nodes) {
    if (node.rosterChain.length) continue;
    if (node.kind === 'section') {
      const title = tx((node.def as { title?: LocalizedText }).title, lang);
      if (title) place(textRows(title, 11, 'bold', LEFT, WIDTH), () => []);
      continue;
    }
    if (node.kind === 'roster') {
      // Rosters are written on paper and keyed in the second round.
      const name = node.name ?? '';
      const lq: LaidQuestion = {
        name,
        type: 'text',
        reading: 'manual',
        numeric: false,
        bubbles: [],
        rects: [],
      };
      const title = tx((node.def as { title?: LocalizedText }).title, lang) || name;
      const rows = [
        ...textRows(`${title}  (${words.writeHere})`, TEXT, 'bold', LEFT, WIDTH),
        ...Array.from({ length: 6 }, () => ({
          h: 18,
          draw: (p: number, yy: number) => ({
            ops: [{ page: p, op: 'line' as const, x: LEFT, y: yy + 15, w: WIDTH }],
            bubbles: [],
          }),
        })),
      ];
      place(rows, () => [], lq);
      questions.push(lq);
      continue;
    }
    if (node.kind !== 'question') continue;
    const q = node.def as Question;
    if (q.variants?.PAPI?.visibleInMode === false) continue;
    number++;
    const text = `${number}. ${tx(q.variants?.PAPI?.text ?? q.text, lang)}`;
    const head = () => textRows(`${number}. (${words.continued})`, 8, 'regular', LEFT, WIDTH);
    const rows: Row[] = [...textRows(text, TEXT, 'bold', LEFT, WIDTH)];
    const options = questionOptions(q, compiled.questionnaire);
    const specials = specialsOf(q);
    const scalePoints: number[] = [];
    if (q.type === 'scale') {
      const min = q.scale?.min ?? q.min ?? 0;
      const max = q.scale?.max ?? q.max ?? 10;
      const step = q.scale?.step ?? 1;
      for (let v = min; v <= max + 1e-9 && scalePoints.length <= 12; v += step)
        scalePoints.push(Math.round(v * 1e6) / 1e6);
    }
    const marks =
      ((q.type === 'single' || q.type === 'multi' || q.type === 'yesno') && options.length > 0) ||
      (q.type === 'grid' && options.length > 0 && (q.rows?.length ?? 0) > 0) ||
      (q.type === 'scale' && scalePoints.length > 0 && scalePoints.length <= 11);
    const lq: LaidQuestion = {
      name: q.name,
      type: q.type,
      reading: marks ? 'marks' : 'manual',
      numeric: q.type === 'scale',
      bubbles: [],
      rects: [],
    };
    if (q.type === 'multi') rows.push(...textRows(words.markAll, 8, 'regular', LEFT, WIDTH));

    if (q.type === 'single' || q.type === 'multi' || q.type === 'yesno') {
      // One or two columns of options, each with its code.
      const labels = options.map((o) => `${o.code}  ${tx(o.label, lang)}`);
      const twoCols =
        options.length >= 5 && labels.every((l) => measure(l, TEXT, 'regular') < WIDTH / 2 - 30);
      const cols = twoCols ? 2 : 1;
      const colW = WIDTH / cols;
      for (let i = 0; i < options.length; i += cols) {
        const chunk = options.slice(i, i + cols);
        const lines = chunk.map((o) =>
          wrap(`${o.code}  ${tx(o.label, lang)}`, colW - 26, TEXT, 'regular', measure),
        );
        const h = Math.max(...lines.map((l) => l.length)) * LINE + 4;
        rows.push({
          h,
          draw: (p, yy) => {
            const out: { ops: DrawOp[]; bubbles: Bubble[] } = { ops: [], bubbles: [] };
            chunk.forEach((o, c) => {
              const x = LEFT + c * colW;
              const bx = x + BUBBLE_R + 2;
              const by = yy + BUBBLE_R + 1.5;
              out.ops.push({ page: p, op: 'bubble', x: bx, y: by });
              out.bubbles.push({ page: p, x: bx, y: by, code: o.code });
              lines[c]!.forEach((line, k) =>
                out.ops.push({
                  page: p,
                  op: 'text',
                  x: x + 18,
                  y: yy + TEXT + k * LINE,
                  size: TEXT,
                  text: line,
                  font: 'regular',
                }),
              );
            });
            return out;
          },
        });
      }
    } else if (q.type === 'scale' && marks) {
      rows.push(
        bubbleRow(
          scalePoints.map((v) => ({ label: String(v), code: v })),
          LEFT,
          Math.min(WIDTH, scalePoints.length * 42),
        ),
      );
      const ends = [tx(q.scale?.minLabel, lang), tx(q.scale?.maxLabel, lang)].filter(Boolean);
      if (ends.length) rows.push(...textRows(ends.join('  ...  '), 7.5, 'regular', LEFT, WIDTH));
    } else if (q.type === 'grid' && marks) {
      // A table: one row per item, one column per option (code above), then the specials.
      const firstW = WIDTH * 0.42;
      const cols = [
        ...options.map((o) => ({ label: String(o.code), code: o.code as string | number })),
        ...specials.map((k) => ({ label: words.special[k], special: k })),
      ];
      const cellW = (WIDTH - firstW) / cols.length;
      const header: Row = {
        h: LINE,
        draw: (p, yy) => ({
          ops: cols.map((c, i) => ({
            page: p,
            op: 'text' as const,
            x: LEFT + firstW + i * cellW + cellW / 2 - 4,
            y: yy + 8,
            size: 7.5,
            text: printable(c.label).slice(0, 6),
            font: 'mono' as const,
          })),
          bubbles: [],
        }),
      };
      const legend = options.map((o) => `${o.code} = ${tx(o.label, lang)}`).join(';  ');
      rows.push(...textRows(legend, 7.5, 'regular', LEFT, WIDTH), header);
      for (const r of q.rows ?? []) {
        const lines = wrap(tx(r.label, lang), firstW - 6, 8.5, 'regular', measure);
        rows.push({
          h: Math.max(lines.length * 10 + 4, 16),
          draw: (p, yy) => {
            const out: { ops: DrawOp[]; bubbles: Bubble[] } = { ops: [], bubbles: [] };
            lines.forEach((line, k) =>
              out.ops.push({
                page: p,
                op: 'text',
                x: LEFT,
                y: yy + 9 + k * 10,
                size: 8.5,
                text: line,
                font: 'regular',
              }),
            );
            cols.forEach((c, i) => {
              const bx = LEFT + firstW + i * cellW + cellW / 2;
              const by = yy + 7;
              out.ops.push({ page: p, op: 'bubble', x: bx, y: by });
              const b: Bubble = { page: p, x: bx, y: by, row: r.code };
              if ('code' in c) b.code = c.code;
              if ('special' in c && c.special) b.special = c.special;
              out.bubbles.push(b);
            });
            return out;
          },
        });
      }
    } else {
      // Written by hand: boxes for figures, lines for words.
      const boxes =
        q.type === 'numeric'
          ? Math.min(
              12,
              Math.max(2, String(Math.trunc(Math.abs(q.max ?? 999))).length + (q.decimals ?? 0)),
            )
          : q.type === 'date'
            ? 8
            : q.type === 'time'
              ? 4
              : q.type === 'datetime'
                ? 12
                : 0;
      if (boxes) {
        rows.push({
          h: 24,
          draw: (p, yy) => ({
            ops: Array.from({ length: boxes }, (_, i) => ({
              page: p,
              op: 'box' as const,
              x: LEFT + i * 18,
              y: yy + 2,
              w: 18,
              h: 20,
            })),
            bubbles: [],
          }),
        });
      } else {
        const lines = q.type === 'text' && (q.maxLength ?? 0) > 120 ? 4 : 2;
        for (let i = 0; i < lines; i++)
          rows.push({
            h: 18,
            draw: (p, yy) => ({
              ops: [{ page: p, op: 'line', x: LEFT, y: yy + 15, w: WIDTH }],
              bubbles: [],
            }),
          });
      }
    }
    // Don't know / refused as bubbles under the answer (grids have them as columns).
    if (specials.length && q.type !== 'grid')
      rows.push(
        bubbleRow(
          specials.map((k) => ({ label: words.special[k], special: k })),
          LEFT,
          Math.min(WIDTH, specials.length * 150),
        ),
      );
    place(rows, head, lq);
    questions.push(lq);
  }
  return { pages: page, questions, ops };
}

const hex = (b: Buffer) => b.toString('hex');
const uuidOf = (b: Buffer) => {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * What each page's code says, kept short so the code stays large and easy to read:
 * `WSP1.<case and version ids, base64url>.<lang>.<page>.<pages>`.
 */
export function pageCode(caseId: string, versionId: string, lang: string, n: number, of: number) {
  const ids = Buffer.from(caseId.replace(/-/g, '') + versionId.replace(/-/g, ''), 'hex');
  return `WSP${LAYOUT_VERSION}.${ids.toString('base64url')}.${lang}.${n}.${of}`;
}

export function parsePageCode(s: string) {
  const m = /^WSP(\d+)\.([A-Za-z0-9_-]{43})\.([A-Za-z-]{2,16})\.(\d+)\.(\d+)$/.exec(s);
  if (!m || Number(m[1]) !== LAYOUT_VERSION) return null;
  const ids = Buffer.from(m[2]!, 'base64url');
  if (ids.length !== 32) return null;
  return {
    caseId: uuidOf(ids.subarray(0, 16)),
    versionId: uuidOf(ids.subarray(16)),
    lang: m[3]!,
    page: Number(m[4]),
    pages: Number(m[5]),
  };
}

/** Centres of the four corner squares, in page points (top left, top right, bottom left, bottom right). */
export function fiducialCentres() {
  const c = FIDUCIAL / 2;
  return [
    { x: MARGIN + c, y: MARGIN + c },
    { x: PAGE.w - MARGIN - c, y: MARGIN + c },
    { x: MARGIN + c, y: PAGE.h - MARGIN - c },
    { x: PAGE.w - MARGIN - c, y: PAGE.h - MARGIN - c },
  ];
}

/** Where the page code sits (between the top corner squares). */
export const QR_AT = { x: PAGE.w - MARGIN - FIDUCIAL - 10 - QR_SIZE, y: MARGIN };
