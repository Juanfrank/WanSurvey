import { describe, expect, it } from 'vitest';
import { Questionnaire, type ContainerItem } from '@wansurvey/schema';
import { analyze } from '../src/analyzer.js';
import { compile } from '../src/compile.js';
import { createInterview } from '../src/engine.js';
import { orderItems } from '../src/order.js';
import { parseTemplate, templateBlankableFields } from '../src/piping.js';
import { en, q, single } from './builders.js';

const diag = (qq: Questionnaire, code: string) =>
  analyze(qq).diagnostics.filter((d) => d.code === code);

const static_ = (id: string, text: string): ContainerItem =>
  ({ kind: 'static', id, text: en(text) }) as ContainerItem;

const yesno = (id: string, extra: Record<string, unknown> = {}): ContainerItem =>
  ({ kind: 'question', id, name: id, type: 'yesno', text: en(id), ...extra }) as ContainerItem;

const block = (id: string, items: ContainerItem[], extra: Record<string, unknown> = {}) =>
  ({ kind: 'block', id, items, ...extra }) as ContainerItem;

describe('insertions that can come blank (item 149)', () => {
  const fields = (src: string) => templateBlankableFields(parseTemplate(src));

  it('finds case and respondent fields without a fallback', () => {
    expect(fields('Hola {{respondent.firstName}}, en {{case.city}}.')).toEqual([
      'respondent.firstName',
      'case.city',
    ]);
    expect(fields('en {{case.city | default:"su ciudad"}}')).toEqual([]);
    expect(fields('{{interviewer.firstName}} {{A}}')).toEqual([]);
  });

  it('a field tested by an {{#if}} is safe in its first branch only', () => {
    expect(fields('{{#if case.city}}en {{case.city}}{{/if}}')).toEqual([]);
    expect(fields('{{#if case.city}}x{{else}}en {{case.city}}{{/if}}')).toEqual(['case.city']);
    expect(fields('{{#if case.city != ""}}en {{case.city}}{{/if}}')).toEqual([]);
    expect(fields('{{#if not case.city}}en {{case.city}}{{/if}}')).toEqual(['case.city']);
    expect(fields('{{#if case.city == ""}}en {{case.city}}{{/if}}')).toEqual(['case.city']);
  });

  it('warns once per text, with the field to give a fallback to', () => {
    const qq = q([static_('INTRO', 'Hi {{case.city}}, {{case.city}}')], {
      languages: ['en', 'es'],
    } as never);
    const qq2 = Questionnaire.parse({
      ...qq,
      sections: [
        {
          id: 'S1',
          title: { en: 'S', es: 'S' },
          items: [
            {
              kind: 'static',
              id: 'INTRO',
              text: { en: 'Hi {{case.city}}', es: 'Hola {{case.city}}' },
            },
          ],
        },
      ],
    });
    const found = diag(qq2, 'pipe_may_be_empty');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'warning',
      itemId: 'INTRO',
      field: 'text',
      msg: { id: 'pipe_may_be_empty', params: { pipe: 'case.city' } },
    });
    expect(analyze(qq2).canPublish).toBe(true);
  });
});

describe('methodological warnings (item 151)', () => {
  it('shuffled ordered scales', () => {
    const grid = {
      kind: 'question',
      id: 'G',
      name: 'G',
      type: 'grid',
      text: en('g'),
      options: [
        { code: 1, label: en('Bad') },
        { code: 2, label: en('Good') },
      ],
      rows: [{ code: 'a', label: en('A') }],
      randomizeOptions: true,
    } as ContainerItem;
    expect(diag(q([grid]), 'random_ordinal')).toHaveLength(1);
    expect(diag(q([single('A', { randomizeOptions: true })]), 'random_ordinal')).toHaveLength(0);
  });

  it('"Don\'t know" for a consent or a phone number', () => {
    const consent = yesno('CONSENT', { endIf: [{ when: 'CONSENT == 2', disposition: 'REFUSAL' }] });
    const recontact = yesno('E1_RECONTACT');
    const phone = {
      kind: 'question',
      id: 'PHONE',
      name: 'PHONE',
      type: 'text',
      format: 'phone',
      text: en('Phone?'),
    } as ContainerItem;
    const qq = q([consent, recontact, phone]);
    const found = diag(qq, 'dk_not_meaningful').map((d) => [d.itemId, d.msg!.id]);
    expect(found).toEqual([
      ['CONSENT', 'dk_on_consent'],
      ['E1_RECONTACT', 'dk_on_consent'],
      ['PHONE', 'dk_on_contact'],
    ]);
    expect(diag(q([{ ...phone, allowDK: false } as ContainerItem]), 'dk_not_meaningful')).toEqual(
      [],
    );
    // Not offered in any mode used: nothing to warn about.
    expect(diag(q([phone], { modes: ['CAWI'] }), 'dk_not_meaningful')).toEqual([]);
  });

  it('a sensitive, required question with no way out on the web', () => {
    const s = single('HEALTH', { sensitive: 'health' });
    expect(diag(q([s], { modes: ['CAWI'] }), 'forced_response')).toHaveLength(1);
    expect(diag(q([s], { modes: ['CAPI'] }), 'forced_response')).toHaveLength(0);
    expect(
      diag(
        q([single('HEALTH', { sensitive: 'health', required: false })], { modes: ['CAWI'] }),
        'forced_response',
      ),
    ).toHaveLength(0);
    expect(
      diag(
        q([s], {
          modes: ['CAWI'],
          settings: {
            specialCodes: {
              DK: { code: -8, label: en('DK'), offeredIn: [] },
              RF: { code: -9, label: en('RF'), offeredIn: ['CAWI'] },
              NA: { code: -7, label: en('NA'), offeredIn: [] },
            },
          } as never,
        }),
        'forced_response',
      ),
    ).toHaveLength(0);
    expect(
      diag(
        q([s], {
          modes: ['CAWI'],
          settings: { cawiShowSpecialCodes: true } as never,
        }),
        'forced_response',
      ),
    ).toHaveLength(0);
  });

  it('a grid with too many rows for a phone', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ code: `r${i}`, label: en(`R${i}`) }));
    const grid = (n: number) =>
      ({
        kind: 'question',
        id: 'G',
        name: 'G',
        type: 'grid',
        text: en('g'),
        options: [{ code: 1, label: en('Yes') }],
        rows: rows(n),
      }) as ContainerItem;
    expect(diag(q([grid(8)]), 'grid_too_long')[0]?.msg?.params).toMatchObject({ rows: 8, max: 7 });
    expect(diag(q([grid(7)]), 'grid_too_long')).toHaveLength(0);
    expect(diag(q([grid(8)], { modes: ['CATI'] }), 'grid_too_long')).toHaveLength(0);
  });

  it('"Other" with nowhere to write', () => {
    const opts = (otherSpecify?: boolean) => [
      { code: 1, label: en('Bus') },
      { code: 9, label: { en: 'Other (specify)' }, ...(otherSpecify ? { otherSpecify } : {}) },
    ];
    expect(diag(q([single('A', { options: opts() })]), 'other_without_specify')[0]).toMatchObject({
      msg: { params: { codes: '9' } },
    });
    expect(diag(q([single('A', { options: opts(true) })]), 'other_without_specify')).toEqual([]);
  });

  it('a Yes/No question that asks two things', () => {
    expect(
      diag(q([yesno('A', { text: en('Do you own a car and a house?') })]), 'double_barreled'),
    ).toHaveLength(1);
    expect(
      diag(
        q([yesno('A', { text: { es: '¿Tiene auto o casa?' } })], {
          languages: ['es'],
          defaultLanguage: 'es',
        } as never),
        'double_barreled',
      ),
    ).toHaveLength(1);
    expect(diag(q([yesno('A', { text: en('Do you own a car?') })]), 'double_barreled')).toEqual([]);
  });

  it('all are warnings: publishing is not blocked', () => {
    const qq = q([single('HEALTH', { sensitive: 'health' })], { modes: ['CAWI'] });
    expect(analyze(qq).canPublish).toBe(true);
  });
});

describe('item order (item 153)', () => {
  it('rotates or shuffles, keeps fixed items, and is seeded', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const r = orderItems(ids, { type: 'rotate' }, 's1');
    const start = ids.indexOf(r[0]!);
    expect(r).toEqual([...ids.slice(start), ...ids.slice(0, start)]);
    const shuffled = orderItems(ids, { type: 'random', fixed: ['A', 'E'] }, 's2');
    expect(shuffled[0]).toBe('A');
    expect(shuffled[4]).toBe('E');
    expect([...shuffled].sort()).toEqual(ids);
    expect(orderItems(ids, { type: 'random' }, 'x')).toEqual(
      orderItems(ids, { type: 'random' }, 'x'),
    );
    // Different seeds give different orders across interviews.
    const seen = new Set(
      Array.from({ length: 30 }, (_, i) => orderItems(ids, { type: 'random' }, `i${i}`).join()),
    );
    expect(seen.size).toBeGreaterThan(5);
  });

  const ordered = (extra: Record<string, unknown> = {}) =>
    q([
      single('Q0'),
      block(
        'ROT',
        [block('B1', [single('A1')]), block('B2', [single('A2')]), block('B3', [single('A3')])],
        { itemOrder: { type: 'random', variable: 'ROT_ORDER' }, ...extra },
      ),
      single('Q9'),
    ]);

  it("walks the blocks in the interview's order and records it", () => {
    const compiled = compile(ordered());
    const orders = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = createInterview(compiled, { mode: 'CAPI', seed: `int-${i}` });
      const path = s.pathKeys();
      const recorded = s.getAnswer('ROT_ORDER') as string;
      expect(path[0]).toBe('Q0');
      expect(path[4]).toBe('Q9');
      expect(recorded.split(',').map((b) => `A${b.slice(1)}`)).toEqual(path.slice(1, 4));
      // The same seed always gives the same order (client, server, replay).
      expect(
        createInterview(compiled, { mode: 'CAPI', seed: `int-${i}` }).getAnswer('ROT_ORDER'),
      ).toBe(recorded);
      orders.add(recorded);
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('the recorded order cannot be answered and is cleared when the block is hidden', () => {
    const qq = q([
      single('Q0'),
      block('ROT', [single('A1'), single('A2')], {
        showIf: 'Q0 == 1',
        itemOrder: { type: 'rotate', variable: 'ROT_ORDER' },
      }),
    ]);
    const s = createInterview(compile(qq), { mode: 'CAPI', seed: 'x' });
    expect(s.setAnswer('ROT_ORDER', 'A2,A1').ok).toBe(false);
    s.setAnswer('Q0', 1);
    expect(s.getAnswer('ROT_ORDER')).toMatch(/^A[12],A[12]$/);
    s.setAnswer('Q0', 2);
    expect(s.getAnswer('ROT_ORDER')).toBe(null);
  });

  it('the order variable is a declared variable: no duplicates, readable later', () => {
    const qq = q([
      block('ROT', [single('A1'), single('A2')], {
        itemOrder: { type: 'random', variable: 'A1' },
      }),
    ]);
    expect(diag(qq, 'duplicate_variable')).toHaveLength(1);
    const ok = q([
      block('ROT', [single('A1'), single('A2')], {
        itemOrder: { type: 'random', variable: 'ORD' },
      }),
      single('Q9', { showIf: 'ORD == "A1,A2"' }),
    ]);
    expect(analyze(ok).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('flags items that depend on a sibling whose place changes', () => {
    const qq = q([
      block(
        'ROT',
        [single('A1'), single('A2', { showIf: 'A1 == 1' }), static_('T', 'You said {{A1}}')],
        { itemOrder: { type: 'random' } },
      ),
    ]);
    expect(diag(qq, 'order_dependency').map((d) => d.itemId)).toEqual(['A2', 'T']);
    // Inside one moving block, items keep their order: no problem.
    const inner = q([
      block(
        'ROT',
        [
          block('B1', [single('A1'), single('A2', { showIf: 'A1 == 1' })]),
          block('B2', [single('A3')]),
        ],
        { itemOrder: { type: 'random' } },
      ),
    ]);
    expect(diag(inner, 'order_dependency')).toEqual([]);
    // Two fixed items keep their places.
    const fixed = q([
      block('ROT', [single('A1'), single('X'), single('Y'), single('A2', { showIf: 'A1 == 1' })], {
        itemOrder: { type: 'random', fixed: ['A1', 'A2'] },
      }),
    ]);
    expect(diag(fixed, 'order_dependency')).toEqual([]);
  });

  it('flags skips into a moving item, but not out of one', () => {
    const into = q([
      single('Q0', { skips: [{ when: 'Q0 == 1', to: 'A2' }] }),
      block('ROT', [single('A1'), single('A2')], { itemOrder: { type: 'random' } }),
    ]);
    expect(diag(into, 'order_skip')).toHaveLength(1);
    const out = q([
      block('ROT', [single('A1', { skips: [{ when: 'A1 == 1', to: 'Q9' }] }), single('A2')], {
        itemOrder: { type: 'random' },
      }),
      single('Q9'),
    ]);
    expect(diag(out, 'order_skip')).toEqual([]);
    const toBlock = q([
      single('Q0', { skips: [{ when: 'Q0 == 1', to: 'ROT' }] }),
      single('Q1'),
      block('ROT', [single('A1'), single('A2')], { itemOrder: { type: 'random' } }),
    ]);
    expect(diag(toBlock, 'order_skip')).toEqual([]);
  });

  it('a leading fixed item comes first in every order: it may be read and skipped to', () => {
    const qq = q([
      single('Q0', { skips: [{ when: 'Q0 == 1', to: 'FILTER' }] }),
      single('Q1'),
      block('ROT', [single('FILTER'), single('A', { showIf: 'FILTER == 1' }), single('B')], {
        itemOrder: { type: 'rotate', fixed: ['FILTER'] },
      }),
    ]);
    expect(diag(qq, 'order_dependency')).toEqual([]);
    expect(diag(qq, 'order_skip')).toEqual([]);
    // A fixed item after moving ones does not come first.
    const late = q([
      block('ROT', [single('A'), single('B'), single('LAST', { showIf: 'A == 1' })], {
        itemOrder: { type: 'rotate', fixed: ['LAST'] },
      }),
    ]);
    expect(diag(late, 'order_dependency')).toHaveLength(1);
  });

  it('flags unknown fixed items and orders with nothing to move', () => {
    const qq = q([
      block('ROT', [single('A1'), single('A2')], {
        itemOrder: { type: 'random', fixed: ['A1', 'NOPE'] },
      }),
    ]);
    expect(diag(qq, 'unknown_order_item')).toHaveLength(1);
    expect(diag(qq, 'order_nothing_to_move')).toHaveLength(1);
  });

  it('sections can rotate their items too', () => {
    const qq = Questionnaire.parse({
      ...q([single('A1'), single('A2'), single('A3')]),
      sections: [
        {
          id: 'S1',
          title: en('S1'),
          itemOrder: { type: 'rotate', variable: 'S1_ORDER' },
          items: [single('A1'), single('A2'), single('A3')],
        },
      ],
    });
    const s = createInterview(compile(qq), { mode: 'CAPI', seed: 'abc' });
    expect(s.pathKeys().join(',')).toBe(s.getAnswer('S1_ORDER'));
  });
});

describe('personal data before the information notice (item 138c)', () => {
  const notice = { ...static_('NOTICE', 'We are…'), role: 'consent' } as ContainerItem;

  it('flags personal questions and personal insertions placed before the notice', () => {
    const qq = q([
      static_('HELLO', 'Hi {{case.first_name}}, in {{case.city | default:"your city"}}'),
      yesno('EMAIL_OK', { personal: true }),
      notice,
      yesno('PHONE_OK', { personal: true }),
      static_('LATER', 'Thanks {{case.first_name}}'),
    ]);
    const pipes = diag(qq, 'personal_pipe_before_notice');
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toMatchObject({
      itemId: 'HELLO',
      field: 'text',
      msg: { params: { fields: 'case.first_name, case.city' } },
    });
    const questions = diag(qq, 'personal_before_notice');
    expect(questions.map((d) => d.itemId)).toEqual(['EMAIL_OK']);
    expect(analyze(qq).canPublish).toBe(true);
  });

  it('a notice that greets by name shows personal data before it is read', () => {
    const qq = q([
      { ...static_('NOTICE', 'Hi {{respondent.firstName}}, we are…'), role: 'consent' },
      yesno('A', { personal: true }),
    ] as ContainerItem[]);
    expect(diag(qq, 'personal_pipe_before_notice').map((d) => d.itemId)).toEqual(['NOTICE']);
    expect(diag(qq, 'personal_before_notice')).toHaveLength(0);
  });

  it('wording for the interviewer or for other modes is not shown to whoever opens the link', () => {
    const qq = q([
      yesno('INTRO', {
        variants: {
          CATI: {
            text: en('Am I speaking with {{case.first_name}}?'),
            interviewerInstruction: en('Ask for {{case.first_name}}'),
          },
        },
      }),
      { ...static_('NOTICE', 'We are…'), role: 'consent' } as ContainerItem,
    ]);
    expect(diag(qq, 'personal_pipe_before_notice')).toHaveLength(0);
  });

  it('says nothing without a notice', () => {
    const qq = q([static_('HELLO', 'Hi {{case.first_name}}'), yesno('A', { personal: true })]);
    expect(diag(qq, 'personal_before_notice')).toHaveLength(0);
    expect(diag(qq, 'personal_pipe_before_notice')).toHaveLength(0);
  });
});

describe('quota target and maximum (item 100)', () => {
  const quota = (max: number, target?: number | null) =>
    q([single('A')], {
      quotas: [{ id: 'q1', name: 'Women', when: 'A == 1', max, target }],
    } as never);

  it('a target above the maximum is an error', () => {
    const found = diag(quota(100, 120), 'quota_target_over_max');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'error',
      field: 'quotas.q1.target',
      msg: { params: { name: 'Women', target: 120, max: 100 } },
    });
    expect(diag(quota(100, 100), 'quota_target_over_max')).toHaveLength(0);
    expect(diag(quota(100, null), 'quota_target_over_max')).toHaveLength(0);
  });
});
