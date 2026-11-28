import { api, ApiError } from '../api.js';
import {
  alignCopy,
  InterviewStore,
  type DeviceCase,
  DeviceError,
  hasUnsent,
  keepStorage,
  serverCopy,
} from './store.js';
import { Syncer } from './sync.js';

interface CheckoutResponse {
  project: { id: string; name: string };
  settings: {
    capi: DeviceCase['capi'];
    shortcuts?: DeviceCase['shortcuts'];
    audio?: DeviceCase['audio'];
  };
  versions: { id: string; version: number; compiled: unknown }[];
  cases: {
    caseId: string;
    externalId: string;
    context: Record<string, unknown>;
    questionnaireVersionId: string;
    interview: {
      id: string;
      mode: string;
      language: string;
      startedAt: string;
      state: unknown;
      stateVersion?: number;
      ownState?: boolean;
      activeMs: number;
      totalMs: number;
    } | null;
    lastSeq: number;
  }[];
  refused: { caseId: string; code: string }[];
  serverTime: string;
}

/** A connection problem rather than an answer from the server. */
export const isOffline = (e: unknown) =>
  !(e instanceof ApiError) || (typeof navigator !== 'undefined' && navigator.onLine === false);

async function withStore<T>(fn: (store: InterviewStore) => Promise<T>): Promise<T> {
  const store = await InterviewStore.open();
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * Downloads cases to this device (D1): versions, case data and any interview in progress,
 * so they can be interviewed with no connection.
 */
export function downloadCases(projectId: string, caseIds: string[]) {
  return withStore(async (store) => {
    // Cases on the device must not be evicted before they are interviewed and synced.
    await keepStorage();
    const deviceId = await store.deviceId();
    const r = await api<CheckoutResponse>(`/projects/${projectId}/capi/checkout`, {
      method: 'POST',
      body: { deviceId, caseIds },
    });
    for (const v of r.versions) await store.putVersion(v);
    const now = new Date().toISOString();
    for (const c of r.cases) {
      const existing = await store.getCase(c.caseId);
      if (c.interview) {
        await alignCopy(store, serverCopy({ interview: c.interview, lastSeq: c.lastSeq }));
        await store.patch(c.interview.id, {
          meta: {
            projectId,
            caseId: c.caseId,
            externalId: c.externalId,
            questionnaireVersionId: c.questionnaireVersionId,
            mode: c.interview.mode,
            language: c.interview.language,
            startedAt: c.interview.startedAt,
            context: c.context,
          },
        });
      }
      await store.putCase({
        caseId: c.caseId,
        projectId,
        projectName: r.project.name,
        externalId: c.externalId,
        context: c.context,
        questionnaireVersionId: c.questionnaireVersionId,
        interviewId: c.interview?.id ?? existing?.interviewId ?? null,
        status: c.interview ? 'started' : (existing?.status ?? 'ready'),
        disposition: null,
        problem: null,
        downloadedAt: existing?.downloadedAt ?? now,
        capi: r.settings.capi,
        ...(r.settings.shortcuts ? { shortcuts: r.settings.shortcuts } : {}),
        ...(r.settings.audio ? { audio: r.settings.audio } : {}),
      });
    }
    return { downloaded: r.cases.length, refused: r.refused };
  });
}

/** Starts an interview on a downloaded case, on the device only; it reaches the server on sync (D2). */
export function startOnDevice(caseId: string) {
  return withStore(async (store) => {
    const c = await store.getCase(caseId);
    if (!c) throw new DeviceError('CASE_NOT_ON_DEVICE', 'This case is not on this device');
    if (c.interviewId) return c.interviewId;
    const v = await store.getVersion(c.questionnaireVersionId);
    if (!v)
      throw new DeviceError('VERSION_NOT_ON_DEVICE', 'The questionnaire is not on this device');
    const compiled = v.compiled as { questionnaire: { defaultLanguage: string } };
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const language = compiled.questionnaire.defaultLanguage;
    await store.adopt(id, {
      seq: 0,
      acked: 0,
      state: null,
      position: null,
      activeMs: 0,
      totalMs: 0,
    });
    await store.patch(id, {
      meta: {
        projectId: c.projectId,
        caseId,
        externalId: c.externalId,
        questionnaireVersionId: c.questionnaireVersionId,
        mode: 'CAPI',
        language,
        startedAt,
        context: c.context,
      },
      start: {
        caseId,
        questionnaireVersionId: c.questionnaireVersionId,
        mode: 'CAPI',
        language,
        startedAt,
      },
    });
    await store.patchCase(caseId, { interviewId: id, status: 'started' });
    return id;
  });
}

export interface SyncReport {
  sent: number;
  submitted: number;
  checkedIn: number;
  problems: Record<string, string>;
  at: string;
}

/**
 * Sends everything this device holds: changes (creating offline interviews), then queued
 * submissions; finished cases are checked in and leave the device.
 */
export function syncDevice(projectId: string): Promise<SyncReport> {
  return withStore(async (store) => {
    const deviceId = await store.deviceId();
    const syncer = new Syncer(store, deviceId);
    const report: SyncReport = {
      sent: 0,
      submitted: 0,
      checkedIn: 0,
      problems: {},
      at: new Date().toISOString(),
    };
    const ids = await store.unsynced();
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const res = await syncer.flush(part, { force: true });
      report.sent += Object.keys(res?.acks ?? {}).length;
      Object.assign(report.problems, res?.errors ?? {});
    }
    const cases = await store.cases(projectId);
    for (const local of await store.all()) {
      if (!local.submit || local.start || local.seq > local.acked) continue;
      const c = cases.find((x) => x.interviewId === local.id);
      try {
        const r = await api<{ disposition: string }>(`/interviews/${local.id}/submit`, {
          method: 'POST',
          body: { deviceId, seq: local.submit.seq, path: local.submit.path },
        });
        await store.remove(local.id);
        if (c) await store.patchCase(c.caseId, { status: 'done', disposition: r.disposition });
        report.submitted++;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'SUBMITTED') {
          await store.remove(local.id);
          if (c) await store.patchCase(c.caseId, { status: 'done' });
        } else if (e instanceof ApiError) {
          report.problems[local.id] = e.code ?? String(e.status);
          if (c) await store.patchCase(c.caseId, { problem: e.code ?? String(e.status) });
        } else throw e;
      }
    }
    const done = (await store.cases(projectId)).filter((c) => c.status === 'done');
    if (done.length) {
      await api(`/projects/${projectId}/capi/checkin`, {
        method: 'POST',
        body: { deviceId, caseIds: done.map((c) => c.caseId) },
      });
      for (const c of done) await store.removeCase(c.caseId);
      report.checkedIn = done.length;
    }
    for (const [id, code] of Object.entries(report.problems)) {
      const c = cases.find((x) => x.interviewId === id);
      if (c) await store.patchCase(c.caseId, { problem: code });
    }
    // The server notes this device's synchronisation, for the supervisors' view (169). Only
    // bookkeeping: the work above is done whether or not this last note gets through.
    await api('/interviews/sync', {
      method: 'POST',
      body: { deviceId, projectId, interviews: [] },
    }).catch(() => undefined);
    await store.setMeta(`lastSync:${projectId}`, report.at);
    return report;
  });
}

/** Gives back cases not started on this device. */
export function returnCases(projectId: string, caseIds: string[]) {
  return withStore(async (store) => {
    const deviceId = await store.deviceId();
    await api(`/projects/${projectId}/capi/checkin`, {
      method: 'POST',
      body: { deviceId, caseIds },
    });
    for (const id of caseIds) await store.removeCase(id);
  });
}

/** The device's view of a project: downloaded cases, what waits to be sent, the last sync. */
export function deviceState(projectId: string) {
  return withStore(async (store) => {
    const cases = await store.cases(projectId);
    const locals = await store.all();
    const waiting = locals.filter((l) => l.meta?.projectId === projectId && hasUnsent(l)).length;
    return {
      cases,
      waiting,
      lastSync: await store.getMeta<string>(`lastSync:${projectId}`),
      projectName: cases[0]?.projectName ?? (await store.getMeta<string>(`project:${projectId}`)),
    };
  });
}

export function rememberProject(projectId: string, name: string) {
  return withStore((store) => store.setMeta(`project:${projectId}`, name));
}

/** Notes what the server says of cases on this device (deadline, priority) for offline use. */
export function noteCaseDetails(
  details: { caseId: string; dueAt: string | null; priority: number }[],
) {
  return withStore(async (store) => {
    for (const d of details) {
      const c = await store.getCase(d.caseId);
      if (c && (c.dueAt !== d.dueAt || c.priority !== d.priority))
        await store.patchCase(d.caseId, { dueAt: d.dueAt, priority: d.priority });
    }
  });
}

/**
 * Recording segments waiting for upload (the audio database, `audio.ts`), without creating
 * that database when it does not exist.
 */
function recordingsWaiting(): Promise<number> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(0);
  return new Promise((resolve) => {
    const open = indexedDB.open('ws-audio');
    open.onupgradeneeded = () => open.transaction?.abort();
    open.onerror = () => resolve(0);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('segments')) {
        db.close();
        resolve(0);
        return;
      }
      const count = db.transaction('segments', 'readonly').objectStore('segments').count();
      count.onsuccess = () => {
        db.close();
        resolve(count.result);
      };
      count.onerror = () => {
        db.close();
        resolve(0);
      };
    };
  });
}

/**
 * What this device holds, all projects together: interviews not yet sent, recordings not yet
 * uploaded and cases.
 */
export function deviceSummary() {
  return withStore(async (store) => ({
    unsent: (await store.all()).filter(hasUnsent).length,
    recordings: await recordingsWaiting(),
    cases: (await store.allCases()).length,
  }));
}

/**
 * Gives back every case on this device and forgets the offline data (personal data included).
 * Needs the connection, and nothing unsent: the store refuses to throw an interview away. Cases
 * the server does not release (another person's, say) stay, and the data is then kept.
 */
export function clearDevice() {
  return withStore(async (store) => {
    if ((await store.all()).some(hasUnsent) || (await recordingsWaiting()))
      throw new DeviceError('UNSENT_ON_DEVICE', 'Interviews on this device are not sent yet');
    const deviceId = await store.deviceId();
    const byProject = new Map<string, string[]>();
    for (const c of await store.allCases())
      byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c.caseId]);
    let kept = 0;
    for (const [projectId, caseIds] of byProject) {
      const r = await api<{ checkedIn: string[] }>(`/projects/${projectId}/capi/checkin`, {
        method: 'POST',
        body: { deviceId, caseIds },
      });
      const back = new Set(r.checkedIn);
      // Released cases leave at once, so a later failure leaves no case here the server freed.
      for (const id of caseIds) if (back.has(id)) await store.removeCase(id);
      kept += caseIds.filter((id) => !back.has(id)).length;
    }
    if (kept) throw new DeviceError('CASES_NOT_RETURNED', 'Some cases could not be given back');
    await store.clearAll();
  });
}
