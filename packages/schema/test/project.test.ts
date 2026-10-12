import { describe, expect, it } from 'vitest';
import { projectSettings } from '../src/index.js';

describe('project settings', () => {
  it('fills in defaults', () => {
    expect(projectSettings({})).toEqual({ revealToInterviewers: true, assignmentMode: 'assigned' });
    expect(projectSettings(null)).toEqual({
      revealToInterviewers: true,
      assignmentMode: 'assigned',
    });
  });

  it('keeps stored values and falls back on invalid ones', () => {
    expect(projectSettings({ assignmentMode: 'pool' }).assignmentMode).toBe('pool');
    expect(projectSettings({ assignmentMode: 'lottery' }).assignmentMode).toBe('assigned');
  });
});
