import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { household } from '@wansurvey/fixtures';
import { Questionnaire } from '@wansurvey/schema';
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ComparePanel } from '../src/designer/ComparePanel.js';
import { ConditionBuilder } from '../src/designer/ConditionBuilder.js';
import { ItemEditor } from '../src/designer/ItemEditor.js';
import { Outline } from '../src/designer/Outline.js';
import { RoutingMap } from '../src/designer/RoutingMap.js';
import { useRouting } from '../src/designer/useRouting.js';
import { SettingsEditor } from '../src/designer/SettingsEditor.js';
import { TranslationsPanel } from '../src/designer/TranslationsPanel.js';
import {
  duplicate,
  flatten,
  indent,
  insert,
  insertFromLibrary,
  libraryContentOf,
  locate,
  move,
  moveTo,
  outdent,
  remove,
  renameVariable,
  type Draft,
} from '../src/designer/tree.js';
import { variablesOf } from '../src/designer/vars.js';

const draft = (): Draft =>
  Questionnaire.parse({
    id: 'T',
    title: { en: 'T' },
    defaultLanguage: 'en',
    languages: ['en'],
    sections: [
      {
        id: 'S1',
        title: { en: 'One' },
        items: [
          {
            kind: 'question',
            id: 'A',
            name: 'A',
            type: 'single',
            text: { en: 'A? {{B}}' },
            options: [
              { code: 1, label: { en: 'Yes' } },
              { code: 2, label: { en: 'No' } },
            ],
            skips: [{ when: 'A == 2', to: 'C' }],
          },
          { kind: 'block', id: 'BL', items: [] },
          {
            kind: 'question',
            id: 'B',
            name: 'B',
            type: 'numeric',
            text: { en: 'B?' },
            showIf: 'A == 1',
          },
          { kind: 'question', id: 'C', name: 'C', type: 'text', text: { en: 'C?' } },
        ],
      },
    ],
  });

const ids = (d: Draft) => flatten(d).map((x) => x.node.id);

async function expectAccessible(container: Element) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

describe('tree edits', () => {
  it('moves, indents and outdents without touching the original', () => {
    const d = draft();
    const before = JSON.stringify(d);
    expect(ids(move(d, 'B', -1))).toEqual(['S1', 'A', 'B', 'BL', 'C']);
    expect(ids(move(d, 'A', -1))).toEqual(ids(d));
    const nested = indent(d, 'B');
    expect(locate(nested, 'B')!.parentId).toBe('BL');
    expect(locate(outdent(nested, 'B'), 'B')!.parentId).toBe('S1');
    expect(JSON.stringify(d)).toBe(before);
  });

  it('moves a node to any valid place, and refuses invalid ones', () => {
    const d = draft();
    // Index counts the target list as it is before the move.
    expect(ids(moveTo(d, 'A', 'S1', 3))).toEqual(['S1', 'BL', 'B', 'A', 'C']);
    expect(ids(moveTo(d, 'C', 'S1', 0))).toEqual(['S1', 'C', 'A', 'BL', 'B']);
    const into = moveTo(d, 'B', 'BL', 0);
    expect(locate(into, 'B')!.parentId).toBe('BL');
    // Out of a block, to the end of the section.
    expect(locate(moveTo(into, 'B', 'S1', 99), 'B')).toMatchObject({ parentId: 'S1', index: 3 });
    // Not into itself, not into a question, sections stay at the top, items never at the top.
    expect(moveTo(d, 'BL', 'BL', 0)).toBe(d);
    expect(moveTo(d, 'B', 'A', 0)).toBe(d);
    expect(moveTo(d, 'S1', 'BL', 0)).toBe(d);
    expect(moveTo(d, 'A', null, 0)).toBe(d);
    const two = insert(d, 'C', { kind: 'section' }).draft;
    expect(moveTo(two, two.sections[1]!.id, null, 0).sections.map((x) => x.id)).toEqual([
      two.sections[1]!.id,
      'S1',
    ]);
  });

  it('inserts with fresh names, duplicates and removes', () => {
    const d = draft();
    const r = insert(d, 'A', { kind: 'question', type: 'single' });
    expect(r.newId).toBe('Q1');
    expect(ids(r.draft).indexOf('Q1')).toBe(ids(r.draft).indexOf('A') + 1);
    const inside = insert(d, 'BL', { kind: 'static' }, { inside: true });
    expect(locate(inside.draft, inside.newId)!.parentId).toBe('BL');
    const dup = duplicate(d, 'B');
    expect(dup.newId).toBe('B_2');
    expect(locate(dup.draft, 'B_2')!.node).toMatchObject({ name: 'B_2', type: 'numeric' });
    expect(ids(remove(d, 'B'))).not.toContain('B');
    // The last section cannot be removed.
    expect(ids(remove(d, 'S1'))).toEqual(ids(d));
    const sec = insert(d, 'B', { kind: 'section' });
    expect(sec.draft.sections.map((s) => s.id)).toEqual(['S1', sec.newId]);
  });

  it('inserts library entries with fresh names and merged answer sets', () => {
    const d = draft();
    const content = libraryContentOf(d, 'A')!;
    const r = insertFromLibrary(d, 'C', content);
    expect(r.newId).toBe('A_2');
    expect(r.renamed).toEqual({ A: 'A_2' });
    const copy = locate(r.draft, 'A_2')!.node as { skips: { when: string; to: string }[] };
    // References inside the entry follow the rename; the skip target outside stays.
    expect(copy.skips).toEqual([{ when: 'A_2 == 2', to: 'C' }]);
    expect(ids(r.draft).slice(-1)).toEqual(['A_2']);
    // Into an empty questionnaire area with no clash, names are kept.
    const fresh = insertFromLibrary(remove(d, 'A'), 'BL', content, { inside: true });
    expect(fresh.newId).toBe('A');
    expect(locate(fresh.draft, 'A')!.parentId).toBe('BL');

    const yes = [{ code: 1, label: { en: 'Yes' } }];
    const withSet = {
      node: {
        kind: 'question' as const,
        id: 'Z',
        name: 'Z',
        type: 'single' as const,
        text: { en: 'Z?' },
        answerSetId: 'yn',
      },
      answerSets: { yn: yes },
    };
    const same = insertFromLibrary({ ...d, answerSets: { yn: yes } }, 'C', withSet);
    expect(Object.keys(same.draft.answerSets)).toEqual(['yn']);
    const other = insertFromLibrary(
      { ...d, answerSets: { yn: [{ code: 9, label: { en: 'Other' } }] } },
      'C',
      withSet,
    );
    expect(Object.keys(other.draft.answerSets)).toEqual(['yn', 'yn_2']);
    expect((locate(other.draft, 'Z')!.node as { answerSetId: string }).answerSetId).toBe('yn_2');
  });

  it('renames a variable everywhere it is used', () => {
    const d = renameVariable(renameVariable(draft(), 'A', 'AGE'), 'C', 'CITY');
    const b = locate(d, 'B')!.node as { showIf: string };
    expect(b.showIf).toBe('AGE == 1');
    const a = locate(d, 'AGE')!.node as { skips: { when: string; to: string }[] };
    expect(a.skips).toEqual([{ when: 'AGE == 2', to: 'CITY' }]);
    const named = renameVariable(d, 'B', 'BB');
    expect((locate(named, 'AGE')!.node as unknown as { text: { en: string } }).text.en).toBe(
      'A? {{BB}}',
    );
  });
});

function Harness({ initial, onChange }: { initial: Draft; onChange?(d: Draft): void }) {
  const [d, setD] = useState(initial);
  const [sel, setSel] = useState('A');
  return (
    <Outline
      draft={d}
      selected={sel}
      onSelect={setSel}
      change={(n) => {
        setD(n);
        onChange?.(n);
      }}
      errorsById={new Map([['B', 2]])}
      lang="en"
      readOnly={false}
      onRename={() => {}}
      onEnter={() => {}}
      announce={() => {}}
    />
  );
}

describe('outline', () => {
  it('is a keyboard tree: move, reorder, indent, add and delete', async () => {
    const user = userEvent.setup();
    const changes: Draft[] = [];
    const { container } = render(<Harness initial={draft()} onChange={(d) => changes.push(d)} />);
    const tree = screen.getByRole('tree', { name: 'Outline' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(6);
    expect(within(tree).getByText('2 errors')).toBeTruthy();
    await expectAccessible(container);

    const a = within(tree).getAllByRole('treeitem')[2]!;
    a.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(ids(changes.at(-1)!)).toEqual(['S1', 'BL', 'A', 'B', 'C']);
    expect(document.activeElement?.getAttribute('data-id')).toBe('A');

    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(locate(changes.at(-1)!, 'A')!.parentId).toBe('BL');

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-id')).toBe('B');
    await user.keyboard('{Delete}');
    expect(ids(changes.at(-1)!)).not.toContain('B');

    await user.keyboard('{Insert}');
    const picker = screen.getByRole('group', { name: 'Choose what to add' });
    expect(document.activeElement?.textContent).toBe('Single choice');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(picker.isConnected).toBe(false);
    const added = flatten(changes.at(-1)!).find((x) => 'type' in x.node && x.node.type === 'multi');
    expect(added).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-id')).toBe(added!.node.id);
  });
});

describe('outline drag and drop', () => {
  it('drops a row before another, and into a block', () => {
    const changes: Draft[] = [];
    const messages: string[] = [];
    function H() {
      const [d, setD] = useState(draft());
      return (
        <Outline
          draft={d}
          selected="A"
          onSelect={() => {}}
          change={(n) => {
            setD(n);
            changes.push(n);
          }}
          errorsById={new Map()}
          lang="en"
          readOnly={false}
          onRename={() => {}}
          onEnter={() => {}}
          announce={(m) => messages.push(m)}
        />
      );
    }
    render(<H />);
    // Every row is 20px high, starting at y = 0.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, height: 20, bottom: 20, left: 0, right: 100, width: 100 }) as DOMRect,
    );
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    const dataTransfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
    // jsdom has no DragEvent, so the pointer position is set on the event by hand.
    const at = (kind: 'dragOver' | 'drop', el: HTMLElement, clientY: number) => {
      const ev = createEvent[kind](el, { dataTransfer });
      Object.defineProperty(ev, 'clientY', { value: clientY });
      fireEvent(el, ev);
    };

    fireEvent.dragStart(row('C'), { dataTransfer });
    at('dragOver', row('A'), 2);
    expect(row('A').dataset.drop).toBe('before');
    at('drop', row('A'), 2);
    expect(ids(changes.at(-1)!)).toEqual(['S1', 'C', 'A', 'BL', 'B']);
    expect(messages.at(-1)).toBe('Moved C');

    fireEvent.dragStart(row('A'), { dataTransfer });
    at('dragOver', row('BL'), 10);
    expect(row('BL').dataset.drop).toBe('inside');
    at('drop', row('BL'), 10);
    expect(locate(changes.at(-1)!, 'A')!.parentId).toBe('BL');

    // A block cannot be dropped into itself; a section cannot go inside an item.
    fireEvent.dragStart(row('BL'), { dataTransfer });
    at('dragOver', row('A'), 2);
    expect(row('A').dataset.drop).toBeUndefined();
    fireEvent.dragEnd(row('BL'), { dataTransfer });
    expect(changes).toHaveLength(2);
    vi.restoreAllMocks();
  });
});

describe('condition builder', () => {
  const vars = variablesOf(draft(), 'en');

  it('edits a condition as rows and as an expression', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <ConditionBuilder label="Show only if" value="A == 1" variables={vars} onChange={onChange} />,
    );
    expect((screen.getByLabelText('Condition 1: variable') as HTMLInputElement).value).toBe('A');
    expect((screen.getByLabelText('Condition 1: comparison') as HTMLSelectElement).value).toBe(
      '==',
    );
    await user.selectOptions(screen.getByLabelText('Condition 1: value'), '2');
    expect(onChange).toHaveBeenLastCalledWith('A == 2');
    await expectAccessible(container);

    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    const second = screen.getByLabelText('Condition 2: variable');
    await user.clear(second);
    await user.type(second, 'B');
    await user.selectOptions(screen.getByLabelText('Condition 2: comparison'), '>=');
    await user.type(screen.getByLabelText('Condition 2: value'), '18');
    expect(onChange).toHaveBeenLastCalledWith('A == 2 and B >= 18');

    await user.click(screen.getByRole('button', { name: 'Edit as expression' }));
    const box = screen.getByRole('textbox', { name: 'Show only if' });
    expect((box as HTMLTextAreaElement).value).toBe('A == 2 and B >= 18');
    await user.clear(box);
    await user.type(box, 'A == 1 and (B > 1 or NOPE == 2)');
    expect(screen.getByText('Unknown: NOPE')).toBeTruthy();

    // Nested groups now fit the builder.
    await user.clear(box);
    await user.type(box, 'A == 1 and (B > C or not answered(C))');
    expect(screen.getByTestId('condition-summary').textContent).toBe(
      'Reads as: A is “Yes” (1) and (B > C or C is not answered)',
    );
    await user.click(screen.getByRole('button', { name: 'Edit as conditions' }));
    const group = screen.getByRole('group', { name: 'Group 2' });
    expect(within(group).getAllByTestId('condition-row')).toHaveLength(2);
    expect((screen.getByLabelText('Type of Condition 2.1: value') as HTMLSelectElement).value).toBe(
      'var',
    );
    await user.selectOptions(within(group).getByLabelText('Group 2: Match'), 'all');
    expect(onChange).toHaveBeenLastCalledWith('A == 1 and (B > C and not answered(C))');
    await expectAccessible(container);

    // Try it with sample answers: A == 1 and (B > C or C not answered).
    await user.selectOptions(within(group).getByLabelText('Group 2: Match'), 'any');
    await user.click(screen.getByText('Try it with sample answers'));
    await user.selectOptions(screen.getByLabelText('Test answer for A'), '1');
    await user.type(screen.getByLabelText('Test answer for B'), '5');
    expect(screen.getByTestId('try-result').dataset.result).toBe('true');
    await user.type(screen.getByLabelText('Test answer for C'), '9');
    expect(screen.getByTestId('try-result').dataset.result).toBe('false');
  });

  it('adds groups and compares against other variables and functions', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConditionBuilder label="When" value="" variables={vars} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    await user.click(screen.getByRole('button', { name: 'Add group' }));
    await user.selectOptions(screen.getByLabelText('Condition 1: value'), '1');
    const v21 = screen.getByLabelText('Condition 2.1: variable');
    await user.clear(v21);
    await user.type(v21, 'B');
    await user.selectOptions(screen.getByLabelText('Condition 2.1: comparison'), '>');
    await user.selectOptions(screen.getByLabelText('Type of Condition 2.1: value'), 'call');
    await user.selectOptions(screen.getByLabelText('Function for Condition 2.1: value'), 'length');
    await user.type(screen.getByLabelText('Argument 1 of Condition 2.1: value'), 'C');
    expect(onChange).toHaveBeenLastCalledWith('A == 1 and B > length(C)');
  });

  it('starts in expression mode for conditions the rows cannot show', () => {
    render(
      <ConditionBuilder label="When" value="B + 1 > 3" variables={vars} onChange={() => {}} />,
    );
    expect(screen.getByRole('textbox', { name: 'When' })).toBeTruthy();
  });
});

describe('editors', () => {
  it('question and settings editors have no accessibility problems', async () => {
    const d = Questionnaire.parse(household);
    const vars = variablesOf(d, 'en');
    const first = flatten(d).find((x) => 'type' in x.node)!.node.id;
    const { container, unmount } = render(
      <ItemEditor
        draft={d}
        id={first}
        lang="en"
        variables={vars}
        change={() => {}}
        focusNameSignal={0}
        select={() => {}}
      />,
    );
    await expectAccessible(container);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Logic' }));
    await expectAccessible(container);
    unmount();
    const s = render(<SettingsEditor draft={d} variables={vars} change={() => {}} />);
    await expectAccessible(s.container);
  });
});

function RoutingHarness({ onOpen }: { onOpen(id: string): void }) {
  const q = Questionnaire.parse(household);
  const routing = useRouting({ questionnaire: q });
  return <RoutingMap draft={q} routing={routing!} lang="en" onOpen={onOpen} />;
}

describe('routing', () => {
  it('maps the household survey with conditions, skips and ends in words', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { container } = render(<RoutingHarness onOpen={onOpen} />);
    const map = screen.getByTestId('routing-map');
    const cards = within(map).getAllByTestId('routing-card');
    expect(cards.length).toBeGreaterThan(20);
    expect(map.textContent).toMatch(/Asked only if/);
    expect(map.textContent).toMatch(/Skips to/);
    expect(map.textContent).toMatch(/Ends as/);
    await expectAccessible(container);

    const first = within(cards[0]!).getAllByRole('button').at(-1)!;
    first.focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText('Only items with logic'));
    expect(within(map).getAllByTestId('routing-card').length).toBeLessThan(cards.length);
  });

  it('shows logic badges in the outline', () => {
    const q = Questionnaire.parse(household);
    function H() {
      const routing = useRouting({ questionnaire: q });
      return (
        <Outline
          draft={q}
          selected={q.sections[0]!.id}
          onSelect={() => {}}
          change={() => {}}
          errorsById={new Map()}
          routing={routing}
          lang="en"
          readOnly
          onRename={() => {}}
          onEnter={() => {}}
          announce={() => {}}
        />
      );
    }
    render(<H />);
    expect(screen.getAllByTestId('logic-badges').length).toBeGreaterThan(3);
    expect(screen.getAllByRole('img', { name: /^Conditional: / }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img', { name: /^Skips: / }).length).toBeGreaterThan(0);
  });
});

describe('translations panel', () => {
  it('previews an imported CSV and applies it as one change', async () => {
    const user = userEvent.setup();
    const q = Questionnaire.parse(household);
    const change = vi.fn();
    const { container } = render(<TranslationsPanel draft={q} change={change} />);
    const csv =
      'key,context,es,fr\ntitle,Questionnaire title,Encuesta nueva,Enquête\nGONE.text,,x,\n';
    await user.upload(
      screen.getByLabelText('Import translations (.csv or .xlf)'),
      new File([csv], 'texts.csv', { type: 'text/csv' }),
    );
    const preview = await screen.findByTestId('translation-preview');
    expect(preview.textContent).toContain('1 text changes');
    expect(preview.textContent).toContain('GONE.text');
    expect(preview.textContent).toContain('skipped: fr');
    expect(within(preview).getByRole('cell', { name: 'Encuesta nueva' })).toBeTruthy();
    await expectAccessible(container);
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(change).toHaveBeenCalledTimes(1);
    expect((change.mock.calls[0]![0] as Draft).title.es).toBe('Encuesta nueva');
    expect(screen.getByText(/1 text updated/)).toBeTruthy();
  });
});

describe('version comparison', () => {
  it('lists what changed between v1 and the draft, side by side', async () => {
    const v1 = Questionnaire.parse(household);
    const draft = structuredClone(v1);
    draft.sections[0]!.items = draft.sections[0]!.items.filter((n) => n.id !== 'A3');
    const c5 = draft.sections[2]!.items.find((n) => n.id === 'C5') as { showIf: string };
    c5.showIf = 'C4_WATER == 2';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ definition: v1 }), { status: 200 })),
    );
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ComparePanel
          projectId="p"
          qid="q"
          draft={draft}
          versions={[
            {
              version: 1,
              status: 'published',
              hash: 'h',
              hasMapping: false,
              publishedAt: '2026-10-01T00:00:00Z',
              publishedBy: null,
              retiredAt: null,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    const summary = await screen.findByTestId('compare-summary');
    expect(summary.textContent).toBe('0 added · 1 removed · 1 edited · 0 moved');
    const c5Row = container.querySelector('[data-compare-item="C5"]')!;
    expect(c5Row.textContent).toContain('Edited');
    expect(c5Row.textContent).toContain('C4_WATER in (2, 3)');
    expect(c5Row.textContent).toContain('C4_WATER == 2');
    expect(container.querySelector('[data-compare-item="A3"]')!.textContent).toContain('Removed');
    await expectAccessible(container);
    vi.unstubAllGlobals();
  });
});
