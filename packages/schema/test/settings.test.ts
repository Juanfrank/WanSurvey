import { describe, expect, it } from 'vitest';
import { projectSettings, ShortcutSettings } from '../src/index.js';

describe('project settings', () => {
  it('fill shortcuts and retention with defaults', () => {
    const s = projectSettings({});
    expect(s.shortcuts).toEqual({
      dontKnow: 'F7',
      refused: 'F8',
      note: 'm',
      navigator: 'g',
      pause: 'p',
    });
    expect(s.retention.anonymiseAfterDays).toBeNull();
  });

  it('refuse clashing shortcuts', () => {
    expect(ShortcutSettings.safeParse({ dontKnow: 'F2', refused: 'F2' }).success).toBe(false);
    expect(ShortcutSettings.safeParse({ note: 'g' }).success).toBe(false);
    expect(ShortcutSettings.safeParse({ note: 'M' }).success).toBe(false);
    expect(ShortcutSettings.safeParse({ dontKnow: 'F5' }).success).toBe(false);
    expect(ShortcutSettings.safeParse({ note: 't' }).success).toBe(false);
    expect(ShortcutSettings.parse({ dontKnow: 'F2', note: 'k' })).toMatchObject({
      dontKnow: 'F2',
      note: 'k',
    });
  });
});
