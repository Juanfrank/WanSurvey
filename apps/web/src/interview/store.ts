import type { ShortcutSettings } from '@wansurvey/schema';
/**
 * The interview's copy on this device (IndexedDB): the engine snapshot and an outbox of
 * numbered changes waiting for the server. Every change is written here before the screen
 * says it is saved, so closing the tab or losing the connection never loses an answer.
 */

export type Op =
  | {
      seq: number;
      kind: 'answer';
      variable: string;
      oldValue: unknown;
      newValue: unknown;
      at: string;
      source: string;
      reason: string | null;
    }
  | {
      seq: number;
      kind: 'paradata';
      type: string;
      at: string;
      monotonicMs?: number;
      payload: Record<string, unknown>;
    };

/** An op before it gets its number. */
export type NewOp = Op extends infer O ? (O extends Op ? Omit<O, 'seq'> : never) : never;

/** How an interview started on this device without the server: sent with its first sync. */
export interface OfflineStart {
  caseId: string;
  questionnaireVersionId: string;
  mode: 'CAPI';
  language: string;
  startedAt: string;
}

/** What is needed to open an interview with no connection. */
export interface InterviewMeta {
  projectId: string;
  caseId: string;
  externalId: string;
  questionnaireVersionId: string;
  mode: string;
  language: string;
  startedAt: string;
  context: Record<string, unknown>;
}

/** A submission waiting for the connection: sent once everything is acknowledged. */
export interface PendingSubmit {
  seq: number;
  path: string[];
}

/** A compiled questionnaire version kept on the device. */
export interface DeviceVersion {
  id: string;
  version: number;
  compiled: unknown;
}

/** A case downloaded to this device. */
export interface DeviceCase {
  caseId: string;
  projectId: string;
  projectName: string;
  externalId: string;
  context: Record<string, unknown>;
  questionnaireVersionId: string;
  interviewId: string | null;
  /** ready: not started; started; queued: submitted, waiting to be sent; done. */
  status: 'ready' | 'started' | 'queued' | 'done';
  disposition: string | null;
  problem: string | null;
  downloadedAt: string;
  capi: { gps: 'off' | 'start_end'; gpsNotice: string };
  /** The project's keyboard shortcuts, kept for interviews started offline. */
  shortcuts?: ShortcutSettings;
}

export interface LocalInterview {
  id: string;
  /** The last change number given out on this device. */
  seq: number;
  /** The last change number the server acknowledged. */
  acked: number;
  state: unknown;
  position: string | null;
  activeMs: number;
  totalMs: number;
  updatedAt: string;
  meta?: InterviewMeta;
  start?: OfflineStart;
  submit?: PendingSubmit;
}

const DB = 'wansurvey';
const VERSION = 2;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class InterviewStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB): Promise<InterviewStore> {
    if (typeof indexedDB === 'undefined') throw new Error('This browser cannot store data offline');
    const open = indexedDB.open(name, VERSION);
    open.onupgradeneeded = (e) => {
      const db = open.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('meta');
        db.createObjectStore('interviews', { keyPath: 'id' });
        db.createObjectStore('outbox', { keyPath: ['interviewId', 'seq'] });
      }
      if (e.oldVersion < 2) {
        // Offline work (slice 8): compiled versions and downloaded cases.
        db.createObjectStore('versions', { keyPath: 'id' });
        db.createObjectStore('cases', { keyPath: 'caseId' }).createIndex('project', 'projectId');
      }
    };
    return new InterviewStore(await req(open));
  }

  close() {
    this.db.close();
  }

  /** This device's id, created once. */
  async deviceId(): Promise<string> {
    const tx = this.db.transaction('meta', 'readwrite');
    const meta = tx.objectStore('meta');
    let id = (await req(meta.get('deviceId'))) as string | undefined;
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      meta.put(id, 'deviceId');
    }
    await done(tx);
    return id;
  }

  async get(id: string): Promise<LocalInterview | null> {
    const tx = this.db.transaction('interviews', 'readonly');
    return (
      ((await req(tx.objectStore('interviews').get(id))) as LocalInterview | undefined) ?? null
    );
  }

  /** Starts (or re-aligns) the local copy with what the server has acknowledged. */
  async adopt(id: string, base: Omit<LocalInterview, 'id' | 'updatedAt'>): Promise<void> {
    const tx = this.db.transaction('interviews', 'readwrite');
    const store = tx.objectStore('interviews');
    const cur = (await req(store.get(id))) as LocalInterview | undefined;
    store.put({
      ...(cur?.meta ? { meta: cur.meta } : {}),
      id,
      ...base,
      updatedAt: new Date().toISOString(),
    });
    await done(tx);
  }

  /** Changes fields of the local copy (start sent, submission queued…). */
  async patch(id: string, fields: Partial<Omit<LocalInterview, 'id'>>): Promise<void> {
    const tx = this.db.transaction('interviews', 'readwrite');
    const store = tx.objectStore('interviews');
    const cur = (await req(store.get(id))) as LocalInterview | undefined;
    if (cur) {
      const next: Record<string, unknown> = { ...cur, ...fields };
      for (const [k, v] of Object.entries(fields)) if (v === undefined) delete next[k];
      store.put(next);
    }
    await done(tx);
  }

  async all(): Promise<LocalInterview[]> {
    const tx = this.db.transaction('interviews', 'readonly');
    return (await req(tx.objectStore('interviews').getAll())) as LocalInterview[];
  }

  async putVersion(v: DeviceVersion): Promise<void> {
    const tx = this.db.transaction('versions', 'readwrite');
    tx.objectStore('versions').put(v);
    await done(tx);
  }

  async getVersion(id: string): Promise<DeviceVersion | null> {
    const tx = this.db.transaction('versions', 'readonly');
    return ((await req(tx.objectStore('versions').get(id))) as DeviceVersion | undefined) ?? null;
  }

  async putCase(c: DeviceCase): Promise<void> {
    const tx = this.db.transaction('cases', 'readwrite');
    tx.objectStore('cases').put(c);
    await done(tx);
  }

  async getCase(id: string): Promise<DeviceCase | null> {
    const tx = this.db.transaction('cases', 'readonly');
    return ((await req(tx.objectStore('cases').get(id))) as DeviceCase | undefined) ?? null;
  }

  async patchCase(id: string, fields: Partial<DeviceCase>): Promise<void> {
    const tx = this.db.transaction('cases', 'readwrite');
    const store = tx.objectStore('cases');
    const cur = (await req(store.get(id))) as DeviceCase | undefined;
    if (cur) store.put({ ...cur, ...fields });
    await done(tx);
  }

  async cases(projectId: string): Promise<DeviceCase[]> {
    const tx = this.db.transaction('cases', 'readonly');
    const rows = (await req(
      tx.objectStore('cases').index('project').getAll(projectId),
    )) as DeviceCase[];
    return rows.sort((a, b) => a.externalId.localeCompare(b.externalId));
  }

  async removeCase(id: string): Promise<void> {
    const tx = this.db.transaction('cases', 'readwrite');
    tx.objectStore('cases').delete(id);
    await done(tx);
  }

  /** The device's meta values (last sync time…). */
  async getMeta<T>(key: string): Promise<T | null> {
    const tx = this.db.transaction('meta', 'readonly');
    return ((await req(tx.objectStore('meta').get(key))) as T | undefined) ?? null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }

  /**
   * Numbers the new ops, adds them to the outbox and stores the snapshot, in one transaction.
   * Resolves to the last number given out.
   */
  async record(
    id: string,
    ops: NewOp[],
    snapshot: Pick<LocalInterview, 'state' | 'position' | 'activeMs' | 'totalMs'>,
  ): Promise<number> {
    const tx = this.db.transaction(['interviews', 'outbox'], 'readwrite');
    const store = tx.objectStore('interviews');
    const cur = ((await req(store.get(id))) as LocalInterview | undefined) ?? {
      id,
      seq: 0,
      acked: 0,
      state: null,
      position: null,
      activeMs: 0,
      totalMs: 0,
      updatedAt: '',
    };
    let seq = cur.seq;
    const outbox = tx.objectStore('outbox');
    for (const op of ops) outbox.put({ ...op, seq: ++seq, interviewId: id });
    store.put({ ...cur, ...snapshot, seq, updatedAt: new Date().toISOString() });
    await done(tx);
    return seq;
  }

  /** Changes not yet acknowledged, oldest first. */
  async pending(id: string, limit = 500): Promise<Op[]> {
    const tx = this.db.transaction('outbox', 'readonly');
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    const rows = (await req(tx.objectStore('outbox').getAll(range, limit))) as (Op & {
      interviewId?: string;
    })[];
    return rows.map(({ interviewId: _i, ...op }) => op as Op);
  }

  /** The server has everything up to `upto`: drop it from the outbox. */
  async acknowledge(id: string, upto: number): Promise<void> {
    const tx = this.db.transaction(['interviews', 'outbox'], 'readwrite');
    tx.objectStore('outbox').delete(IDBKeyRange.bound([id, 0], [id, upto]));
    const store = tx.objectStore('interviews');
    const cur = (await req(store.get(id))) as LocalInterview | undefined;
    if (cur && upto > cur.acked) store.put({ ...cur, acked: upto });
    await done(tx);
  }

  /** Interviews with changes still to send (or not yet created on the server). */
  async unsynced(): Promise<string[]> {
    const tx = this.db.transaction('interviews', 'readonly');
    const all = (await req(tx.objectStore('interviews').getAll())) as LocalInterview[];
    return all.filter((i) => i.seq > i.acked || i.start).map((i) => i.id);
  }

  /** Forgets a submitted interview. */
  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(['interviews', 'outbox'], 'readwrite');
    tx.objectStore('interviews').delete(id);
    tx.objectStore('outbox').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done(tx);
  }
}

/** Warns when the browser leaves less than 50 MB for this site. */
export async function lowOnSpace(): Promise<boolean> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e?.quota || e.usage === undefined) return false;
    return e.quota - e.usage < 50 * 1024 * 1024;
  } catch {
    return false;
  }
}
