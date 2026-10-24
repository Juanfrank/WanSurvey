import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { HIDDEN_GRACE_MS, InterviewClock } from '../src/interview/paradata.js';
import { alignCopy, InterviewStore, MemoryStore, type NewOp } from '../src/interview/store.js';
import { Syncer, type SyncResult } from '../src/interview/sync.js';

const answer = (variable: string, newValue: unknown): NewOp => ({
  kind: 'answer',
  variable,
  oldValue: null,
  newValue,
  at: '2026-10-12T10:00:00.000Z',
  source: 'interviewer',
  reason: null,
});
const snap = (n: number) => ({
  state: { answers: { N: n } },
  position: 'Q',
  activeMs: n,
  totalMs: n,
});
let dbN = 0;
const freshStore = () => InterviewStore.open(`test-${++dbN}`);

describe('interview store', () => {
  it('numbers changes, keeps them until acknowledged, and remembers the device', async () => {
    const store = await freshStore();
    const device = await store.deviceId();
    expect(device).toMatch(/^web-/);
    expect(await store.deviceId()).toBe(device);
    expect(await store.record('i1', [answer('A', 1), answer('B', 2)], snap(1))).toBe(2);
    expect(await store.record('i1', [answer('A', 3)], snap(2))).toBe(3);
    expect((await store.pending('i1')).map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(await store.get('i1')).toMatchObject({ seq: 3, acked: 0, state: { answers: { N: 2 } } });
    expect(await store.unsynced()).toEqual(['i1']);
    await store.acknowledge('i1', 2);
    expect((await store.pending('i1')).map((o) => o.seq)).toEqual([3]);
    await store.acknowledge('i1', 3);
    expect(await store.unsynced()).toEqual([]);
    await store.remove('i1');
    expect(await store.get('i1')).toBeNull();
    store.close();
  });
});

describe('sync loop', () => {
  it('sends pending changes with the snapshot, drops them when acknowledged, backs off on failure', async () => {
    const store = await freshStore();
    await store.record('i1', [answer('A', 1), answer('B', 2)], snap(5));
    let clock = 0;
    const sent: unknown[] = [];
    let fail = true;
    const send = vi.fn(async (body: unknown): Promise<SyncResult> => {
      sent.push(body);
      if (fail) throw new Error('offline');
      return { acks: { i1: 2 }, errors: {}, serverTime: '2026-10-12T10:00:00Z' };
    });
    const syncer = new Syncer(store, 'dev-1', send, () => clock);
    await expect(syncer.flush(['i1'])).rejects.toThrow('offline');
    expect(syncer.backingOff).toBe(true);
    expect(await syncer.flush(['i1'])).toBeNull();
    // The first wait is 1 s, give or take 20 % so devices that failed together spread out.
    clock += 1200;
    fail = false;
    const r = await syncer.flush(['i1']);
    expect(r?.acks).toEqual({ i1: 2 });
    expect(sent[1]).toMatchObject({
      deviceId: 'dev-1',
      interviews: [
        { id: 'i1', state: { answers: { N: 5 } }, activeMs: 5, ops: [{ seq: 1 }, { seq: 2 }] },
      ],
    });
    expect(await store.pending('i1')).toEqual([]);
    // Nothing pending: nothing sent.
    expect(await syncer.flush(['i1'])).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('never sends changes without their snapshot when one is written during a send', async () => {
    const store = await freshStore();
    await store.record('i1', [answer('A', 1)], snap(1));
    // A change lands while the sync is reading (the respondent answers again just then).
    const get = store.get.bind(store);
    let once = true;
    vi.spyOn(store, 'get').mockImplementation(async (id) => {
      const local = await get(id);
      if (once) {
        once = false;
        await store.record('i1', [answer('A', 2)], snap(2));
      }
      return local;
    });
    const sent: { interviews: { ops: { seq: number }[]; state?: unknown }[] }[] = [];
    const syncer = new Syncer(store, 'dev-1', async (body) => {
      const b = body as (typeof sent)[number];
      sent.push(b);
      const last = b.interviews[0]!.ops.at(-1)!.seq;
      return { acks: { i1: last }, errors: {}, serverTime: '2026-10-12T10:00:00Z' };
    });
    // Each send's snapshot matches its last change; the newer change follows with its own.
    await syncer.flush(['i1']);
    await syncer.flush(['i1']);
    expect(await store.pending('i1')).toEqual([]);
    const withState = sent.map((b) => b.interviews[0]!).filter((x) => 'state' in x);
    expect(withState.at(-1)).toMatchObject({
      ops: [{ seq: 2 }],
      state: { answers: { N: 2 } },
    });
    store.close();
  });

  it('records what the server refuses', async () => {
    const store = await freshStore();
    await store.record('i1', [answer('A', 1)], snap(1));
    const syncer = new Syncer(store, 'dev-1', async () => ({
      acks: {},
      errors: { i1: 'NOT_THIS_DEVICE' },
      serverTime: '2026-10-12T10:00:00Z',
    }));
    await syncer.flush(['i1']);
    expect(syncer.problems.get('i1')).toBe('NOT_THIS_DEVICE');
    expect(await store.pending('i1')).toHaveLength(1);
    store.close();
  });
});

describe("the server's copy and this device's", () => {
  const server = (over: Partial<Parameters<typeof alignCopy>[1]> = {}) => ({
    id: 'i1',
    lastSeq: 2,
    state: { answers: { N: 99 } },
    stateVersion: 5,
    ownState: false,
    activeMs: 10,
    totalMs: 10,
    ...over,
  });

  it("takes the server's copy when this device has nothing left to send", async () => {
    // The link was answered here (2 changes), then on another device: the server is ahead.
    const store = await freshStore();
    await store.adopt('i1', { ...snap(0), seq: 0, acked: 0, base: 1 });
    await store.record('i1', [answer('A', 1), answer('B', 2)], snap(2));
    await store.acknowledge('i1', 2, 2);
    const local = await alignCopy(store, server());
    expect(local).toMatchObject({ seq: 2, acked: 2, base: 5, state: { answers: { N: 99 } } });
    store.close();
  });

  it('keeps its own unsent changes on the same state, and drops them when another device went on', async () => {
    const store = await freshStore();
    await store.adopt('i1', { ...snap(0), seq: 2, acked: 2, base: 5 });
    await store.record('i1', [answer('A', 3)], snap(3));
    // Same version on the server, or a newer one this device wrote itself: the copy goes on.
    expect(await alignCopy(store, server())).toMatchObject({
      seq: 3,
      state: { answers: { N: 3 } },
    });
    expect(await alignCopy(store, server({ stateVersion: 6, ownState: true }))).toMatchObject({
      seq: 3,
      state: { answers: { N: 3 } },
    });
    // Another device wrote version 6: its state wins and this device's change is dropped.
    expect(await alignCopy(store, server({ stateVersion: 6 }))).toMatchObject({
      seq: 2,
      acked: 2,
      base: 6,
      state: { answers: { N: 99 } },
    });
    expect(await store.pending('i1')).toEqual([]);
    store.close();
  });

  it('sends the version its snapshot builds on, and keeps the one the server wrote', async () => {
    const store = await freshStore();
    await store.adopt('i1', { ...snap(0), seq: 0, acked: 0, base: 4 });
    await store.record('i1', [answer('A', 1)], snap(1));
    const bodies: { interviews: { baseVersion?: number }[] }[] = [];
    const syncer = new Syncer(store, 'dev', async (body) => {
      bodies.push(body as (typeof bodies)[number]);
      return { acks: { i1: 1 }, errors: {}, versions: { i1: 5 }, serverTime: '' };
    });
    await syncer.flush(['i1']);
    expect(bodies[0]!.interviews[0]!.baseVersion).toBe(4);
    expect(await store.get('i1')).toMatchObject({ acked: 1, base: 5 });
    store.close();
  });

  it('a copy in memory numbers, sends and acknowledges like the device store', async () => {
    const mem = new MemoryStore();
    expect(await mem.deviceId()).toMatch(/^web-/);
    await mem.record('i1', [answer('A', 1), answer('B', 2)], snap(2));
    const syncer = new Syncer(mem, await mem.deviceId(), async () => ({
      acks: { i1: 2 },
      errors: {},
      versions: { i1: 1 },
      serverTime: '',
    }));
    await syncer.flush(['i1']);
    expect(await mem.pending('i1')).toEqual([]);
    expect(await mem.get('i1')).toMatchObject({ seq: 2, acked: 2, base: 1 });
  });
});

describe('offline work', () => {
  it('keeps downloaded cases and versions, and sends an offline start until the server has it', async () => {
    const store = await freshStore();
    await store.putVersion({ id: 'v1', version: 1, compiled: { hash: 'h' } });
    await store.putCase({
      caseId: 'c1',
      projectId: 'p',
      projectName: 'P',
      externalId: 'HH1',
      context: {},
      questionnaireVersionId: 'v1',
      interviewId: null,
      status: 'ready',
      disposition: null,
      problem: null,
      downloadedAt: '2026-10-12T10:00:00.000Z',
      capi: { gps: 'off', gpsNotice: '' },
    });
    expect((await store.cases('p')).map((c) => c.externalId)).toEqual(['HH1']);
    expect(await store.getVersion('v1')).toMatchObject({ version: 1 });
    await store.adopt('i1', {
      seq: 0,
      acked: 0,
      state: null,
      position: null,
      activeMs: 0,
      totalMs: 0,
    });
    const start = {
      caseId: 'c1',
      questionnaireVersionId: 'v1',
      mode: 'CAPI' as const,
      language: 'es',
      startedAt: '2026-10-12T10:00:00.000Z',
    };
    await store.patch('i1', { start });
    // Not started on the server yet: it counts as unsynced even with no changes.
    expect(await store.unsynced()).toEqual(['i1']);
    await store.record('i1', [answer('A', 1)], snap(1));
    const bodies: { interviews: { start?: unknown }[] }[] = [];
    const send = vi.fn(async (body: unknown) => {
      bodies.push(body as (typeof bodies)[number]);
      return { acks: { i1: 1 }, errors: {}, serverTime: '' } as SyncResult;
    });
    const syncer = new Syncer(store, 'dev', send);
    await syncer.flush(['i1']);
    expect(bodies[0]!.interviews[0]!.start).toEqual(start);
    // Created on the server: the start is not sent again.
    expect((await store.get('i1'))!.start).toBeUndefined();
    await store.record('i1', [answer('A', 2)], snap(2));
    await syncer.flush(['i1']);
    expect(bodies[1]!.interviews[0]!.start).toBeUndefined();
    store.close();
  });
});

describe('interview clock', () => {
  it('counts active time without pauses and long hidden periods, on the server clock', () => {
    let now = 1000;
    const c = new InterviewClock('2026-10-12T10:00:00.000Z', () => now, {
      activeMs: 500,
      totalMs: 600,
    });
    now += 10_000;
    expect(c.at()).toEqual({ at: '2026-10-12T10:00:10.000Z', monotonicMs: 10_000 });
    expect(c.activeMs()).toBe(10_500);
    c.pause();
    now += 60_000;
    expect(c.resume()).toBe(60_000);
    expect(c.activeMs()).toBe(10_500);
    expect(c.totalMs()).toBe(70_600);
    // Hidden briefly: still active. Hidden long: not.
    c.hidden();
    now += 5000;
    c.visible();
    expect(c.activeMs()).toBe(15_500);
    c.hidden();
    now += HIDDEN_GRACE_MS + 10_000;
    expect(c.activeMs()).toBe(15_500);
    c.visible();
    expect(c.activeMs()).toBe(15_500);
  });

  it('times each question', () => {
    let now = 0;
    const c = new InterviewClock('2026-10-12T10:00:00Z', () => now);
    expect(c.enter('Q1')).toBeNull();
    now += 4200;
    expect(c.onQuestionMs()).toBe(4200);
    expect(c.enter('Q2')).toEqual({ left: 'Q1', ms: 4200 });
  });
});
