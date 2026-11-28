import { describe, expect, it } from 'vitest';
import { externalAccessOpened, isExternalClient, ROLE_PERMISSIONS } from '../src/index.js';

const P = '0192f000-0000-7000-8000-000000000001';

describe('roles given to an external client', () => {
  it('knows a person of the client organisation by their roles for the whole organisation', () => {
    expect(isExternalClient([{ role: 'client_viewer', projectId: null }])).toBe(true);
    expect(
      isExternalClient([
        { role: 'client_viewer', projectId: null },
        { role: 'reviewer', projectId: P },
      ]),
    ).toBe(true);
    expect(isExternalClient([{ role: 'reviewer', projectId: P }])).toBe(false);
    expect(isExternalClient([{ role: 'interviewer', projectId: null }])).toBe(false);
  });

  it('lists what new roles open, before or after the change', () => {
    const client = { role: 'client_viewer', projectId: null };
    expect(
      externalAccessOpened(
        [client],
        [client, { role: 'reviewer', projectId: P }],
        ROLE_PERMISSIONS,
      ),
    ).toEqual(['interviews.read_all', 'audio.listen']);
    // Taking away the client role in the same change does not skip the question.
    expect(
      externalAccessOpened([client], [{ role: 'reviewer', projectId: P }], ROLE_PERMISSIONS),
    ).toEqual(['interviews.read_all', 'audio.listen']);
    // A role already held, a harmless one, or someone of the organisation: nothing to ask.
    const held = [client, { role: 'reviewer', projectId: P.toUpperCase() }];
    expect(
      externalAccessOpened(held, [client, { role: 'reviewer', projectId: P }], ROLE_PERMISSIONS),
    ).toEqual([]);
    expect(externalAccessOpened([], [client], ROLE_PERMISSIONS)).toEqual([]);
    expect(
      externalAccessOpened(
        [{ role: 'interviewer', projectId: null }],
        [{ role: 'supervisor', projectId: null }],
        ROLE_PERMISSIONS,
      ),
    ).toEqual([]);
    // Someone of the organisation who becomes a client keeping a project role: that role counts.
    expect(
      externalAccessOpened(
        [
          { role: 'interviewer', projectId: null },
          { role: 'reviewer', projectId: P },
        ],
        [client, { role: 'reviewer', projectId: P }],
        ROLE_PERMISSIONS,
      ),
    ).toEqual(['interviews.read_all', 'audio.listen']);
  });
});
