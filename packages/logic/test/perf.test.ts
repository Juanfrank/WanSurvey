import { describe, expect, it } from 'vitest';
import type { ContainerItem } from '@wansurvey/schema';
import { compile } from '../src/compile.js';
import { createInterview } from '../src/engine.js';
import { q } from './builders.js';

/**
 * 500 items: chains of conditions and skips, a roster, computed variables. Each answer change
 * must re-evaluate within 20 ms (spec target on a mid-range Android tablet; we assert with margin).
 */
function bigQuestionnaire(n = 500) {
  const items: ContainerItem[] = [];
  const options = [1, 2, 3, 4].map((c) => ({ code: c, label: { en: `Option ${c}` } }));
  for (let i = 0; i < n; i++) {
    const id = `Q${i}`;
    const extra: Record<string, unknown> = {};
    if (i > 0 && i % 3 === 0) extra.showIf = `Q${i - 1} != 4 or answered(Q0)`;
    if (i > 2 && i % 7 === 0)
      extra.validations = [
        { id: 'v', severity: 'warning', when: `${id} == Q${i - 2}`, message: { en: 'same' } },
      ];
    if (i % 25 === 5 && i + 3 < n) extra.skips = [{ when: `${id} == 4`, to: `Q${i + 3}` }];
    if (i % 50 === 10) {
      items.push({
        kind: 'computed',
        id: `C${i}`,
        name: `C${i}`,
        valueType: 'number',
        formula: `sum(Q${i - 1}, Q${i - 2}, Q${i - 3})`,
      });
    }
    items.push({
      kind: 'question',
      id,
      name: id,
      type: 'single',
      text: { en: i > 0 ? `Question ${i} about {{Q0 | label}}` : 'First' },
      options,
      ...extra,
    } as ContainerItem);
  }
  items.push({
    kind: 'roster',
    id: 'R',
    name: 'R',
    count: { type: 'expression', expr: 'Q1 * 3' },
    items: [
      {
        kind: 'question',
        id: 'RX',
        name: 'RX',
        type: 'numeric',
        text: { en: 'x' },
        showIf: 'Q0 == 1 and index > 1',
      } as ContainerItem,
    ],
  });
  return q(items);
}

describe('performance', () => {
  const compiled = compile(bigQuestionnaire());

  it('re-evaluates a 500-item questionnaire in well under 20 ms per answer change', () => {
    const s = createInterview(compiled, { mode: 'CAPI' });
    for (let i = 0; i < 500; i++) s.setAnswer(`Q${i}`, (i % 3) + 1);
    const times: number[] = [];
    for (let k = 0; k < 60; k++) {
      const key = `Q${(k * 37) % 50}`; // early questions: worst case, everything after re-routes
      const t0 = performance.now();
      s.setAnswer(key, (k % 4) + 1);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.info(`500 items: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms per change`);
    // CI machines are faster than a mid-range tablet; keep a 4x margin.
    expect(median).toBeLessThan(5);
    expect(p95).toBeLessThan(20);
  });
});
