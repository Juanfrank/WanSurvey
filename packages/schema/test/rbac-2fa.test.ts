import { describe, expect, it } from 'vitest';
import { rolesRequiring2fa, TwoFactorRoles } from '../src/index.js';

describe('two-step policy', () => {
  it('always keeps owners and administrators and adds the organisation’s roles', () => {
    expect(rolesRequiring2fa(undefined)).toEqual(['owner', 'admin']);
    expect(rolesRequiring2fa({ twoFactorRoles: ['supervisor', 'nobody', 'supervisor'] })).toEqual([
      'owner',
      'admin',
      'supervisor',
    ]);
    expect(rolesRequiring2fa({ twoFactorRoles: 'interviewer' })).toEqual(['owner', 'admin']);
  });

  it('accepts only the roles that are not always required', () => {
    expect(TwoFactorRoles.safeParse(['interviewer', 'project_manager']).success).toBe(true);
    expect(TwoFactorRoles.safeParse(['owner']).success).toBe(false);
    expect(TwoFactorRoles.safeParse(['admin']).success).toBe(false);
    expect(TwoFactorRoles.safeParse(['supervisor', 'supervisor']).success).toBe(false);
  });
});
