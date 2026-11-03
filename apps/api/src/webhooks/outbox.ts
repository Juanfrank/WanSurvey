import { randomUUID } from 'node:crypto';
import type { MssqlTx } from '../db/mssql/database.js';
import { enqueuePush } from '../push/outbox.js';

/**
 * The events a webhook can subscribe to (ADR 0001). They are written to the outbox in the
 * transaction of the change itself, so an event exists exactly when the change does.
 */
export const WEBHOOK_EVENTS = [
  'interview.submitted',
  'interview.status_changed',
  'case.status_changed',
  'export.ready',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Which audit entries are which event. */
const FROM_AUDIT: Record<string, { event: WebhookEvent; status?: string }> = {
  'interview.submitted': { event: 'interview.submitted' },
  'interview.reviewed': { event: 'interview.status_changed', status: 'in_review' },
  'interview.approved': { event: 'interview.status_changed', status: 'approved' },
  'interview.returned': { event: 'interview.status_changed', status: 'returned' },
  'interview.rejected': { event: 'interview.status_changed', status: 'rejected' },
  'case.claimed': { event: 'case.status_changed' },
  'case.released': { event: 'case.status_changed' },
  'case.updated': { event: 'case.status_changed' },
};

const low = (v: string | null | undefined) => (v ? v.toLowerCase() : null);

/** Writes a delivery for each endpoint of the organisation that listens to the event. */
export async function enqueueEvent(
  tx: MssqlTx,
  tenantId: string,
  event: WebhookEvent,
  projectId: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await tx
    .selectFrom('webhook_endpoints')
    .select(['id', 'project_id', 'events'])
    .where('enabled', '=', true)
    .execute();
  const targets = endpoints.filter(
    (e) =>
      (JSON.parse(e.events) as string[]).includes(event) &&
      (!e.project_id || e.project_id.toLowerCase() === projectId),
  );
  if (!targets.length) return;
  const eventId = randomUUID();
  const payload = JSON.stringify({
    id: `evt_${eventId}`,
    type: event,
    createdAt: new Date().toISOString(),
    data: { ...data, projectId },
  });
  await tx
    .insertInto('webhook_deliveries')
    .values(
      targets.map((e) => ({
        id: randomUUID(),
        tenant_id: tenantId,
        endpoint_id: e.id,
        event_id: eventId,
        event,
        payload,
      })),
    )
    .execute();
}

/** Called for every audit entry: the ones that are events become deliveries. */
export async function enqueueFromAudit(
  tx: MssqlTx,
  tenantId: string,
  entry: { action: string; targetId?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  await pushFromAudit(tx, tenantId, entry);
  const map = FROM_AUDIT[entry.action];
  if (!map || !entry.targetId) return;
  // Identifiers and statuses only; never names, answers or contact data.
  if (map.event === 'case.status_changed') {
    const c = await tx
      .selectFrom('cases')
      .select(['project_id', 'status'])
      .where('id', '=', entry.targetId)
      .executeTakeFirst();
    if (!c) return;
    await enqueueEvent(tx, tenantId, map.event, low(c.project_id), {
      caseId: entry.targetId.toLowerCase(),
      status: c.status,
    });
    return;
  }
  const i = await tx
    .selectFrom('interviews')
    .select(['project_id', 'case_id', 'status'])
    .where('id', '=', entry.targetId)
    .executeTakeFirst();
  if (!i) return;
  await enqueueEvent(tx, tenantId, map.event, low(i.project_id), {
    interviewId: entry.targetId.toLowerCase(),
    caseId: low(i.case_id),
    status: map.status ?? i.status,
  });
}

/** Notifications to people (web push) that follow from the same entries. */
async function pushFromAudit(
  tx: MssqlTx,
  tenantId: string,
  entry: { action: string; targetId?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  if (entry.action === 'interview.returned' && entry.targetId) {
    const i = await tx
      .selectFrom('interviews')
      .select(['interviewer_id'])
      .where('id', '=', entry.targetId)
      .executeTakeFirst();
    if (i?.interviewer_id)
      await enqueuePush(tx, tenantId, i.interviewer_id, 'returned', { url: '/' }, undefined);
  }
  if (entry.action === 'cases.assigned') {
    const d = entry.details ?? {};
    const people: [string, number][] = d.perPerson
      ? Object.entries(d.perPerson as Record<string, number>)
      : typeof d.to === 'string'
        ? [[d.to, Number(d.count ?? 1)]]
        : [];
    for (const [userId, count] of people)
      if (count > 0) await enqueuePush(tx, tenantId, userId, 'assignments', { count, url: '/' });
  }
}
