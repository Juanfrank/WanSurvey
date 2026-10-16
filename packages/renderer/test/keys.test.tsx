import { act, render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { allTypes } from '@wansurvey/fixtures';
import { compile, createInterview } from '@wansurvey/logic';
import { InterviewRunner } from '../src/InterviewRunner.js';

type Item = { id?: string };

/** A questionnaire holding just one question of the all-types sample. */
function at(key: string) {
  const item = allTypes.sections.flatMap((s) => s.items as Item[]).find((i) => i.id === key)!;
  const compiled = compile({
    ...allTypes,
    quotas: [],
    scripts: [],
    sections: [{ id: 'S', title: { es: 'S' }, items: [item] }],
  } as typeof allTypes);
  const session = createInterview(compiled, {
    mode: 'CATI',
    now: () => new Date('2026-10-12T10:00:00Z'),
    seed: 'k',
  });
  const user = userEvent.setup();
  render(<InterviewRunner session={session} mode="CATI" lang="en" narrow={false} />);
  return { session, user };
}

describe('typing codes', () => {
  it('fills a grid row after row, in the order typed', async () => {
    const { session, user } = at('Q_GRID');
    await act(async () => {
      (document.querySelector('[data-qkey="Q_GRID"]') as HTMLElement).focus();
    });
    await user.keyboard('321');
    expect(session.getAnswer('Q_GRID')).toEqual({ water: 3, power: 2, roads: 1 });
  });

  it('ranks options in the order their codes are typed; typing one again takes it out', async () => {
    const { session, user } = at('Q_RANK');
    await act(async () => {
      (document.querySelector('[data-qkey="Q_RANK"]') as HTMLElement).focus();
    });
    await user.keyboard('3');
    expect(session.getAnswer('Q_RANK')).toEqual([3, 1, 2]);
    await user.keyboard('1');
    expect(session.getAnswer('Q_RANK')).toEqual([3, 1, 2]);
    await user.keyboard('2');
    expect(session.getAnswer('Q_RANK')).toEqual([3, 1, 2]);
    await user.keyboard('3');
    expect(session.getAnswer('Q_RANK')).toEqual([1, 2, 3]);
  });
});
