import { randomUUID } from 'node:crypto';
import type { MssqlTx } from '../db/mssql/database.js';

/** What a person can ask to be told about. */
export const PUSH_CATEGORIES = ['callbacks', 'assignments', 'returned', 'exports'] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/**
 * Queues a notification for a person, in the transaction of the change that caused it, when
 * they have a browser subscribed to that category (the others cost nothing). The text is made
 * when it is sent, from the category and the count: it holds no names or answers.
 */
export async function enqueuePush(
  tx: MssqlTx,
  tenantId: string,
  userId: string,
  category: PushCategory,
  data: { count?: number; url: string },
  dedupeKey?: string,
): Promise<boolean> {
  const subs = await tx
    .selectFrom('push_subscriptions')
    .select(['categories'])
    .where('user_id', '=', userId)
    .execute();
  if (!subs.some((s) => (JSON.parse(s.categories) as string[]).includes(category))) return false;
  try {
    await tx
      .insertInto('push_outbox')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        user_id: userId,
        category,
        payload: JSON.stringify(data),
        dedupe_key: dedupeKey ?? null,
        next_attempt_at: new Date(),
      })
      .execute();
  } catch (e) {
    // The same notification already waits (a unique key): nothing to add.
    if (dedupeKey && /2601|2627|duplicate key/i.test(String((e as Error).message))) return false;
    throw e;
  }
  return true;
}
