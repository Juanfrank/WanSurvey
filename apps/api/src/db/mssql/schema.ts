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
  sample_fields: {
    id: string;
    tenant_id: string;
    project_id: string;
    name: string;
    label: string | null;
    type: Generated<string>;
    pii: Generated<boolean>;
    position: Generated<number>;
  };
  cases: {
    id: string;
    tenant_id: string;
    project_id: string;
    questionnaire_id: string | null;
    external_id: string;
    sample: JsonText;
    sample_pii: string | null;
    sample_pii_index: string | null;
    anonymised_at: InstantOrNull;
    status: Generated<string>;
    disposition: string | null;
    priority: Generated<number>;
    mode_preference: string | null;
    assigned_to: string | null;
    assigned_at: InstantOrNull;
    import_id: string | null;
    attempts: Generated<number>;
    last_attempt_at: InstantOrNull;
    next_contact_at: InstantOrNull;
    callback_user_id: string | null;
    call_lock_user_id: string | null;
    call_lock_until: InstantOrNull;
    checked_out_device: string | null;
    checked_out_by: string | null;
    checked_out_at: InstantOrNull;
    frame_unit_id: string | null;
    selection_role: string | null;
    substitute_for: string | null;
    inclusion_prob: number | null;
    base_weight: number | null;
    created_at: Instant;
    updated_at: Instant;
  };
  contacts: {
    id: string;
    tenant_id: string;
    case_id: string;
    type: string;
    value: string;
    label: string | null;
    consent: JsonText;
    valid: Generated<boolean>;
    lat: number | null;
    lng: number | null;
    geocode_quality: string | null;
    geocoded_at: InstantOrNull;
    created_at: Instant;
  };
  case_events: {
    id: string;
    tenant_id: string;
    case_id: string;
    type: string;
    details: JsonText;
    actor_user_id: string | null;
    at: Instant;
  };
  assignments: {
    id: string;
    tenant_id: string;
    project_id: string;
    user_id: string;
    questionnaire_id: string | null;
    kind: string;
    name: string | null;
    filter: string | null;
    quota: number | null;
    active: Generated<boolean>;
    created_by: string | null;
    created_at: Instant;
  };
  sampling_plans: {
    id: string;
    tenant_id: string;
    project_id: string;
    questionnaire_id: string | null;
    source: JsonText;
    design: JsonText;
    size: JsonText;
    eligibility: string | null;
    exclusions: string | null;
    quotas: JsonText;
    substitution: JsonText;
    cross_checks: JsonText;
    seed: string;
    status: Generated<string>;
    result: string | null;
    selected_at: InstantOrNull;
    selected_by: string | null;
    updated_at: Instant;
    updated_by: string | null;
  };
  frame_units: {
    id: string;
    tenant_id: string;
    project_id: string;
    questionnaire_id: string | null;
    external_id: string;
    source_label: string | null;
    sample: JsonText;
    sample_pii: string | null;
    contacts: JsonText;
    import_id: string | null;
    eligible: Generated<boolean>;
    exclusion: string | null;
    role: string | null;
    release_order: number | null;
    released_at: InstantOrNull;
    inclusion_prob: number | null;
    base_weight: number | null;
    stratum: string | null;
    case_id: string | null;
    created_at: Instant;
  };
  interviewer_goals: {
    id: string;
    tenant_id: string;
    project_id: string;
    questionnaire_id: string | null;
    user_id: string | null;
    frequency: Generated<string>;
    starts_on: string;
    ends_on: string;
    target: number;
    created_by: string | null;
    created_at: Instant;
  };
  interviews: {
    id: string;
    tenant_id: string;
    project_id: string;
    case_id: string | null;
    questionnaire_version_id: string;
    mode: string;
    interviewer_id: string | null;
    status: Generated<string>;
    disposition: string | null;
    language: string;
    context: JsonText;
    state: JsonText;
    answers: JsonText;
    state_version: Generated<number>;
    state_device: string | null;
    position: string | null;
    device_id: string;
    started_at: Instant;
    ended_at: InstantOrNull;
    entry_pass: Generated<number>;
    active_ms: Generated<number>;
    total_ms: Generated<number>;
    flags: JsonText;
    sampled: Generated<boolean>;
    submitted_at: InstantOrNull;
    submissions: Generated<number>;
    reviewed_by: string | null;
    reviewed_at: InstantOrNull;
    updated_at: Instant;
  };
  interview_devices: {
    tenant_id: string;
    interview_id: string;
    device_id: string;
    last_seq: Generated<number>;
    updated_at: Instant;
  };
  interview_answer_events: {
    id: string;
    tenant_id: string;
    interview_id: string;
    device_id: string;
    seq: number;
    variable: string;
    old_value: string | null;
    new_value: string | null;
    at: Date | string;
    by_user_id: string | null;
    received_at: InstantOrNull;
    source: string;
    reason: string | null;
  };
  interview_paradata: {
    id: string;
    tenant_id: string;
    interview_id: string;
    device_id: string;
    seq: number;
    type: string;
    at: Date | string;
    monotonic_ms: number | null;
    payload: string;
  };
  call_attempts: {
    id: string;
    tenant_id: string;
    project_id: string;
    case_id: string;
    interviewer_id: string;
    contact_id: string | null;
    number_masked: string | null;
    started_at: Instant;
    ended_at: InstantOrNull;
    connected_ms: number | null;
    wrap_up_ms: number | null;
    outcome: string | null;
    disposition: string | null;
    callback_at: InstantOrNull;
    note: string | null;
    interview_id: string | null;
  };
  review_comments: {
    id: string;
    tenant_id: string;
    interview_id: string;
    variable: string | null;
    body: string;
    author_id: string;
    created_at: Instant;
    resolved_at: InstantOrNull;
  };
  open_codes: {
    id: string;
    tenant_id: string;
    project_id: string;
    variable: string;
    code: number;
    label: string;
    created_at: Instant;
  };
  coded_texts: {
    id: string;
    tenant_id: string;
    project_id: string;
    variable: string;
    text: string;
    code: number;
    coded_by: string | null;
    coded_at: Instant;
  };
}
