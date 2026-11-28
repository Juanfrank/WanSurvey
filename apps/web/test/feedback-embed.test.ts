import { describe, expect, it } from 'vitest';
import { feedbackEmailHtml, feedbackIframeHtml, withQuery } from '../src/feedback/FeedbackParts.js';

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

  it('adds to a query the URL already has instead of starting a second one', () => {
    const tagged = { ...point, url: 'https://x.test/f/abc?ref=mail' };
    expect(feedbackEmailHtml(tagged, ['Bad', 'OK', 'Good'])).toContain(
      'href="https://x.test/f/abc?ref=mail&amp;r=3"',
    );
    expect(feedbackIframeHtml(tagged)).toContain('src="https://x.test/f/abc?ref=mail&amp;embed=1"');
    expect(feedbackIframeHtml(point)).toContain('src="https://x.test/f/abc?embed=1"');
  });

  it('withQuery keeps the fragment, replaces a repeated key and skips empty values', () => {
    expect(withQuery('https://x.test/f/abc', { r: 2 })).toBe('https://x.test/f/abc?r=2');
    expect(withQuery('https://x.test/f/abc?', { r: 2 })).toBe('https://x.test/f/abc?r=2');
    expect(withQuery('https://x.test/f/abc?a=1#top', { r: 2 })).toBe(
      'https://x.test/f/abc?a=1&r=2#top',
    );
    expect(withQuery('https://x.test/f/abc?r=1', { r: 5 })).toBe('https://x.test/f/abc?r=5');
    expect(withQuery('https://x.test/f/abc', { sede: 'Centro Norte', x: '' })).toBe(
      'https://x.test/f/abc?sede=Centro%20Norte',
    );
    // What the link already has stays as written.
    expect(withQuery('https://x.test/f/abc?flag&sig=a/b%20c', { r: 1 })).toBe(
      'https://x.test/f/abc?flag&sig=a/b%20c&r=1',
    );
  });
});
