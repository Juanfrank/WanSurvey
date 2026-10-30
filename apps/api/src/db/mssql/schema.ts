import type { ColumnType, Generated } from 'kysely';

/** When a column is read, and what it takes when written (datetimeoffset comes back as a Date). */
type Instant = ColumnType<Date, Date | string | undefined, Date | string>;
/** JSON kept as text (ISJSON-checked), as the driver returns it. */
type JsonText = ColumnType<string, string | undefined, string>;

/**
 * The tables made so far on SQL Server (mssql/0000, 0001). The rest follows as each part of
 * the app moves; until then it runs on PostgreSQL with Drizzle (src/db/schema.ts).
 */
export interface MssqlSchema {
  tenants: {
    id: string;
    name: string;
    slug: string;
    plan: Generated<string>;
    settings: JsonText;
    branding: JsonText;
    created_at: Generated<Instant>;
  };
  users: {
    id: string;
    tenant_id: string;
    email: string;
    name: string;
    status: Generated<string>;
    password_hash: string | null;
    totp_enabled: Generated<boolean>;
    created_at: Generated<Instant>;
  };
  projects: {
    id: string;
    tenant_id: string;
    name: string;
    code: string;
    status: Generated<string>;
    modes_enabled: JsonText;
    timezone: Generated<string>;
    languages: JsonText;
    created_at: Generated<Instant>;
  };
  audit_log: {
    id: string;
    tenant_id: string;
    actor_user_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    details: JsonText;
    at: Generated<Instant>;
  };
}
