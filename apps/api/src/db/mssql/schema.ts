import type { ColumnType, Generated } from 'kysely';

/** When a column is read, and what it takes when written (datetimeoffset comes back as a Date). */
type Instant = ColumnType<Date, Date | string | undefined, Date | string>;
/** A nullable instant. */
type InstantOrNull = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
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
    created_at: Instant;
  };
  users: {
    id: string;
    tenant_id: string;
    email: string;
    name: string;
    status: Generated<string>;
    password_hash: string | null;
    totp_enabled: Generated<boolean>;
    created_at: Instant;
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
    created_at: Instant;
  };
  audit_log: {
    id: string;
    tenant_id: string;
    actor_user_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    details: JsonText;
    at: Instant;
  };
  questionnaires: {
    id: string;
    tenant_id: string;
    project_id: string;
    name: string;
    draft: JsonText;
    draft_revision: Generated<number>;
    state: Generated<string>;
    state_changed_at: InstantOrNull;
    successor_id: string | null;
    updated_by: string | null;
    updated_at: Instant;
    created_at: Instant;
  };
  questionnaire_versions: {
    id: string;
    tenant_id: string;
    questionnaire_id: string;
    version: number;
    status: Generated<string>;
    definition: JsonText;
    compiled: JsonText;
    hash: string;
    mapping: string | null;
    published_by: string | null;
    published_at: Instant;
    retired_at: InstantOrNull;
  };
  questionnaire_scenarios: {
    id: string;
    tenant_id: string;
    questionnaire_id: string;
    name: string;
    scenario: JsonText;
    created_by: string | null;
    updated_at: Instant;
  };
  questionnaire_comments: {
    id: string;
    tenant_id: string;
    questionnaire_id: string;
    item_id: string | null;
    parent_id: string | null;
    author_id: string;
    body: string;
    resolved_at: InstantOrNull;
    resolved_by: string | null;
    created_at: Instant;
    updated_at: Instant;
  };
  questionnaire_presence: {
    tenant_id: string;
    questionnaire_id: string;
    user_id: string;
    item_id: string | null;
    last_seen: Instant;
  };
  library_items: {
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    tags: JsonText;
    content: string;
    languages: string;
    created_by: string | null;
    created_at: Instant;
    updated_at: Instant;
  };
}
