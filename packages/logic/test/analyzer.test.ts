import { describe, expect, it } from 'vitest';
import { Questionnaire, type ContainerItem } from '@wansurvey/schema';
import { analyze } from '../src/analyzer.js';
import { compile, CompileError } from '../src/compile.js';
import { household } from '@wansurvey/fixtures';
import { en, num, q, single } from './builders.js';

const codes = (qq: Questionnaire) =>
  analyze(qq)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.code);

describe('static analysis', () => {
  it('the demo household survey compiles cleanly', () => {
    const { diagnostics, canPublish } = analyze(Questionnaire.parse(household));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(canPublish).toBe(true);
    const compiled = compile(household);
    expect(compiled.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(compile(household).hash).toBe(compiled.hash);
  });

  it('compiled output is plain JSON', () => {
    const compiled = compile(household);
    expect(JSON.parse(JSON.stringify(compiled))).toEqual(compiled);
  });

  it('builds a dependency graph from variables to dependent items', () => {
    const c = compile(household);
    const dependents = (v: string) => c.dependents[v]!.map((i) => c.nodes[i]!.id);
    expect(dependents('C4_WATER')).toEqual(expect.arrayContaining(['C4', 'C5']));
    expect(dependents('B1_HHSIZE')).toEqual(expect.arrayContaining(['B2', 'HH']));
    expect(dependents('HH')).toEqual(expect.arrayContaining(['M2', 'M4', 'M6', 'B3', 'B3B']));
  });

  it('flags unknown variables and functions', () => {
    expect(codes(q([single('A', { showIf: 'NOPE == 1' })]))).toContain('unknown_variable');
    expect(codes(q([single('A', { showIf: 'frob(1)' })]))).toContain('unknown_function');
    expect(codes(q([single('A', { showIf: 'constructor == 1' })]))).toContain('unknown_variable');
    expect(codes(q([single('A', { showIf: 'toString(1)' })]))).toContain('unknown_function');
  });

  it('flags syntax errors', () => {
    expect(codes(q([single('A', { showIf: '1 +' })]))).toContain('syntax');
  });

  it('flags type mismatches', () => {
    const items = [
      single('A'),
      { kind: 'question', id: 'T1', name: 'T1', type: 'text', text: en('t') } as ContainerItem,
      {
        kind: 'question',
        id: 'M',
        name: 'M',
        type: 'multi',
        text: en('m'),
        options: [{ code: 1, label: en('x') }],
      } as ContainerItem,
      num('N1', { showIf: 'T1 + 1 > 2' }),
      num('N2', { showIf: 'M == 1' }),
      num('N3', { showIf: 'T1 > 3' }),
      num('N4', { showIf: 'contains(A, 1)' }),
    ];
    const errs = analyze(q(items))
      .diagnostics.filter((d) => d.code === 'type_mismatch')
      .map((d) => d.itemId);
    expect(errs).toEqual(expect.arrayContaining(['N1', 'N2', 'N3', 'N4']));
  });

  it('treats codes that are not in the answer set as errors (L13)', () => {
    const d = analyze(q([single('A'), num('B', { showIf: 'A == 7' })])).diagnostics;
    expect(d).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'unknown_code',
        itemId: 'B',
        msg: { id: 'unknown_code', params: { code: '7', name: 'A' } },
      }),
    );
  });

  it('treats missing translations as errors (L13)', () => {
    const r = analyze(
      q([{ ...single('A'), text: { en: 'A?' } } as never], {
        languages: ['en', 'es'],
      }),
    );
    expect(r.canPublish).toBe(false);
    expect(r.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'missing_translation',
        msg: { id: 'missing_translation', params: { langs: 'es' } },
      }),
    );
  });

  it('gives every diagnostic a message id', () => {
    const r = analyze(
      q([single('A', { showIf: 'NOPE == 1', skips: [{ when: 'A == 1', to: 'X' }] }), num('B')]),
    );
    expect(r.diagnostics.length).toBeGreaterThan(1);
    for (const d of r.diagnostics) expect(d.msg?.id, d.code).toBeTruthy();
  });

  it('flags forward references in conditions', () => {
    expect(codes(q([single('A', { showIf: 'B == 1' }), single('B')]))).toContain(
      'forward_reference',
    );
    // a question's own checks may read its own answer
    expect(
      codes(
        q([
          num('A', {
            validations: [{ id: 'v', severity: 'error', when: 'A > 3', message: en('x') }],
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('flags skips that go backwards, to unknown targets or across rosters', () => {
    expect(
      codes(q([single('A'), single('B', { skips: [{ when: 'B == 1', to: 'A' }] })])),
    ).toContain('backward_skip');
    expect(codes(q([single('A', { skips: [{ when: 'A == 1', to: 'ZZZ' }] })]))).toContain(
      'unknown_skip_target',
    );
    expect(codes(q([single('A', { skips: [{ when: 'A == 1', to: 'END_ROW' }] })]))).toContain(
      'skip_scope',
    );
    const roster: ContainerItem = {
      kind: 'roster',
      id: 'R',
      name: 'R',
      count: { type: 'fixed', n: 2 },
      items: [num('X', { skips: [{ when: 'X == 1', to: 'AFTER' }] })],
    };
    expect(codes(q([roster, single('AFTER')]))).toContain('skip_scope');
  });

  it('flags unreachable items', () => {
    expect(codes(q([single('A', { showIf: '1 == 2' })]))).toContain('unreachable');
    const d = analyze(
      q([single('A', { skips: [{ when: 'true', to: 'C' }] }), single('B'), single('C')]),
    ).diagnostics;
    expect(d).toContainEqual(expect.objectContaining({ code: 'unreachable', itemId: 'B' }));
  });

  it('flags cycles in computed variables', () => {
    const self = {
      kind: 'computed',
      id: 'C1',
      name: 'C1',
      valueType: 'number',
      formula: 'C1 + 1',
    } as ContainerItem;
    expect(codes(q([self]))).toContain('computed_cycle');
    const a = {
      kind: 'computed',
      id: 'CA',
      name: 'CA',
      valueType: 'number',
      formula: 'CB + 1',
    } as ContainerItem;
    const b = {
      kind: 'computed',
      id: 'CB',
      name: 'CB',
      valueType: 'number',
      formula: 'CA + 1',
    } as ContainerItem;
    expect(codes(q([a, b]))).toEqual(
      expect.arrayContaining(['computed_cycle', 'forward_reference']),
    );
  });

  it('flags missing and malformed pipes', () => {
    const missing = { kind: 'static', id: 'S', text: en('Hello {{NAME}}') } as ContainerItem;
    expect(codes(q([missing]))).toContain('missing_pipe');
    const later = { kind: 'static', id: 'S', text: en('Hello {{A}}') } as ContainerItem;
    expect(codes(q([later, single('A')]))).toContain('missing_pipe');
    const bad = { kind: 'static', id: 'S', text: en('Hello {{#if 1}}x') } as ContainerItem;
    expect(codes(q([bad]))).toContain('pipe_syntax');
    const ok = {
      kind: 'static',
      id: 'S',
      text: en('Hello {{A | label}} in {{case.city}}'),
    } as ContainerItem;
    expect(codes(q([single('A'), ok]))).toEqual([]);
  });

  it('flags duplicate variables, reserved names and code clashes', () => {
    expect(codes(q([single('A'), { ...single('B'), name: 'A' } as ContainerItem]))).toContain(
      'duplicate_variable',
    );
    expect(codes(q([{ ...single('A'), name: 'mode' } as ContainerItem]))).toContain(
      'reserved_name',
    );
    expect(codes(q([single('A', { options: [{ code: -8, label: en('x') }] })]))).toContain(
      'special_code_clash',
    );
    expect(
      codes(
        q([
          single('A', {
            options: [
              { code: 1, label: en('x') },
              { code: 1, label: en('y') },
            ],
          }),
        ]),
      ),
    ).toContain('duplicate_code');
    expect(codes(q([single('A', { options: undefined, answerSetId: 'NOPE' })]))).toContain(
      'unknown_answer_set',
    );
  });

  it('roster variables are only visible inside the roster or through roster functions', () => {
    const roster: ContainerItem = {
      kind: 'roster',
      id: 'R',
      name: 'R',
      count: { type: 'fixed', n: 2 },
      items: [num('X')],
    };
    expect(codes(q([roster, num('B', { showIf: 'X > 1' })]))).toContain('roster_scope');
    expect(
      codes(q([roster, num('B', { showIf: 'any(R, X > 1) and R[1].X > 0 and sum(R.X) > 2' })])),
    ).toEqual([]);
  });

  it('compile throws CompileError listing the problems', () => {
    expect(() => compile(q([single('A', { showIf: 'NOPE == 1' })]))).toThrow(CompileError);
  });
});
