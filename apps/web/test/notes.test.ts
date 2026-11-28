import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { noteText } from '../src/i18n-messages.js';

describe('status messages (noteText)', () => {
  it('are written out in the language of the moment they are shown', async () => {
    const t = i18next.t.bind(i18next);
    await i18next.changeLanguage('en');
    const note = { key: 'cawi.links.made', vars: { count: 11 } };
    expect(noteText(t, note)).toBe('11 personal links made.');
    await i18next.changeLanguage('es');
    expect(noteText(t, note)).toBe('Se generaron 11 enlaces personales.');
    // A value that is a note is translated too; parts are joined; null is nothing.
    expect(
      noteText(t, {
        key: 'review.screen.done',
        vars: { status: { key: 'interview.status.approved' } },
      }),
    ).not.toContain('interview.status');
    expect(
      noteText(t, {
        parts: [{ key: 'cases.settings.saved' }, null, { text: 'https://x.test/a' }],
      }),
    ).toBe(`${t('cases.settings.saved')} https://x.test/a`);
    expect(noteText(t, null)).toBe('');
    await i18next.changeLanguage('en');
  });
});
