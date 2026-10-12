import { household } from '@wansurvey/fixtures';
import { Questionnaire, type ContainerItem } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/index.js';

const hh = () => Questionnaire.parse(household);
type Q = ContainerItem & { kind: 'question' };
const find = (q: Questionnaire, id: string): Q => {
  const walk = (l: ContainerItem[]): Q | undefined => {
    for (const n of l) {
      if (n.id === id) return n as Q;
      const hit = 'items' in n ? walk(n.items) : undefined;
      if (hit) return hit;
    }
  };
  return walk(q.sections.flatMap((s) => s.items))!;
};

describe('compareVersions', () => {
  it('finds nothing between equal versions', () => {
    expect(compareVersions(hh(), hh())).toEqual({
      items: [],
      questionnaire: [],
      counts: { added: 0, removed: 0, changed: 0, moved: 0 },
    });
  });

  it('reports texts per language, options by code and logic as expressions', () => {
    const a = hh();
    const b = hh();
    find(b, 'C5').showIf = 'C4_WATER == 2';
    find(b, 'C4').options![1]!.label.es = 'Pozo propio';
    find(b, 'C4').options!.push({ code: 4, label: { en: 'Other', es: 'Otro' } });
    find(b, 'A2').text.en = 'How old are you now?';
    b.title.es = 'Nuevo título';
    const r = compareVersions(a, b);
    expect(r.counts).toEqual({ added: 0, removed: 0, changed: 3, moved: 0 });
    expect(r.items.find((i) => i.id === 'C5')!.changes).toEqual([
      { kind: 'logic', field: 'showIf', before: 'C4_WATER in (2, 3)', after: 'C4_WATER == 2' },
    ]);
    const c4 = r.items.find((i) => i.id === 'C4')!.changes;
    expect(c4).toContainEqual({
      kind: 'text',
      field: 'options[2].label',
      lang: 'es',
      before: find(a, 'C4').options![1]!.label.es,
      after: 'Pozo propio',
    });
    expect(c4.filter((c) => c.field.startsWith('options[4]'))).toHaveLength(3);
    expect(r.items.find((i) => i.id === 'A2')!.changes).toMatchObject([
      { kind: 'text', field: 'text', lang: 'en', after: 'How old are you now?' },
    ]);
    expect(r.questionnaire).toMatchObject([{ kind: 'text', field: 'title', lang: 'es' }]);
  });

  it('finds added, removed and moved items without flagging the ones in between', () => {
    const a = hh();
    const b = hh();
    const secA = b.sections[0]!.items;
    // A5 moves to the top of section A; A3 goes away; a new question appears in section C.
    secA.unshift(
      secA.splice(
        secA.findIndex((n) => n.id === 'A5'),
        1,
      )[0]!,
    );
    secA.splice(
      secA.findIndex((n) => n.id === 'A3'),
      1,
    );
    b.sections[2]!.items.push({
      kind: 'question',
      id: 'C9',
      name: 'C9',
      type: 'text',
      text: { en: 'New?', es: '¿Nuevo?' },
    });
    // M6 leaves the roster for section B.
    const roster = b.sections[1]!.items.find((n) => n.id === 'HH') as { items: ContainerItem[] };
    b.sections[1]!.items.push(roster.items.pop()!);
    const r = compareVersions(a, b);
    expect(r.counts).toEqual({ added: 1, removed: 1, changed: 0, moved: 2 });
    expect(r.items.map((i) => [i.id, i.status])).toEqual([
      ['A5', 'moved'],
      ['M6', 'moved'],
      ['C9', 'added'],
      ['A3', 'removed'],
    ]);
    expect(r.items.find((i) => i.id === 'M6')).toMatchObject({
      parentBefore: 'HH',
      parentAfter: 'SEC_B',
    });
  });
});
