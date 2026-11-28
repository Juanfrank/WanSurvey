import { describe, expect, it } from 'vitest';
import { feedbackEmailHtml, feedbackIframeHtml } from '../src/feedback/FeedbackParts.js';

describe('feedback embed code', () => {
  const point = {
    url: 'https://x.test/f/abc',
    faces: 3 as const,
    name: 'Desk "A"',
    askComment: false,
  };

  it('is plain HTML for e-mail: no React className, no classes', () => {
    const html = feedbackEmailHtml(point, ['Bad', 'OK', 'Good']);
    expect(html).not.toMatch(/className=/);
    expect(html).not.toMatch(/\sclass=/);
    expect(html.startsWith('<table role="presentation" cellpadding="6">')).toBe(true);
    expect(html.endsWith('</table>')).toBe(true);
    expect(html).toContain('href="https://x.test/f/abc?r=3"');
    expect(html.match(/<td /g)).toHaveLength(3);
  });

  it('escapes labels and names', () => {
    expect(feedbackEmailHtml(point, ['<b>', 'a"b', 'c&d'])).toContain('title="&lt;b&gt;"');
    expect(feedbackIframeHtml(point)).toContain('title="Desk &quot;A&quot;"');
    expect(feedbackIframeHtml({ ...point, askComment: true })).toContain('height="320"');
  });
});
