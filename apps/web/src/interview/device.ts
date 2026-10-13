import { api, ApiError } from '../api.js';
import { InterviewStore, type DeviceCase } from './store.js';
import { Syncer } from './sync.js';

interface CheckoutResponse {
  project: { id: string; name: string };
  settings: { capi: DeviceCase['capi']; shortcuts?: DeviceCase['shortcuts'] };
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
        const local = await store.get(c.interview.id);
        if (!local || local.seq < c.lastSeq)
          await store.adopt(c.interview.id, {
            seq: c.lastSeq,
            acked: c.lastSeq,
            state: c.interview.state,
            position: null,
            activeMs: c.interview.activeMs,
            totalMs: c.interview.totalMs,
          });
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
      });
    }
    return { downloaded: r.cases.length, refused: r.refused };
  });
}

/** Starts an interview on a downloaded case, on the device only; it reaches the server on sync (D2). */
export function startOnDevice(caseId: string) {
  return withStore(async (store) => {
    const c = await store.getCase(caseId);
    if (!c) throw new Error('This case is not on this device');
    if (c.interviewId) return c.interviewId;
    const v = await store.getVersion(c.questionnaireVersionId);
    if (!v) throw new Error('The questionnaire is not on this device');
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
    const waiting = locals.filter(
      (l) => l.meta?.projectId === projectId && (l.seq > l.acked || l.start || l.submit),
    ).length;
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
