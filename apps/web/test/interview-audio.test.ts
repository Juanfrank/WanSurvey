import { describe, expect, it } from 'vitest';
import {
  MemorySegmentStore,
  flushSegments,
  type PutSegment,
  type Segment,
} from '../src/interview/audio.js';

const seg = (n: number): Segment => ({
  interviewId: 'iv1',
  n,
  blob: new Blob([`audio-${n}`], { type: 'audio/webm' }),
  durationMs: 30_000,
});
const hash = async (b: Blob) => `h-${await b.text()}`;

async function filled() {
  const store = new MemorySegmentStore();
  for (const n of [0, 1, 2]) await store.put(seg(n));
  return store;
}

describe('sending the recording segments', () => {
  it('sends them in order and drops each one the server took', async () => {
    const store = await filled();
    const sent: number[] = [];
    const put: PutSegment = async (s, sha) => {
      sent.push(s.n);
      expect(sha).toBe(`h-audio-${s.n}`);
      return { status: 204 };
    };
    expect(await flushSegments(store, 'iv1', put, hash)).toBe(0);
    expect(sent).toEqual([0, 1, 2]);
  });

  it('keeps everything and stops when the connection is down or the server is in trouble', async () => {
    const store = await filled();
    let calls = 0;
    const down: PutSegment = async () => {
      calls++;
      throw new TypeError('network');
    };
    expect(await flushSegments(store, 'iv1', down, hash)).toBe(3);
    const busy: PutSegment = async () => {
      calls++;
      return { status: 503 };
    };
    expect(await flushSegments(store, 'iv1', busy, hash)).toBe(3);
    // One try per run: the order is kept, and nothing is hammered.
    expect(calls).toBe(2);
  });

  it('waits when the consent has not reached the server yet, and sends once it has', async () => {
    const store = await filled();
    let consented = false;
    const put: PutSegment = async () =>
      consented ? { status: 204 } : { status: 409, code: 'CONSENT_REQUIRED' };
    expect(await flushSegments(store, 'iv1', put, hash)).toBe(3);
    consented = true;
    expect(await flushSegments(store, 'iv1', put, hash)).toBe(0);
  });

  it('drops a segment the server already holds, or will never take', async () => {
    const store = await filled();
    const answers = [
      { status: 409, code: 'SEGMENT_EXISTS' },
      { status: 409, code: 'NOT_RECORDED' },
      { status: 413 },
    ];
    let i = 0;
    const put: PutSegment = async () => answers[i++]!;
    expect(await flushSegments(store, 'iv1', put, hash)).toBe(0);
  });

  it('keeps one interview’s segments apart from another’s', async () => {
    const store = await filled();
    await store.put({ ...seg(0), interviewId: 'iv2' });
    await flushSegments(store, 'iv1', async () => ({ status: 204 }), hash);
    expect(await store.list('iv2')).toHaveLength(1);
  });
});
