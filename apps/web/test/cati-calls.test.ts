import { CALL_OUTCOMES } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import {
  allDay,
  fromNow,
  groupOutcomes,
  keyIndex,
  longWhen,
  outcomeKey,
  phoneKind,
} from '../src/cati/calls-logic.js';

describe('the calls workspace', () => {
  it('gives every one of the ten outcomes a key: 1–9, then 0', () => {
    const keys = CALL_OUTCOMES.map((_, i) => outcomeKey(i));
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(CALL_OUTCOMES[keyIndex('0')]).toBe('do_not_contact');
    expect(CALL_OUTCOMES[keyIndex('1')]).toBe('answered');
    expect(keyIndex('a')).toBe(-1);
    expect(outcomeKey(10)).toBeNull();
  });

  it('groups the outcomes, every one once, with only those offered', () => {
    const all = groupOutcomes(CALL_OUTCOMES);
    expect(all.map((g) => g.id)).toEqual(['reached', 'notReached', 'final', 'reschedule']);
    expect(all.flatMap((g) => g.outcomes).sort()).toEqual([...CALL_OUTCOMES].sort());
    const interrupted = groupOutcomes(['callback', 'appointment', 'refusal', 'do_not_contact']);
    expect(interrupted.map((g) => g.id)).toEqual(['final', 'reschedule']);
  });

  it('reads the same start and end hour as no restriction', () => {
    expect(allDay({ from: '00:00', to: '00:00' })).toBe(true);
    expect(allDay({ from: '09:00', to: '21:00' })).toBe(false);
  });

  it('translates common phone labels and keeps the others', () => {
    expect(phoneKind('phone')).toBe('phone');
    expect(phoneKind('Móvil')).toBe('mobile');
    expect(phoneKind('Casa de la abuela')).toBeNull();
    expect(phoneKind(null)).toBeNull();
  });

  it('says a callback time in full, in the respondent’s zone and the interface language', () => {
    const at = new Date('2026-11-27T01:24:00Z');
    const es = longWhen(at, 'America/Lima', 'es');
    expect(es).toContain('jueves');
    expect(es).toContain('26');
    expect(es).toContain('noviembre');
    expect(es).toContain('20:24');
    expect(fromNow(at, at.getTime() - 3_600_000, 'es')).toBe('dentro de 1 hora');
    expect(fromNow(at, at.getTime() - 3_600_000, 'en')).toBe('in 1 hour');
  });
});
