import { describe, expect, it } from 'vitest';
import { mergeDrafts } from '../src/designer/merge.js';
import {
  flatten,
  insert,
  locate,
  move,
  moveTo,
  remove,
  updateNode,
  type Draft,
} from '../src/designer/tree.js';

const q = (id: string, text = id) => ({
  kind: 'question' as const,
  id,
  name: id,
  type: 'text' as const,
  text: { en: text },
});
const base = (): Draft =>
  ({
    id: 'T',
    title: { en: 'T' },
    defaultLanguage: 'en',
    languages: ['en'],
    modes: ['CATI', 'CAPI', 'CAWI', 'PAPI'],
    settings: {
      specialCodes: {
        DK: { code: -8, label: { en: 'DK' }, offeredIn: [] },
        RF: { code: -9, label: { en: 'RF' }, offeredIn: [] },
        NA: { code: -7, label: { en: 'NA' }, offeredIn: [] },
      },
      cawiShowSpecialCodes: false,
    },
    answerSets: {},
    scripts: [],
    quotas: [],
    sections: [
      {
        id: 'S1',
        title: { en: 'One' },
        items: [q('A'), q('B'), { kind: 'block', id: 'BL', items: [q('C')] }, q('D')],
      },
      { id: 'S2', title: { en: 'Two' }, items: [q('E')] },
    ],
  }) as Draft;
const ids = (d: Draft | null) => flatten(d!).map((x) => x.node.id);
const text = (d: Draft, id: string) =>
  (locate(d, id)!.node as unknown as { text: { en: string } }).text.en;
const setText = (d: Draft, id: string, en: string) =>
  updateNode(d, id, (n) => ({ ...n, text: { en } }) as typeof n);

describe('mergeDrafts', () => {
  it('combines edits to different items', () => {
    const b = base();
    const mine = setText(b, 'A', 'mine');
    const theirs = setText(b, 'D', 'theirs');
    const r = mergeDrafts(b, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(text(r.draft!, 'A')).toBe('mine');
    expect(text(r.draft!, 'D')).toBe('theirs');
    expect(ids(r.draft)).toEqual(ids(b));
  });

  it('combines additions, deletions and moves on both sides', () => {
    const b = base();
    let mine = insert(b, 'A', { kind: 'question', type: 'numeric' }).draft; // Q1 after A
    mine = moveTo(mine, 'E', 'S1', 0); // E to the top of S1
    let theirs = remove(b, 'B');
    theirs = move(theirs, 'D', -1); // D before BL
    theirs = { ...theirs, title: { en: 'Renamed' } };
    const r = mergeDrafts(b, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(ids(r.draft)).toEqual(['S1', 'E', 'A', 'Q1', 'D', 'BL', 'C', 'S2']);
    expect(r.draft!.title.en).toBe('Renamed');
  });

  it('gives a fresh id to an item both added under the same id', () => {
    const b = base();
    const mine = setText(insert(b, 'A', { kind: 'question', type: 'text' }).draft, 'Q1', 'mine');
    const theirs = setText(
      insert(b, 'D', { kind: 'question', type: 'text' }).draft,
      'Q1',
      'theirs',
    );
    const r = mergeDrafts(b, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(ids(r.draft)).toEqual(['S1', 'A', 'Q2', 'B', 'BL', 'C', 'D', 'Q1', 'S2', 'E']);
    expect(text(r.draft!, 'Q1')).toBe('theirs');
    expect(text(r.draft!, 'Q2')).toBe('mine');
  });

  it('reports the same item changed differently, or edited where the other side deleted it', () => {
    const b = base();
    expect(mergeDrafts(b, setText(b, 'A', 'x'), setText(b, 'A', 'y'))).toEqual({
      draft: null,
      conflicts: ['A'],
    });
    // The same change on both sides is no conflict.
    expect(mergeDrafts(b, setText(b, 'A', 'x'), setText(b, 'A', 'x')).conflicts).toEqual([]);
    expect(mergeDrafts(b, setText(b, 'C', 'x'), remove(b, 'C')).conflicts).toEqual(['C']);
    // Editing elsewhere while theirs deletes a block is fine; moving into that block is not.
    expect(mergeDrafts(b, setText(b, 'B', 'x'), remove(b, 'BL')).conflicts).toEqual([]);
    expect(mergeDrafts(b, moveTo(b, 'A', 'BL', 0), remove(b, 'BL')).conflicts).toEqual(['A']);
    expect(
      mergeDrafts(b, { ...b, languages: ['en', 'es'] }, { ...b, languages: ['en', 'fr'] })
        .conflicts,
    ).toEqual(['questionnaire.languages']);
  });
});
