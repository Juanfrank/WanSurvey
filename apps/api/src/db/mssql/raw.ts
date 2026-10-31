import { sql } from 'kysely';
import { createMssqlDb } from './connection.js';

/**
 * Plain SQL with `?` placeholders on an owner connection, for the browser tests' setup and
 * checks (`apps/web/e2e/db.ts`). Not used by the application.
 */
export function openRaw(url: string) {
  const db = createMssqlDb<Record<string, never>>(url, { max: 1 });
  return {
    async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      const parts = text.split('?');
      if (parts.length - 1 !== params.length) throw new Error('placeholders and values differ');
      let q = sql.raw(parts[0]!);
      for (const [i, p] of params.entries()) q = sql`${q}${p as string}${sql.raw(parts[i + 1]!)}`;
      const res = (await q.execute(db)) as { rows?: Record<string, unknown>[] };
      return res.rows ?? [];
    },
    end: () => db.destroy(),
  };
}
