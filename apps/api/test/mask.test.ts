import { describe, expect, it } from 'vitest';
import { maskTokens } from '../src/common/mask.js';

describe('log masking', () => {
  it('hides tokens in paths and queries, keeps ids', () => {
    const id = '0199e0a4-1b2c-7d3e-8f40-123456789abc';
    expect(maskTokens(`/api/v1/public/s/${'a'.repeat(32)}/sync`)).toBe('/api/v1/public/s/…/sync');
    expect(maskTokens(`/api/v1/projects/${id}/cases`)).toBe(`/api/v1/projects/${id}/cases`);
    expect(maskTokens('/api/v1/auth/sso/callback?code=abc&state=xyz&x=1')).toBe(
      '/api/v1/auth/sso/callback?code=…&state=…&x=1',
    );
  });
});
