import { describe, expect, it } from 'vitest';
import { htmlBody } from '../src/cawi/cawi.service.js';

describe('the HTML of an invitation', () => {
  it('carries the open pixel only when the project measures opens', () => {
    const text = 'Hola\nResponda en https://x.test/t/c/abc';
    const tracked = htmlBody(text, 'https://x.test/api/v1/t/o/abc.gif');
    expect(tracked).toContain('<img src="https://x.test/api/v1/t/o/abc.gif"');
    const plain = htmlBody(text, null);
    expect(plain).not.toContain('<img');
    // The link stays: it is how the person reaches the survey.
    expect(plain).toContain('<a href="https://x.test/t/c/abc">');
  });
});
