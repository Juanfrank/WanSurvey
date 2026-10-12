import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { household } from '@wansurvey/fixtures';
import { Questionnaire } from '@wansurvey/schema';
import axe from 'axe-core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConditionBuilder } from '../src/designer/ConditionBuilder.js';
import { ItemEditor } from '../src/designer/ItemEditor.js';
import { Outline } from '../src/designer/Outline.js';
import { SettingsEditor } from '../src/designer/SettingsEditor.js';
import {
  duplicate,
  flatten,
  indent,
  insert,
  locate,
  move,
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
    expect(
      screen.getByRole('button', { name: 'Edit as conditions' }).hasAttribute('disabled'),
    ).toBe(true);
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
