import { describe, expect, it } from 'vitest';
import type { AnswerValue, ContainerItem } from '@wansurvey/schema';
import { compile } from '../src/compile.js';
import {
  createInterview,
  verifySubmission,
  type InterviewOptions,
  type InterviewSession,
} from '../src/engine.js';
import { household } from '@wansurvey/fixtures';
import { num, q, single } from './builders.js';

const compiled = compile(household);
const NOW = () => new Date('2026-10-12T10:00:00Z');
const ctx = {
  case: { city: 'Quito', region: 2 },
  interviewer: { firstName: 'Juan' },
  respondent: { firstName: 'Rosa' },
};

function start(opts: Partial<InterviewOptions> = {}) {
  return createInterview(compiled, {
    mode: 'CAPI',
    context: ctx,
    now: NOW,
    seed: 'int-1',
    ...opts,
  });
}

/** Answers the current question from `answers` and presses Next until done or stuck. */
function drive(s: InterviewSession, answers: Record<string, AnswerValue>, limit = 500) {
  for (let i = 0; i < limit; i++) {
    const key = s.currentKey();
    if (key === null) return;
    if (key in answers) {
      const r = s.setAnswer(key, answers[key]!);
      if (!r.ok) throw new Error(`${key}: ${r.error}`);
    }
    const nav = s.next();
    if (!nav.ok && !(key in answers) && nav.validation?.errors.some((e) => e.ruleId === 'required'))
      return;
    if (!nav.ok) {
      const w = nav.validation?.warnings.filter((x) => !x.confirmed) ?? [];
      if (nav.validation && nav.validation.errors.length === 0 && w.length) {
        w.forEach((x) => s.confirmWarning(key, x.ruleId));
        continue;
      }
      throw new Error(`Stuck at ${key}: ${JSON.stringify(nav.validation)}`);
    }
  }
  throw new Error('Did not finish');
}

const base: Record<string, AnswerValue> = {
  A1_CONSENT: 1,
  A2_AGE: 40,
  A3_SEX: 2,
  A4_MARITAL: 1,
  A4_SPOUSE: 'Pat',
  A5_NAME: 'Rosa',
  B1_HHSIZE: 3,
  B2_CHILDREN: 1,
  B2_SCHOOLKIDS: 1,
  'HH[1].M_NAME': 'Rosa',
  'HH[1].M_AGE': 40,
  'HH[1].M_SEX': 2,
  'HH[1].M_WORK': 1,
  'HH[1].M_INCOME': 1000,
  'HH[2].M_NAME': 'Pat',
  'HH[2].M_AGE': 42,
  'HH[2].M_SEX': 1,
  'HH[2].M_WORK': 2,
  'HH[3].M_NAME': 'Kid',
  'HH[3].M_AGE': 3,
  C1_TENURE: 2,
  C2_RENT: 300,
  C3_ROOMS: 4,
  C4_WATER: 1,
  C6_ELEC: 1,
  C7_APPL: [1, 2],
  C8_FRIDGE_AGE: 5,
  D1_INSURED: 1,
  D2_INSURER: 2,
  D3_VISITS: 2,
  D4_LASTVISIT: '2026-09-01',
  D5_NPS: 9,
  D6_GRID: { a: 4, b: 5, c: 3 },
  E1_RECONTACT: 1,
  E2_PHONE: '5551234567',
  E3_WHEN: 1,
  E4_TIME: '18:30',
};

describe('interview engine — full path', () => {
  it('completes the household survey', () => {
    const s = start();
    expect(s.currentKey()).toBe('A0_CONSENT_TEXT');
    drive(s, base);
    expect(s.status()).toMatchObject({ state: 'completed', disposition: 'COMPLETE', progress: 1 });
    const a = s.getAnswers();
    expect(a.TOTAL_INCOME).toBe(1000);
    expect(a.N_FEMALES).toBe(1);
    expect(a.E5_REGION).toBe(2); // prefilled from case.region
    expect(a.HH).toHaveLength(3);
    // child under 5: END_ROW skipped the rest of row 3
    expect(s.trace().find((e) => e.key === 'HH[3].M_SEX')?.status).toBe('skipped');
    // skips on the path
    expect(s.pathKeys()).not.toContain('C5_DIST');
    expect(s.pathKeys()).toContain('HH[1].M_INCOME');
    expect(s.pathKeys()).not.toContain('HH[2].M_INCOME');
    expect(s.pathKeys()).not.toContain('HH[1].M_SCHOOL'); // age 40 > 25
  });

  it('records system events for prefill and computed variables', () => {
    const s = start();
    drive(s, base);
    const events = s.drainEvents();
    expect(events).toContainEqual(
      expect.objectContaining({ key: 'E5_REGION', source: 'system', reason: 'prefill' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ key: 'TOTAL_INCOME', reason: 'computed' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ key: 'A1_CONSENT', source: 'interviewer', newValue: 1 }),
    );
  });

  it('skip to END completes the interview and skips the rest', () => {
    const s = start();
    drive(s, { ...base, E1_RECONTACT: 2 });
    expect(s.status().state).toBe('completed');
    expect(s.trace().find((e) => e.key === 'E2_PHONE')?.status).toBe('skipped');
  });

  it('end-as rules terminate with a disposition', () => {
    const s = start();
    drive(s, { A1_CONSENT: 1, A2_AGE: 16 });
    expect(s.status()).toMatchObject({ state: 'ended', disposition: 'SCREENED_OUT' });
    expect(s.trace().find((e) => e.key === 'A3_SEX')?.status).toBe('ended');
  });

  it('quota cells close when full', () => {
    const s = start({ quotas: { isFull: (id) => id === 'Q_FEMALE' } });
    drive(s, { A1_CONSENT: 1, A2_AGE: 30, A3_SEX: 2 });
    expect(s.status()).toMatchObject({ state: 'ended', disposition: 'QUOTA_FULL' });
    expect(s.endState()).toMatchObject({ reason: 'quota', quotaId: 'Q_FEMALE' });
    const m = start({ quotas: { isFull: (id) => id === 'Q_FEMALE' } });
    m.setAnswer('A1_CONSENT', 1);
    m.setAnswer('A2_AGE', 30);
    m.setAnswer('A3_SEX', 1);
    expect(m.endState()).toBeNull();
  });
});

describe('path changes', () => {
  it('clears items that fall off the path, reports them, and restores them if the path returns', () => {
    const s = start();
    drive(s, base);
    const r1 = s.setAnswer('A4_MARITAL', 2);
    expect(r1.cleared).toEqual([{ key: 'A4_SPOUSE', value: 'Pat' }]);
    expect(s.getAnswer('A4_SPOUSE')).toBeNull();
    expect(s.drainEvents()).toContainEqual(
      expect.objectContaining({
        key: 'A4_SPOUSE',
        oldValue: 'Pat',
        newValue: null,
        source: 'system',
        reason: 'path_change',
      }),
    );
    const r2 = s.setAnswer('A4_MARITAL', 1);
    expect(r2.restored).toEqual([{ key: 'A4_SPOUSE', value: 'Pat' }]);
    expect(s.getAnswer('A4_SPOUSE')).toBe('Pat');
  });

  it('later conditions never see cleared answers', () => {
    const s = start();
    drive(s, base);
    expect(s.pathKeys()).toContain('C8_FRIDGE_AGE');
    // No electricity → skip to SEC_D clears appliances, and with them the fridge question.
    const r = s.setAnswer('C6_ELEC', 2);
    expect(r.cleared.map((c) => c.key).sort()).toEqual(['C7_APPL', 'C8_FRIDGE_AGE']);
  });

  it('shrinking a roster stashes the removed rows; growing it brings them back', () => {
    const s = start();
    drive(s, base);
    const r = s.setAnswer('B1_HHSIZE', 2);
    expect(r.cleared.map((c) => c.key)).toEqual(['HH[3]']);
    expect(s.getAnswers().HH).toHaveLength(2);
    const r2 = s.setAnswer('B1_HHSIZE', 3);
    expect(r2.restored.map((c) => c.key)).toEqual(['HH[3]']);
    expect(s.getAnswer('HH[3].M_NAME')).toBe('Kid');
  });

  it('roster-scoped conditions re-evaluate per row', () => {
    const s = start();
    drive(s, base);
    s.setAnswer('HH[2].M_WORK', 1);
    expect(s.pathKeys()).toContain('HH[2].M_INCOME');
    s.setAnswer('HH[2].M_INCOME', 500);
    expect(s.getAnswer('TOTAL_INCOME')).toBe(1500);
    s.setAnswer('HH[1].M_WORK', 2);
    expect(s.getAnswer('TOTAL_INCOME')).toBe(500);
  });

  it('moves the position back onto the path when the current item disappears', () => {
    const s = start();
    drive(s, { A1_CONSENT: 1, A2_AGE: 40, A3_SEX: 2, A4_MARITAL: 1 });
    expect(s.currentKey()).toBe('A4_SPOUSE');
    s.setAnswer('A4_MARITAL', 2);
    expect(s.currentKey()).toBe('A5_NAME');
  });
});

describe('validation', () => {
  function at(key: string, answers: Record<string, AnswerValue> = base) {
    const s = start();
    const prior = Object.fromEntries(Object.entries(answers).filter(([k]) => k !== key));
    for (let i = 0; i < 300 && s.currentKey() !== key; i++) {
      const k = s.currentKey()!;
      if (k in prior) s.setAnswer(k, prior[k]!);
      if (!s.next().ok) {
        s.validate(k).warnings.forEach((w) => s.confirmWarning(k, w.ruleId));
        s.next();
      }
    }
    expect(s.currentKey()).toBe(key);
    return s;
  }

  it('requires an answer', () => {
    const s = at('A2_AGE');
    const nav = s.next();
    expect(nav.ok).toBe(false);
    expect(nav.validation?.errors[0]?.ruleId).toBe('required');
  });

  it('hard checks block, with piped messages', () => {
    const s = at('B2_CHILDREN');
    s.setAnswer('B2_CHILDREN', 3);
    const nav = s.next();
    expect(nav.ok).toBe(false);
    expect(nav.validation?.errors).toContainEqual(
      expect.objectContaining({
        ruleId: 'kids',
        message: 'Children cannot exceed household size (3)',
      }),
    );
  });

  it('soft checks need confirmation, which is remembered until the answer changes', () => {
    const s = at('A2_AGE');
    s.setAnswer('A2_AGE', 99);
    expect(s.next().ok).toBe(false);
    expect(s.validate('A2_AGE').warnings).toEqual([
      expect.objectContaining({ ruleId: 'old', confirmed: false }),
    ]);
    s.confirmWarning('A2_AGE', 'old');
    expect(s.validate('A2_AGE').canProceed).toBe(true);
    s.setAnswer('A2_AGE', 98);
    expect(s.validate('A2_AGE').canProceed).toBe(false);
  });

  it('built-in checks: range, integer, codes, exclusivity, pattern, dates, grid, other-specify', () => {
    const s = start();
    drive(s, base);
    const errs = (key: string, v: AnswerValue) => {
      s.setAnswer(key, v);
      return s.validate(key).errors.map((e) => e.ruleId);
    };
    expect(errs('A2_AGE', 130)).toContain('max');
    expect(errs('A2_AGE', 40.5)).toContain('integer');
    expect(errs('C5_DIST', 1)).toEqual([]); // not on path → nothing to validate
    expect(errs('A3_SEX', 9)).toContain('invalid_code');
    expect(errs('C7_APPL', [1, 99])).toContain('exclusive');
    expect(errs('E2_PHONE', '12ab')).toContain('pattern');
    expect(errs('E2_PHONE', '5551234')).toEqual([]);
    expect(errs('D4_LASTVISIT', '2027-01-01')).toContain('max_date');
    expect(errs('D4_LASTVISIT', '2026-13-01')).toContain('date');
    expect(errs('D6_GRID', { a: 1 })).toContain('grid_rows');
    expect(errs('E4_TIME', '25:00')).toContain('time');
    expect(errs('D5_NPS', 11)).toContain('max');
    expect(errs('C1_TENURE', 3)).toContain('other_specify');
    s.setAnswer('C1_TENURE_OTHER', 'Family house');
    expect(s.validate('C1_TENURE').errors).toEqual([]);
    s.setAnswer('C1_TENURE', 1);
    expect(s.getAnswer('C1_TENURE_OTHER')).toBeNull();
  });

  it('rejects malformed values and answers to items not on the path', () => {
    const s = start();
    expect(s.setAnswer('A2_AGE', 'forty').ok).toBe(false);
    expect(s.setAnswer('A2_AGE', 'forty').error).toBe('Enter a number');
    expect(s.setAnswer('C5_DIST', 3).ok).toBe(false);
    expect(s.setAnswer('NOPE', 3).ok).toBe(false);
    expect(s.setAnswer('HH[9].M_AGE', 3).ok).toBe(false);
  });

  it('special codes depend on mode and question settings', () => {
    const cati = start({ mode: 'CATI' });
    expect(cati.optionsFor('A2_AGE').special).toEqual(['DK', 'RF']);
    expect(cati.optionsFor('A1_CONSENT').special).toEqual(['RF']);
    const cawi = start({ mode: 'CAWI' });
    expect(cawi.optionsFor('A2_AGE').special).toEqual([]);
    cawi.setSpecial('A2_AGE', 'DK');
    expect(cawi.validate('A2_AGE').errors.map((e) => e.ruleId)).toEqual(['special']);
    cati.setSpecial('A2_AGE', 'DK');
    expect(cati.validate('A2_AGE').errors).toEqual([]);
    expect(cati.getAnswer('A2_AGE')).toEqual({ $special: 'DK' });
  });
});

describe('presentation', () => {
  it('uses mode variants and pipes', () => {
    const cati = start({ mode: 'CATI' });
    const cawi = start({ mode: 'CAWI' });
    expect(cati.text('A2_AGE')).toBe('Could you tell me your age, please?');
    expect(cawi.text('A2_AGE')).toBe('How old are you?');
    expect(start().text('A0_CONSENT_TEXT')).toBe(
      'Hello Rosa, we are conducting a survey in Quito.',
    );
    expect(start().text('A3_SEX', 'interviewerInstruction')).toBe(
      'RECORD WITHOUT ASKING IF OBVIOUS',
    );
    expect(cati.text('A3_SEX', 'interviewerInstruction')).toBeNull();
  });

  it('switches language mid-interview', () => {
    const s = start();
    drive(s, { A1_CONSENT: 1, A2_AGE: 40, A3_SEX: 1, A4_MARITAL: 1 });
    expect(s.text('A4_SPOUSE')).toBe('What is the name of your wife?');
    s.setLanguage('es');
    expect(s.text('A4_SPOUSE')).toBe('¿Cómo se llama su esposa?');
  });

  it('pipes roster values per row', () => {
    const s = start();
    drive(s, base);
    expect(s.text('HH[2].M_AGE')).toBe('How old is Pat?');
    expect(s.text('HH[3].M_NAME')).toBe('Name of person 3');
  });

  it('randomises options deterministically per interview and keeps fixed options in place', () => {
    const s1 = start({ seed: 'a' });
    const s2 = start({ seed: 'a' });
    drive(s1, base);
    drive(s2, base);
    const o1 = s1.optionsFor('C7_APPL').options.map((o) => o.code);
    expect(o1).toEqual(s2.optionsFor('C7_APPL').options.map((o) => o.code));
    expect(o1[3]).toBe(99);
    expect([...o1].sort()).toEqual([1, 2, 3, 99].sort());
  });

  it('filters options with optionFilter', () => {
    const c = compile(q([single('A'), single('B', { optionFilter: 'code != A' })]));
    const s = createInterview(c, { mode: 'CAPI' });
    s.setAnswer('A', 1);
    expect(s.optionsFor('B').options.map((o) => o.code)).toEqual([2]);
  });
});

describe('navigation', () => {
  it('jumps back freely, forward only to visited items', () => {
    const s = start();
    drive(s, { A1_CONSENT: 1, A2_AGE: 40, A3_SEX: 1, A4_MARITAL: 1 });
    expect(s.canJumpTo('A1_CONSENT')).toBe(true);
    expect(s.canJumpTo('B1_HHSIZE')).toBe(false);
    s.jumpTo('A1_CONSENT');
    expect(s.currentKey()).toBe('A1_CONSENT');
    expect(s.canJumpTo('A3_SEX')).toBe(true); // visited
    expect(s.prev()).toMatchObject({ ok: true, key: 'A0_CONSENT_TEXT' });
    expect(s.prev().ok).toBe(false);
  });

  it('snapshots restore the exact position and state', () => {
    const s = start();
    drive(s, { A1_CONSENT: 1, A2_AGE: 99, A3_SEX: 1 });
    const snap = JSON.parse(JSON.stringify(s.state()));
    const r = start({ state: snap });
    expect(r.currentKey()).toBe(s.currentKey());
    expect(r.pathKeys()).toEqual(s.pathKeys());
    expect(r.getAnswers()).toEqual(s.getAnswers());
    expect(r.validate('A2_AGE').canProceed).toBe(true); // confirmation survived
  });
});

describe('rosters', () => {
  it('open rosters add and remove rows', () => {
    const roster: ContainerItem = {
      kind: 'roster',
      id: 'R',
      name: 'R',
      count: { type: 'open', max: 2 },
      items: [num('X')],
    };
    const c = compile(q([roster, num('AFTER', { showIf: 'rosterCount(R) > 1' })]));
    const s = createInterview(c, { mode: 'CAPI' });
    expect(s.pathKeys()).toEqual([]);
    expect(s.addRosterRow('R')).toBe(1);
    expect(s.addRosterRow('R')).toBe(2);
    expect(() => s.addRosterRow('R')).toThrow(/full/);
    s.setAnswer('R[1].X', 10);
    s.setAnswer('R[2].X', 20);
    expect(s.pathKeys()).toEqual(['R[1].X', 'R[2].X', 'AFTER']);
    s.removeRosterRow('R', 1);
    expect(s.getAnswers().R).toEqual([{ X: 20 }]);
    expect(s.pathKeys()).toEqual(['R[1].X']);
  });

  it('nested rosters address rows of rows', () => {
    const inner: ContainerItem = {
      kind: 'roster',
      id: 'V',
      name: 'V',
      count: { type: 'expression', expr: 'NV' },
      items: [num('D')],
    };
    const outer: ContainerItem = {
      kind: 'roster',
      id: 'P',
      name: 'P',
      count: { type: 'fixed', n: 2 },
      items: [num('NV'), inner],
    };
    const c = compile(q([outer, num('TOTAL', { showIf: 'sum(P.NV) > 2' })]));
    const s = createInterview(c, { mode: 'CAPI' });
    s.setAnswer('P[1].NV', 2);
    s.setAnswer('P[2].NV', 1);
    expect(s.pathKeys()).toEqual([
      'P[1].NV',
      'P[1].V[1].D',
      'P[1].V[2].D',
      'P[2].NV',
      'P[2].V[1].D',
      'TOTAL',
    ]);
    s.setAnswer('P[1].V[2].D', 7);
    expect(s.getAnswers()).toEqual({
      P: [
        { NV: 2, V: [{}, { D: 7 }] },
        { NV: 1, V: [{}] },
      ],
    });
  });
});

describe('modes', () => {
  it('visibleInMode hides an item in one mode only', () => {
    const c = compile(
      q([single('A', { variants: { CAPI: { visibleInMode: false } } }), single('B')]),
    );
    expect(createInterview(c, { mode: 'CAPI' }).pathKeys()).toEqual(['B']);
    expect(createInterview(c, { mode: 'CATI' }).pathKeys()).toEqual(['A', 'B']);
    expect(createInterview(c, { mode: 'CAPI' }).trace()[1]).toMatchObject({ status: 'notInMode' });
  });

  it('logic can branch on mode', () => {
    const c = compile(q([single('A', { showIf: 'mode == "CATI"' }), single('B')]));
    expect(createInterview(c, { mode: 'CAWI' }).pathKeys()).toEqual(['B']);
  });
});

describe('server re-run', () => {
  it('accepts a matching submission and flags a tampered one', () => {
    const s = start();
    drive(s, base);
    const opts = { mode: 'CAPI' as const, context: ctx, now: NOW, seed: 'int-1' };
    expect(verifySubmission(compiled, opts, s.getAnswers(), s.pathKeys())).toMatchObject({
      match: true,
    });
    const tampered = verifySubmission(
      compiled,
      opts,
      { ...s.getAnswers(), C5_DIST: 3 },
      s.pathKeys(),
    );
    expect(tampered.match).toBe(false);
    expect(tampered.offPathAnswers).toContain('C5_DIST');
    const wrongPath = verifySubmission(compiled, opts, s.getAnswers(), [
      ...s.pathKeys(),
      'C5_DIST',
    ]);
    expect(wrongPath.unexpected).toEqual(['C5_DIST']);
  });
});

describe('built-in validation messages', () => {
  it('carry a rule id and parameters so clients can translate them', () => {
    const s = start();
    s.setAnswer('A1_CONSENT', 1);
    s.setAnswer('A2_AGE', 130);
    expect(s.validate('A2_AGE').errors).toEqual([
      {
        ruleId: 'max',
        severity: 'error',
        message: 'The maximum is 120',
        builtIn: true,
        params: { n: '120' },
      },
    ]);
    s.setAnswer('A2_AGE', 99);
    expect(s.validate('A2_AGE').warnings[0]).toMatchObject({ ruleId: 'old', builtIn: false });
  });
});
