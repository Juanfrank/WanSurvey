import axe from 'axe-core';
import { expect } from 'vitest';

/** Runs axe-core on a rendered container; colour contrast needs real layout, so it is checked in the browser E2E. */
export async function expectNoAxeViolations(container: Element) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  const summary = result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(summary).toEqual([]);
}
