import { describe, expect, it } from 'vitest';
import { twoStepRequired } from '../src/index.js';

describe('two-step verification for password sign-in', () => {
  it('is required of every role', () => {
    for (const roles of [[], ['interviewer'], ['client_viewer'], ['owner']])
      expect(twoStepRequired(roles, true)).toBe(true);
  });

  it('falls back to owners and administrators only where the server relaxes it', () => {
    expect(twoStepRequired(['owner'], false)).toBe(true);
    expect(twoStepRequired(['interviewer', 'admin'], false)).toBe(true);
    expect(twoStepRequired(['supervisor', 'interviewer'], false)).toBe(false);
    expect(twoStepRequired([], false)).toBe(false);
  });
});
