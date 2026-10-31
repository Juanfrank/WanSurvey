import { ServiceUnavailableException } from '@nestjs/common';

/** The SQL Server error number of a (possibly wrapped) driver error. */
export function sqlNumber(e: unknown): number | undefined {
  for (let x = e as { number?: unknown; cause?: unknown } | undefined, i = 0; x && i < 4; i++) {
    if (typeof x.number === 'number') return x.number;
    x = x.cause as typeof x;
  }
  return undefined;
}

/** A unique index refused a row (a race to create the same thing): SQL Server 2601 or 2627. */
export function isUniqueViolation(e: unknown): boolean {
  const n = sqlNumber(e);
  return n === 2601 || n === 2627;
}

/**
 * Errors worth trying again later: a deadlock, a lock that did not free in time, and what Azure SQL
 * answers while it moves a database or limits a resource (learn.microsoft.com, "transient faults").
 */
const TRANSIENT_NUMBERS = new Set([
  1205, 1222, 4060, 10928, 10929, 40197, 40501, 40613, 49918, 49919, 49920,
]);
/** The database cannot be reached now (failover, restart, no free connection). */
const DRIVER_UNAVAILABLE = new Set([
  'ESOCKET',
  'ETIMEOUT',
  'ECONNCLOSED',
  'ELOGIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/** An error worth trying again later: busy, unreachable, or a 503 made from one. */
export function isTransient(e: unknown): boolean {
  const n = sqlNumber(e);
  if (n !== undefined && TRANSIENT_NUMBERS.has(n)) return true;
  for (let x = e as { code?: unknown; cause?: unknown } | undefined, i = 0; x && i < 4; i++) {
    if (typeof x.code === 'string' && DRIVER_UNAVAILABLE.has(x.code)) return true;
    x = x.cause as typeof x;
  }
  return e instanceof ServiceUnavailableException;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export interface AuthUserRow {
  id: string;
  passwordHash: string | null;
  status: string;
  totpEnabled: boolean;
  lastTenantId: string | null;
}

export interface SsoPublicConfig {
  tenantId: string;
  slug: string;
  entraTenantId: string;
  clientId: string;
  enabled: boolean;
}

export interface UserTenant {
  id: string;
  slug: string;
  name: string;
  memberStatus: string;
}

/** The lookups that run before any organisation is known, through owner procedures. */
export type PublicLookup = 'invitation_by_token' | 'open_link_by_slug' | 'feedback_point_by_slug';
