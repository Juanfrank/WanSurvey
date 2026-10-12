import { describe, expect, it } from 'vitest';
import { projectSettings } from '../src/index.js';

describe('project settings', () => {
  it('fills in defaults', () => {
    expect(projectSettings({})).toMatchObject({
      revealToInterviewers: true,
      assignmentMode: 'assigned',
    });
    expect(projectSettings(null).cati).toEqual({
      callingHours: { from: '09:00', to: '21:00' },
      maxAttempts: 8,
      retryMinutes: { no_answer: 120, busy: 15, voicemail: 240 },
    });
  });

  it('keeps stored values and falls back on invalid ones', () => {
    expect(projectSettings({ assignmentMode: 'pool' }).assignmentMode).toBe('pool');
    expect(projectSettings({ assignmentMode: 'lottery' }).assignmentMode).toBe('assigned');
  });
});
