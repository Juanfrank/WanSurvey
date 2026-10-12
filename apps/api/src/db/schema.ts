import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/** UUIDv7: time-sortable and safe to generate offline on devices. */
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const tenantId = () => uuid('tenant_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    name: text('name').notNull(),
    /** Short code typed at login, e.g. "acme-research". */
    slug: text('slug').notNull(),
    plan: text('plan').notNull().default('trial'),
    settings: jsonb('settings').notNull().default({}),
    branding: jsonb('branding').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tenants_slug_uq').on(t.slug)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    firstName: text('first_name'),
    phone: text('phone'),
    /** Interviewer profile fields, available to piping and metrics. */
    idCode: text('id_code'),
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    phoneExtension: text('phone_extension'),
    /** invited | active | deactivated */
    status: text('status').notNull().default('invited'),
    passwordHash: text('password_hash'),
    /** AES-256-GCM encrypted TOTP secret. */
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    createdAt: createdAt(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_tenant_email_uq').on(t.tenantId, sql`lower(${t.email})`)],
);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    /** draft | active | closed | archived */
    status: text('status').notNull().default('draft'),
    modesEnabled: text('modes_enabled')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    timezone: text('timezone').notNull().default('UTC'),
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{en}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('projects_tenant_code_uq').on(t.tenantId, t.code)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    /** Null = role applies tenant-wide; set = role narrowed to one project. */
    projectId: uuid('project_id').references(() => projects.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('memberships_user_idx').on(t.userId),
    uniqueIndex('memberships_scope_uq').on(
      t.userId,
      sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    csrfToken: text('csrf_token').notNull(),
    /** ok | pending (TOTP code needed) | enroll (TOTP enrolment required) */
    mfaState: text('mfa_state').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sessions_token_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** Single-use, hashed tokens for invitations and password resets. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** invitation | password_reset */
    purpose: text('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('user_tokens_hash_uq').on(t.tokenHash)],
);

/** Immutable audit trail (UPDATE/DELETE are blocked by trigger and privileges). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    details: jsonb('details').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_tenant_at_idx').on(t.tenantId, t.at),
    index('audit_action_idx').on(t.tenantId, t.action),
  ],
);

/** Tables protected by tenant row-level security. */
export const TENANT_TABLES = [
  'users',
  'projects',
  'memberships',
  'sessions',
  'user_tokens',
  'audit_log',
] as const;
