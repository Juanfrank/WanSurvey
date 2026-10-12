import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AnswerValue, Question } from '@wansurvey/schema';
import { compile, type CompiledQuestionnaire } from '../src/compile.js';
import { createInterview, type InterviewOptions } from '../src/engine.js';
import { evaluate } from '../src/evaluator.js';
import { parse } from '../src/parser.js';
import type { Value } from '../src/values.js';
import { household } from './fixtures/household.js';
import { mapScope } from './helpers.js';

// ---------------------------------------------------------------------------
// Expression generator
// ---------------------------------------------------------------------------

const VARS = ['A', 'B', 'C', 'M', 'T', 'D', 'R'];
const FUNCS = [
  'answered',
  'count',
  'sum',
  'min',
  'max',
  'length',
  'contains',
  'age',
  'datediff',
  'today',
  'label',
  'isDK',
  'isRefused',
  'rosterCount',
  'any',
  'all',
  'round',
  'abs',
  'date',
];

const { expr } = fc.letrec<{ expr: string; atom: string }>((tie) => ({
  atom: fc.oneof(
    fc.integer({ min: -5, max: 200 }).map(String),
    fc.double({ min: -100, max: 100, noNaN: true }).map((n) => n.toFixed(2)),
    fc.constantFrom('"x"', '"2026-01-01"', 'true', 'false', 'null'),
    fc.constantFrom(...VARS),
    fc.constantFrom('R[1].X', 'R.X', 'case.region', 'mode', 'index'),
  ),
  expr: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    tie('atom'),
    fc
      .tuple(
        tie('expr'),
        fc.constantFrom(
          '+',
          '-',
          '*',
          '/',
          '^',
          '%',
          '==',
          '!=',
          '<',
          '<=',
          '>',
          '>=',
          'and',
          'or',
        ),
        tie('expr'),
      )
      .map(([a, op, b]) => `(${a} ${op} ${b})`),
    tie('expr').map((a) => `(not ${a})`),
    tie('expr').map((a) => `(-${a})`),
    fc
      .tuple(tie('atom'), fc.array(tie('atom'), { minLength: 1, maxLength: 3 }))
      .map(([a, l]) => `(${a} in (${l.join(', ')}))`),
    fc
      .tuple(tie('atom'), tie('atom'), tie('atom'))
      .map(([a, b, c]) => `(${a} between ${b} and ${c})`),
    fc
      .tuple(fc.constantFrom(...FUNCS), fc.array(tie('expr'), { maxLength: 3 }))
      .map(([f, args]) => `${f}(${args.join(', ')})`),
  ),
}));

const value: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.integer({ min: -10, max: 200 }),
  fc.double({ noNaN: false }),
  fc.string({ maxLength: 5 }),
  fc.boolean(),
  fc.constantFrom<Value>({ $special: 'DK' }, { $special: 'RF' }),
  fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 3 }),
  fc.constant('2001-02-03'),
);

const env = fc.record({
  A: value,
  B: value,
  C: value,
  M: value,
  T: value,
  D: value,
  R: fc.array(fc.record({ X: value }), { maxLength: 3 }),
});

describe('property: evaluator', () => {
  it('never throws, for any expression and any answers', () => {
    fc.assert(
      fc.property(expr, env, (src, vars) => {
        const scope = mapScope(vars as Record<string, Value>, {
          rosters: { R: ['X'] },
          ns: { case: { region: 2 } },
        });
        evaluate(parse(src), scope);
      }),
      { numRuns: 3000 },
    );
  });

  it('comparisons with an unanswered or special value are always false', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('==', '!=', '<', '<=', '>', '>='),
        value,
        fc.constantFrom<Value>(null, { $special: 'DK' }, { $special: 'RF' }, ''),
        fc.boolean(),
        (op, other, missing, left) => {
          const src = left ? `X ${op} Y` : `Y ${op} X`;
          return evaluate(parse(src), mapScope({ X: missing, Y: other })) === false;
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('evaluation is identical after a JSON round trip of the AST (client ↔ server)', () => {
    fc.assert(
      fc.property(expr, env, (src, vars) => {
        const ast = parse(src);
        const shipped = JSON.parse(JSON.stringify(ast));
        const scope = mapScope(vars as Record<string, Value>, { rosters: { R: ['X'] } });
        expect(JSON.stringify(evaluate(shipped, scope))).toBe(JSON.stringify(evaluate(ast, scope)));
      }),
      { numRuns: 1500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Random interviews
// ---------------------------------------------------------------------------

const compiled = compile(household);
const opts: InterviewOptions = {
  mode: 'CATI',
  context: {
    case: { city: 'Lima', region: 1 },
    respondent: { firstName: 'X' },
    interviewer: { firstName: 'Y' },
  },
  now: () => new Date('2026-10-12T00:00:00Z'),
  seed: 'p',
};

function randomAnswer(c: CompiledQuestionnaire, id: string, r: () => number): AnswerValue {
  const node = c.nodes[c.byId[id]!]!;
  const q = node.def as Question;
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  if (r() < 0.07) return null;
  if (r() < 0.07) return { $special: pick(['DK', 'RF'] as const) };
  switch (q.type) {
    case 'single':
    case 'yesno':
      return pick([1, 2, 3, 99]);
    case 'multi':
    case 'ranking':
      return [1, 2, 3, 99].filter(() => r() < 0.4);
    case 'numeric':
      return Math.floor(r() * 40) - 2;
    case 'scale':
      return Math.floor(r() * 12);
    case 'text':
      return pick(['', 'Ana', '5551234', 'x y']);
    case 'date':
    case 'datetime':
      return pick(['2026-01-05', '2027-01-01', 'nope']);
    case 'time':
      return pick(['10:00', '99:00']);
    case 'grid':
      return { a: pick([1, 2]), b: pick([3, 4]) };
  }
}

describe('property: routing determinism', () => {
  it('an incrementally built interview is a fixed point when replayed (client vs server)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(10_000), fc.integer()), { minLength: 1, maxLength: 80 }),
        (ops) => {
          const s = createInterview(compiled, opts);
          for (const [pick, seed] of ops) {
            const path = s.trace().filter((e) => e.status === 'active' && e.kind === 'question');
            if (path.length === 0) break;
            const entry = path[pick % path.length]!;
            let x = seed;
            const r = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
            s.setAnswer(entry.key, randomAnswer(compiled, entry.id, r));
          }
          const shipped: CompiledQuestionnaire = JSON.parse(JSON.stringify(compiled));
          // Full state (what the device syncs) reproduces everything exactly.
          const fromState = createInterview(shipped, { ...opts, state: s.state() });
          expect(fromState.pathKeys()).toEqual(s.pathKeys());
          expect(fromState.getAnswers()).toEqual(s.getAnswers());
          // Answers alone (what the server re-runs on submit) reproduce the path.
          const fromAnswers = createInterview(shipped, {
            ...opts,
            state: { answers: s.getAnswers() },
          });
          expect(fromAnswers.pathKeys()).toEqual(s.pathKeys());
          expect(fromAnswers.drainEvents().filter((e) => e.reason === 'path_change')).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });
});
