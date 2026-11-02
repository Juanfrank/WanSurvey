import { z } from 'zod';

/**
 * What a key of the integration API may read (ADR 0001, decision 3, phase A). Personal data never
 * leaves through a key: personal sample fields are masked, and interviews come without answers.
 */
export const API_KEY_SCOPES = [
  'projects:read',
  'cases:read',
  'interviews:read',
  'audit:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);

/** A key lasts at most this long: a leaked key stops working by itself. */
export const API_KEY_MAX_DAYS = 366;

export const ApiKeyBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  projectId: z.uuid().nullable().default(null),
  expiresAt: z.coerce.date(),
  /** Addresses or CIDR ranges the key may be used from; empty: anywhere. */
  allowedIps: z.array(z.string().trim().min(3).max(64)).max(50).default([]),
});
export type ApiKeyBody = z.infer<typeof ApiKeyBody>;
