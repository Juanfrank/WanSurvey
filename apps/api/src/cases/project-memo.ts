import type { Tx } from '../db/database.js';
import type { projects } from '../db/schema.js';

export type ProjectRow = typeof projects.$inferSelect;

/**
 * Project rows a transaction has already read, so the rest of the request does not read them
 * again (its settings, its time zone in a submission's hooks). Only filled on purpose, by the
 * respondent requests that read the project together with the link (`remember`); a
 * transaction that changes a project never fills it, so nothing stale is served.
 */
const memo = new WeakMap<object, Map<string, ProjectRow>>();

export function rememberProject(tx: Tx, row: ProjectRow) {
  let m = memo.get(tx);
  if (!m) memo.set(tx, (m = new Map()));
  m.set(row.id, row);
}

export function rememberedProject(tx: Tx, projectId: string): ProjectRow | undefined {
  return memo.get(tx)?.get(projectId);
}
