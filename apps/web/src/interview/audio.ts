import { readCookie } from '../api.js';

/**
 * Recording of interviews for quality review (ADR 0001, decision 5), in the browser: only after
 * the respondent says yes, in segments of 30 seconds that are each a complete file, kept on the
 * device (IndexedDB, a database of its own) until the server has taken them, so a lost
 * connection loses nothing. The server decides whether an interview is recorded at all.
 */

export const SEGMENT_MS = 30_000;
/** About 11 MB an hour in mono Opus. */
const BITS_PER_SECOND = 24_000;

export interface Segment {
  interviewId: string;
  n: number;
  blob: Blob;
  durationMs: number;
}
export interface AudioMeta {
  decided: boolean;
  granted: boolean;
  /** The number of the next segment to record. */
  next: number;
}

/** Where segments wait; IndexedDB in the browser, memory in tests. */
export interface SegmentStore {
  put(s: Segment): Promise<void>;
  remove(interviewId: string, n: number): Promise<void>;
  list(interviewId: string): Promise<Segment[]>;
  meta(interviewId: string): Promise<AudioMeta>;
  setMeta(interviewId: string, patch: Partial<AudioMeta>): Promise<void>;
}

export class MemorySegmentStore implements SegmentStore {
  private readonly segs = new Map<string, Segment>();
  private readonly metas = new Map<string, AudioMeta>();
  async put(s: Segment) {
    this.segs.set(`${s.interviewId}/${s.n}`, s);
  }
  async remove(interviewId: string, n: number) {
    this.segs.delete(`${interviewId}/${n}`);
  }
  async list(interviewId: string) {
    return [...this.segs.values()]
      .filter((s) => s.interviewId === interviewId)
      .sort((a, b) => a.n - b.n);
  }
  async meta(interviewId: string) {
    return this.metas.get(interviewId) ?? { decided: false, granted: false, next: 0 };
  }
  async setMeta(interviewId: string, patch: Partial<AudioMeta>) {
    this.metas.set(interviewId, { ...(await this.meta(interviewId)), ...patch });
  }
}

const DB = 'ws-audio';

/** IndexedDB behind the store: its own database, so the interview store's schema is untouched. */
export class IdbSegmentStore implements SegmentStore {
  private db?: Promise<IDBDatabase>;
  private open() {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('segments', { keyPath: ['interviewId', 'n'] });
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  private async run<T>(
    store: 'segments' | 'meta',
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async put(s: Segment) {
    await this.run('segments', 'readwrite', (o) => o.put(s));
  }
  async remove(interviewId: string, n: number) {
    await this.run('segments', 'readwrite', (o) => o.delete([interviewId, n]));
  }
  async list(interviewId: string) {
    const all = await this.run<Segment[]>('segments', 'readonly', (o) => o.getAll());
    return all.filter((s) => s.interviewId === interviewId).sort((a, b) => a.n - b.n);
  }
  async meta(interviewId: string) {
    const m = await this.run<AudioMeta | undefined>('meta', 'readonly', (o) => o.get(interviewId));
    return m ?? { decided: false, granted: false, next: 0 };
  }
  async setMeta(interviewId: string, patch: Partial<AudioMeta>) {
    const next = { ...(await this.meta(interviewId)), ...patch };
    await this.run('meta', 'readwrite', (o) => o.put(next, interviewId));
  }
}

/**
 * Whether an interview is drawn for recording, as the server draws it (the first four bytes of
 * the SHA-256 of the interview's id, modulo 100, against the share): used for interviews
 * started on the device with no connection. The server checks the same on every upload.
 */
export async function drawnLocally(interviewId: string, samplePercent: number): Promise<boolean> {
  if (samplePercent <= 0) return false;
  if (samplePercent >= 100) return true;
  const d = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(interviewId)),
  );
  const n = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
  return n % 100 < samplePercent;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type PutSegment = (s: Segment, sha256: string) => Promise<{ status: number; code?: string }>;

/** One PUT to the server, as the browser sends it. */
export const putSegment: PutSegment = async (s, sha256) => {
  const csrf = readCookie('ws_csrf');
  const res = await fetch(`/api/v1/interviews/${s.interviewId}/audio/${s.n}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'content-type': s.blob.type.split(';')[0] || 'audio/webm',
      'x-sha256': sha256,
      'x-duration-ms': String(Math.round(s.durationMs)),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: s.blob,
  });
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, code: body.code };
};

/**
 * Sends the waiting segments in order. A segment the server took, or already has, is dropped from
 * the device; one it will never take (not recorded, too large, not ours) is dropped too; one it
 * is not ready for (consent not synced yet, no connection, server trouble) stays, and the run
 * stops there so the order is kept. Returns how many are left.
 */
export async function flushSegments(
  store: SegmentStore,
  interviewId: string,
  put: PutSegment = putSegment,
  hash: (b: Blob) => Promise<string> = sha256Hex,
): Promise<number> {
  const waiting = await store.list(interviewId);
  for (const s of waiting) {
    let res: { status: number; code?: string };
    try {
      res = await put(s, await hash(s.blob));
    } catch {
      return waiting.length;
    }
    const wait =
      res.status === 0 ||
      res.status === 401 ||
      res.status === 408 ||
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 409 && res.code === 'CONSENT_REQUIRED');
    if (wait) break;
    // 2xx: taken. 409 SEGMENT_EXISTS: the server holds it. Other 4xx: it will never be taken.
    await store.remove(interviewId, s.n);
  }
  return (await store.list(interviewId)).length;
}

/** The type the browser records, Opus in WebM or AAC in MP4 (Safari), or null when it cannot. */
export function recorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

/**
 * Records the microphone in segments, each a file of its own (the recorder is restarted every
 * 30 seconds), and hands each to the store. `stop()` waits for the last one to be saved.
 */
export class SegmentRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private startedAt = 0;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly interviewId: string,
    private readonly store: SegmentStore,
    private readonly onSaved: () => void = () => undefined,
    private readonly segmentMs = SEGMENT_MS,
  ) {}

  get active() {
    return this.running;
  }

  async start(): Promise<boolean> {
    const mime = recorderMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      return false;
    }
    this.running = true;
    this.begin(mime);
    return true;
  }

  private begin(mime: string) {
    if (!this.running || !this.stream) return;
    const rec = new MediaRecorder(this.stream, {
      mimeType: mime,
      audioBitsPerSecond: BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    this.startedAt = Date.now();
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const durationMs = Date.now() - this.startedAt;
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      if (blob.size)
        this.saving = this.saving.then(async () => {
          const meta = await this.store.meta(this.interviewId);
          await this.store.put({ interviewId: this.interviewId, n: meta.next, blob, durationMs });
          await this.store.setMeta(this.interviewId, { next: meta.next + 1 });
          this.onSaved();
        });
      this.begin(mime);
    };
    this.recorder = rec;
    rec.start();
    this.timer = setTimeout(() => rec.state === 'recording' && rec.stop(), this.segmentMs);
  }

  /** Stops the microphone and waits until what was recorded is on the device. */
  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>((done) => {
        const prev = rec.onstop;
        rec.onstop = (ev) => {
          (prev as ((e: Event) => void) | null)?.call(rec, ev);
          done();
        };
        rec.stop();
      });
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    await this.saving;
  }
}
