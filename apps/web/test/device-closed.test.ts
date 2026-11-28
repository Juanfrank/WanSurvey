import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.js';
import { settleClosedProject, type ClosedNotice } from '../src/interview/device.js';
import { InterviewStore, type DeviceCase } from '../src/interview/store.js';

let dbN = 0;
const freshStore = () => InterviewStore.open(`closed-${++dbN}`);
const AT = '2026-11-28T10:00:00.000Z';

const deviceCase = (
  caseId: string,
  projectId: string,
  version: string,
  interviewId: string | null = null,
): DeviceCase => ({
  caseId,
  projectId,
  projectName: projectId === 'p' ? 'Encuesta P' : 'Encuesta Q',
  externalId: caseId.toUpperCase(),
  context: { case: { name: 'Ana' } },
  questionnaireVersionId: version,
  interviewId,
  status: interviewId ? 'started' : 'ready',
  disposition: null,
  problem: null,
  downloadedAt: AT,
  capi: { gps: 'off', gpsNotice: '' },
});

/** Project p (closed) with two cases, one interviewed; project q (open) with its own case. */
async function holding() {
  const store = await freshStore();
  await store.putVersion({ id: 'v-p', version: 1, compiled: {} });
  await store.putVersion({ id: 'v-q', version: 1, compiled: {} });
  await store.putCase(deviceCase('c1', 'p', 'v-p', 'i1'));
  await store.putCase(deviceCase('c2', 'p', 'v-p'));
  await store.putCase(deviceCase('c3', 'q', 'v-q'));
  await store.adopt('i1', {
    seq: 0,
    acked: 0,
    state: null,
    position: null,
    activeMs: 0,
    totalMs: 0,
  });
  await store.patch('i1', {
    meta: {
      projectId: 'p',
      caseId: 'c1',
      externalId: 'C1',
      questionnaireVersionId: 'v-p',
      mode: 'CAPI',
      language: 'es',
      startedAt: AT,
      context: {},
    },
  });
  await store.record(
    'i1',
    [
      {
        kind: 'answer',
        variable: 'AGE',
        oldValue: null,
        newValue: 41,
        at: AT,
        source: 'interviewer',
        reason: null,
      },
    ],
    { state: { answers: { AGE: 41 } }, position: 'AGE', activeMs: 1, totalMs: 1 },
  );
  await store.setMeta('lastSync:p', AT);
  return store;
}

describe('a closed project on the device', () => {
  it('removes its cases, answers and questionnaires once everything was sent, and says so', async () => {
    const store = await holding();
    await store.acknowledge('i1', 1);
    const checkin = vi.fn(async () => ({ checkedIn: ['c1', 'c2'] }));
    const notice = await settleClosedProject(store, 'p', 'dev', AT, checkin);
    expect(checkin).toHaveBeenCalledWith('p', ['c1', 'c2']);
    expect(notice).toEqual<ClosedNotice>({
      projectId: 'p',
      name: 'Encuesta P',
      at: AT,
      removed: 2,
      kept: 0,
    });
    // Project p is gone from the device, its personal data included; project q is untouched.
    expect(await store.cases('p')).toEqual([]);
    expect(await store.get('i1')).toBeNull();
    expect(await store.pending('i1')).toEqual([]);
    expect(await store.getVersion('v-p')).toBeNull();
    expect(await store.getMeta('lastSync:p')).toBeNull();
    expect((await store.cases('q')).map((c) => c.caseId)).toEqual(['c3']);
    expect(await store.getVersion('v-q')).not.toBeNull();
    // The notice stays for "My device", and a later sync does not overwrite it.
    expect(await store.metaWith('closed:')).toEqual({ p: notice });
    expect(await settleClosedProject(store, 'p', 'dev', '2026-11-29T10:00:00.000Z', checkin)).toBe(
      null,
    );
    expect((await store.getMeta<ClosedNotice>('closed:p'))!.removed).toBe(2);
    store.close();
  });

  it('never removes an answer not yet sent: it stays, with a notice', async () => {
    const store = await holding();
    const checkin = vi.fn(async () => ({ checkedIn: [] }));
    const notice = await settleClosedProject(store, 'p', 'dev', AT, checkin);
    expect(notice).toMatchObject({ projectId: 'p', removed: 0, kept: 1 });
    expect(checkin).not.toHaveBeenCalled();
    expect(await store.cases('p')).toHaveLength(2);
    expect(await store.pending('i1')).toHaveLength(1);
    expect(await store.getVersion('v-p')).not.toBeNull();
    // The store refuses on its own too.
    await expect(store.purgeProject('p')).rejects.toMatchObject({ code: 'UNSENT_ON_DEVICE' });
    store.close();
  });

  it('without a connection, keeps everything for the next sync; a refusal does not stop it', async () => {
    const store = await holding();
    await store.acknowledge('i1', 1);
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await settleClosedProject(store, 'p', 'dev', AT, offline)).toBeNull();
    expect(await store.cases('p')).toHaveLength(2);
    const refused = vi.fn(async () => {
      throw new ApiError(403, { code: 'PROJECT_CLOSED', message: 'closed' });
    });
    const notice = await settleClosedProject(store, 'p', 'dev', AT, refused);
    expect(notice).toMatchObject({ removed: 2, kept: 0 });
    expect(await store.cases('p')).toEqual([]);
    store.close();
  });
});
