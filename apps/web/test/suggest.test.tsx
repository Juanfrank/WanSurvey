import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Suggest } from '../src/designer/Suggest.js';
import {
  applySuggestion,
  expressionSuggestions,
  fieldSuggestions,
  rank,
  tokenAt,
} from '../src/designer/suggest.js';
import type { VarOption } from '../src/designer/vars.js';

const vars: VarOption[] = [
  { name: 'AGE', id: 'AGE', kind: 'question', text: '¿Edad?', numeric: true },
  { name: 'AGE_GROUP', id: 'AGE_GROUP', kind: 'computed', text: 'Grupo de edad', numeric: false },
  { name: 'case.region', id: 'case.region', kind: 'case', text: 'Región', numeric: false },
  { name: 'case.city', id: 'case.city', kind: 'case', text: 'Ciudad', numeric: false },
];

describe('suggestions for expressions', () => {
  it('finds the word at the cursor, and none inside a text or in a number', () => {
    expect(tokenAt('AGE > 1 and case.re', 19)).toEqual({ start: 12, end: 19, text: 'case.re' });
    expect(tokenAt('matches(case.job, "^ce', 22)).toBeNull();
    expect(tokenAt('AGE > 12', 8)).toBeNull();
    expect(tokenAt('AGE > ', 6)).toEqual({ start: 6, end: 6, text: '' });
  });

  it('ranks what starts with the word first, then what holds it, never the exact word', () => {
    const all = expressionSuggestions(vars);
    expect(
      rank(all, 'ag')
        .map((s) => s.label)
        .slice(0, 3),
    ).toEqual(['AGE', 'AGE_GROUP', 'age']);
    expect(rank(all, 'reg')[0]!.label).toBe('case.region');
    expect(rank(all, 'AGE').map((s) => s.label)).not.toContain('AGE');
    expect(rank(all, '').length).toBe(8);
  });

  it('puts the cursor inside the brackets of a function', () => {
    const fn = expressionSuggestions([]).find((s) => s.label === 'answered')!;
    const tok = tokenAt('x and ans', 9)!;
    expect(applySuggestion('x and ans', tok, fn)).toEqual({ text: 'x and answered()', caret: 15 });
  });

  it('offers the sample fields as case.x with the functions, for the rules at load', () => {
    const s = fieldSuggestions(['age', 'job']);
    expect(s.map((x) => x.label)).toEqual(
      expect.arrayContaining(['case.age', 'case.job', 'matches']),
    );
  });
});

function Harness({ initial = '', multiline = false }: { initial?: string; multiline?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <label htmlFor="e">Condición</label>
      <Suggest
        id="e"
        value={v}
        onChange={setV}
        suggestions={expressionSuggestions(vars)}
        multiline={multiline}
      />
      <p data-testid="value">{v}</p>
    </>
  );
}

describe('the drop-down', () => {
  it('opens while typing, moves with the arrows, takes a suggestion with Enter, closes with Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Condición' });
    await user.type(box, 'case.r');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('option', { name: /case\.region/ })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('case.region');
    expect(box.getAttribute('aria-expanded')).toBe('false');

    await user.type(box, ' and ag');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    expect(box.getAttribute('aria-expanded')).toBe('false');
    // With the list closed, Enter is the field's own.
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value').textContent).toContain('and ag');
  });

  it('takes a suggestion with a click, and shows the list on Ctrl+Space', async () => {
    const user = userEvent.setup();
    render(<Harness initial="AGE > 1 and " />);
    const box = screen.getByRole('combobox', { name: 'Condición' }) as HTMLInputElement;
    box.focus();
    box.setSelectionRange(12, 12);
    fireEvent.keyDown(box, { key: ' ', ctrlKey: true });
    expect(box.getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getAllByRole('option')[0]!);
    expect(screen.getByTestId('value').textContent!.length).toBeGreaterThan(12);
  });

  it('as a text area, announces the suggestions instead of being a combobox', async () => {
    const user = userEvent.setup();
    render(<Harness multiline />);
    const box = screen.getByLabelText('Condición');
    expect(box.getAttribute('role')).toBeNull();
    await user.type(box, 'case.r');
    expect(screen.getByRole('status').textContent).toContain('case.region');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('case.region');
  });
});
