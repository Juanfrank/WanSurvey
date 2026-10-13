import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  date,
  doublePrecision,
  boolean,
  index,
  integer,
  primaryKey,
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
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
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

/**
 * Global identity: one account per e-mail, which can belong to several organisations through
 * `tenant_members`. Per-organisation fields (ID code, extension, deactivation) live there.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    firstName: text('first_name'),
    phone: text('phone'),
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** pending (invited, no password yet) | active | disabled (platform-level) */
    status: text('status').notNull().default('pending'),
    passwordHash: text('password_hash'),
    /** AES-256-GCM encrypted TOTP secret. */
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    /** Organisation opened by default at the next login. */
    lastTenantId: uuid('last_tenant_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

/** A user's membership of one organisation, with that organisation's profile fields. */
export const tenantMembers = pgTable(
  'tenant_members',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** invited | active | deactivated */
    status: text('status').notNull().default('invited'),
    /** Interviewer profile fields, available to piping and metrics. */
    idCode: text('id_code'),
    phoneExtension: text('phone_extension'),
    createdAt: createdAt(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tenant_members_uq').on(t.tenantId, t.userId),
    index('tenant_members_user_idx').on(t.userId),
  ],
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
      .default(sql`'{es}'::text[]`),
    /** `ProjectSettings` from @wansurvey/schema; read through `projectSettings()` for defaults. */
    settings: jsonb('settings').notNull().default({}),
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
      t.tenantId,
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
    /** password | sso */
    authMethod: text('auth_method').notNull().default('password'),
    /** Entra tenant id that authenticated an SSO session. */
    idpTenant: text('idp_tenant'),
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

/**
 * Single-use, hashed tokens for invitations and password resets. Global (no RLS): only hashes are
 * stored, and `tenant_id` is set for invitations so acceptance knows which organisation to join.
 */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: id(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
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

/** Per-organisation Microsoft Entra ID (Azure AD) sign-in settings. */
export const tenantSso = pgTable('tenant_sso', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  provider: text('provider').notNull().default('entra'),
  entraTenantId: text('entra_tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  /** AES-256-GCM encrypted client secret. */
  clientSecretEnc: text('client_secret_enc'),
  enabled: boolean('enabled').notNull().default(false),
  /** When true, password sign-in is refused for this organisation (owners excepted). */
  enforceSso: boolean('enforce_sso').notNull().default(false),
  /** E-mail domains whose people may be linked or created on first Microsoft sign-in. */
  allowedDomains: text('allowed_domains')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Links a global account to an external identity (Entra `oid` within its issuer). */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_identities_subject_uq').on(t.issuer, t.subject),
    index('user_identities_user_idx').on(t.userId),
  ],
);

/**
 * A questionnaire of a project. Holds the working draft (saved even when invalid, with a revision
 * number for optimistic locking); published versions live in `questionnaire_versions`.
 */
export const questionnaires = pgTable(
  'questionnaires',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    draft: jsonb('draft').notNull(),
    draftRevision: integer('draft_revision').notNull().default(1),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('questionnaires_project_idx').on(t.tenantId, t.projectId)],
);

/** Published versions: immutable except for retiring (enforced by trigger). */
export const questionnaireVersions = pgTable(
  'questionnaire_versions',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id),
    version: integer('version').notNull(),
    /** published | retired */
    status: text('status').notNull().default('published'),
    definition: jsonb('definition').notNull(),
    compiled: jsonb('compiled').notNull(),
    hash: text('hash').notNull(),
    /** Breaking-change mapping from the previous version, when there was one. */
    mapping: jsonb('mapping'),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('questionnaire_versions_uq').on(t.questionnaireId, t.version)],
);

/** Regression scenarios saved from the designer's test mode; all must pass to publish. */
export const questionnaireScenarios = pgTable(
  'questionnaire_scenarios',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id),
    name: text('name').notNull(),
    scenario: jsonb('scenario').notNull(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('questionnaire_scenarios_name_uq').on(t.questionnaireId, t.name)],
);

/**
 * Review comments on a questionnaire, on one item or on the whole questionnaire (`item_id`
 * null). Replies point to their thread's first comment; only threads are resolved.
 */
export const questionnaireComments = pgTable(
  'questionnaire_comments',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id),
    itemId: text('item_id'),
    parentId: uuid('parent_id'),
    authorId: uuid('author_id').notNull(),
    body: text('body').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('questionnaire_comments_q_idx').on(t.questionnaireId, t.createdAt)],
);

/** Who has a questionnaire open, and on which item; rows older than a minute are stale. */
export const questionnairePresence = pgTable(
  'questionnaire_presence',
  {
    tenantId: tenantId().references(() => tenants.id),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id),
    userId: uuid('user_id').notNull(),
    itemId: text('item_id'),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.questionnaireId, t.userId] })],
);

/**
 * The organisation's question library: an item, block or roster with the answer sets it uses,
 * ready to insert into any questionnaire.
 */
export const libraryItems = pgTable(
  'library_items',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `{ node: ContainerItem, answerSets: Record<string, AnswerOption[]> }` */
    content: jsonb('content').notNull(),
    languages: text('languages').array().notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('library_items_tenant_idx').on(t.tenantId, t.name)],
);

/**
 * The project's sample dictionary: the fields imported cases carry (`case.<name>` in logic and
 * piping), their type, and whether they are personal data (masked without `pii.view`).
 */
export const sampleFields = pgTable(
  'sample_fields',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    label: text('label'),
    /** text | number | date | code */
    type: text('type').notNull().default('text'),
    pii: boolean('pii').notNull().default(false),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('sample_fields_uq').on(t.projectId, t.name)],
);

/** One unit to interview (spec §3): pre-loaded sample data plus status and assignment. */
export const cases = pgTable(
  'cases',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    externalId: text('external_id').notNull(),
    sample: jsonb('sample').notNull().default({}),
    /** Personal sample fields, sealed with AES-256-GCM (H1); see `PiiCipher`. */
    samplePii: text('sample_pii'),
    /** Keyed hashes of the words of the personal fields, for search. */
    samplePiiIndex: text('sample_pii_index').array(),
    /** Personal data removed (retention or a data subject's request); kept for statistics. */
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
    /** fresh | assigned | in_progress | finalised | withdrawn */
    status: text('status').notNull().default('fresh'),
    disposition: text('disposition'),
    priority: integer('priority').notNull().default(0),
    modePreference: text('mode_preference'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    importId: uuid('import_id'),
    // CATI (slice 7)
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** A callback, appointment or retry: not called before this time. */
    nextContactAt: timestamp('next_contact_at', { withTimezone: true }),
    /** Who the callback is for; null means the case holder or, in pool mode, anyone. */
    callbackUserId: uuid('callback_user_id'),
    /** On the phone with one interviewer until the lock expires. */
    callLockUserId: uuid('call_lock_user_id'),
    callLockUntil: timestamp('call_lock_until', { withTimezone: true }),
    // CAPI offline (slice 8): downloaded to one device until checked in.
    checkedOutDevice: text('checked_out_device'),
    checkedOutBy: uuid('checked_out_by'),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cases_external_uq').on(t.projectId, t.externalId),
    index('cases_next_contact_idx').on(t.projectId, t.nextContactAt),
    index('cases_status_idx').on(t.projectId, t.status),
    index('cases_assigned_idx').on(t.projectId, t.assignedTo),
  ],
);

/** Phone numbers, e-mails and addresses of a case; several per case. */
export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    /** phone | email | address */
    type: text('type').notNull(),
    value: text('value').notNull(),
    label: text('label'),
    consent: jsonb('consent').notNull().default({}),
    valid: boolean('valid').notNull().default(true),
    /** Coordinates of an address, from the geocoder (null until geocoded or when not found). */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    /** The geocoder's match type (house, street, city…) or `not_found`. */
    geocodeQuality: text('geocode_quality'),
    geocodedAt: timestamp('geocoded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('contacts_case_idx').on(t.caseId),
    // Finds the same phone or e-mail in other projects (duplicate detection).
    index('contacts_value_idx').on(t.tenantId, t.type, t.value),
  ],
);

/** An uploaded sample file: its mapping, validation report and outcome. */
export const sampleImports = pgTable('sample_imports', {
  id: id(),
  tenantId: tenantId().references(() => tenants.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  fileName: text('file_name').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  headers: jsonb('headers').notNull().default([]),
  mapping: jsonb('mapping'),
  /** uploaded | validated | committed | failed */
  status: text('status').notNull().default('uploaded'),
  report: jsonb('report'),
  rows: integer('rows').notNull().default(0),
  uploadedBy: uuid('uploaded_by'),
  createdAt: createdAt(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
});

/** Parsed rows of an import, kept until it is committed (or for 24 hours). */
export const sampleImportRows = pgTable(
  'sample_import_rows',
  {
    tenantId: tenantId().references(() => tenants.id),
    importId: uuid('import_id')
      .notNull()
      .references(() => sampleImports.id),
    rowNo: integer('row_no').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.importId, t.rowNo] })],
);

/**
 * Who works which cases: a fixed list (cases already assigned) or a rule, an expression over
 * `case.*`, status and priority that picks up matching unassigned cases.
 */
export const assignments = pgTable(
  'assignments',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** list | rule */
    kind: text('kind').notNull(),
    name: text('name'),
    filter: text('filter'),
    quota: integer('quota'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('assignments_project_idx').on(t.projectId)],
);

/** Append-only history of a case (imports, assignments, edits, status changes). */
export const caseEvents = pgTable(
  'case_events',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    type: text('type').notNull(),
    details: jsonb('details').notNull().default({}),
    actorUserId: uuid('actor_user_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('case_events_case_idx').on(t.caseId, t.at)],
);

/**
 * One interview of a case (or, later, of an open CAWI link) on a published questionnaire
 * version. The id comes from the client, so a device can start one before it is online.
 */
export const interviews = pgTable(
  'interviews',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    caseId: uuid('case_id').references(() => cases.id),
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id),
    mode: text('mode').notNull(),
    interviewerId: uuid('interviewer_id'),
    /** in_progress | submitted | in_review | approved | returned | rejected | broken_off */
    status: text('status').notNull().default('in_progress'),
    disposition: text('disposition'),
    language: text('language').notNull(),
    /** The engine's snapshot (`InterviewSession.state()`), restored on resume. */
    /** Case data the engine was given at start (as the interviewer saw it); reused to verify. */
    context: jsonb('context').notNull().default({}),
    state: jsonb('state').notNull().default({}),
    answers: jsonb('answers').notNull().default({}),
    position: text('position'),
    /** The device writing this interview; others are refused until it is handed over. */
    deviceId: text('device_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** PAPI double entry: 1 for the first keying, 2 for the second. */
    entryPass: integer('entry_pass').notNull().default(1),
    activeMs: integer('active_ms').notNull().default(0),
    totalMs: integer('total_ms').notNull().default(0),
    // Review (slice 11)
    /** Quality flags computed at each submission (R3). */
    flags: jsonb('flags').notNull().default({}),
    /** Picked in the random review sample (R2). */
    sampled: boolean('sampled').notNull().default(false),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** How many times it was submitted (more than one after a return). */
    submissions: integer('submissions').notNull().default(0),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('interviews_case_idx').on(t.caseId),
    index('interviews_project_idx').on(t.tenantId, t.projectId, t.status),
    uniqueIndex('interviews_one_open_per_case')
      .on(t.caseId)
      .where(sql`status = 'in_progress'`),
  ],
);

/** The last change number acknowledged per interview and device. */
export const interviewDevices = pgTable(
  'interview_devices',
  {
    tenantId: tenantId().references(() => tenants.id),
    interviewId: uuid('interview_id')
      .notNull()
      .references(() => interviews.id),
    deviceId: text('device_id').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.interviewId, t.deviceId] })],
);

/** Every answer change, old and new value, in order (append-only). */
export const interviewAnswerEvents = pgTable(
  'interview_answer_events',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    interviewId: uuid('interview_id')
      .notNull()
      .references(() => interviews.id),
    deviceId: text('device_id').notNull(),
    seq: integer('seq').notNull(),
    variable: text('variable').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    byUserId: uuid('by_user_id'),
    /** When the server received it (the device's time is `at`): sync latency (M4). */
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
    /** interviewer | respondent | reviewer | system */
    source: text('source').notNull(),
    /** Why the engine changed it (path_change, prefill, …); null for a typed answer. */
    reason: text('reason'),
  },
  (t) => [
    uniqueIndex('interview_answer_events_uq').on(t.interviewId, t.deviceId, t.seq),
    index('interview_answer_events_at_idx').on(t.interviewId, t.at),
  ],
);

/** Timing and navigation events (paradata), append-only. */
export const interviewParadata = pgTable(
  'interview_paradata',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    interviewId: uuid('interview_id')
      .notNull()
      .references(() => interviews.id),
    deviceId: text('device_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    monotonicMs: doublePrecision('monotonic_ms'),
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => [uniqueIndex('interview_paradata_uq').on(t.interviewId, t.deviceId, t.seq)],
);

/** One phone call on a case (CATI): who called which number, how it went, what comes next. */
export const callAttempts = pgTable(
  'call_attempts',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    interviewerId: uuid('interviewer_id').notNull(),
    contactId: uuid('contact_id'),
    /** Last digits only, so the history never repeats the number. */
    numberMasked: text('number_masked'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    connectedMs: integer('connected_ms'),
    wrapUpMs: integer('wrap_up_ms'),
    /** answered | no_answer | busy | voicemail | wrong_number | disconnected | refusal | callback | appointment; null while dialling */
    outcome: text('outcome'),
    disposition: text('disposition'),
    callbackAt: timestamp('callback_at', { withTimezone: true }),
    note: text('note'),
    interviewId: uuid('interview_id'),
  },
  (t) => [
    index('call_attempts_case_idx').on(t.caseId, t.startedAt),
    index('call_attempts_interviewer_idx').on(t.tenantId, t.interviewerId, t.startedAt),
  ],
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

// ---------------------------------------------------------------------------
// Web surveys and e-mail (slice 9)
// ---------------------------------------------------------------------------

/** Invitation and reminder e-mails per project and language. */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** invitation | reminder */
    kind: text('kind').notNull(),
    language: text('language').notNull(),
    subject: text('subject').notNull(),
    /** Plain text with {{case.*}}, {{link}} and {{unsubscribe}}. */
    body: text('body').notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_templates_uq').on(t.projectId, t.kind, t.language)],
);

/** A mailing: which cases get the questionnaire, when, and the reminder schedule. */
export const waves = pgTable(
  'waves',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id),
    name: text('name').notNull(),
    /** draft | sending | sent */
    status: text('status').notNull().default('draft'),
    /** Case rule (as in assignment rules); null means every eligible case. */
    filter: text('filter'),
    /** Days after the invitation for each reminder, e.g. {3,7}. */
    reminderDays: integer('reminder_days')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    /** Not sent before this time; null means as soon as it is sent. */
    sendAt: timestamp('send_at', { withTimezone: true }),
    /** A hard bounce moves the case to telephone interviewing. */
    bouncesToCati: boolean('bounces_to_cati').notNull().default(false),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('waves_project_idx').on(t.tenantId, t.projectId)],
);

/**
 * One respondent's link: by e-mail in a wave, or an anonymous open-link start. The token is
 * stored hashed (lookup) and encrypted (to send reminders); the raw token is only in the link.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id),
    waveId: uuid('wave_id').references(() => waves.id),
    caseId: uuid('case_id').references(() => cases.id),
    contactId: uuid('contact_id'),
    email: text('email'),
    tokenHash: text('token_hash').notNull(),
    tokenEnc: text('token_enc').notNull(),
    language: text('language').notNull(),
    /** queued | sent | failed | bounced | suppressed | completed */
    status: text('status').notNull().default('queued'),
    sendAttempts: integer('send_attempts').notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    bounceType: text('bounce_type'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    remindersSent: integer('reminders_sent').notNull().default(0),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
    lastError: text('last_error'),
    interviewId: uuid('interview_id'),
  },
  (t) => [
    uniqueIndex('invitations_token_uq').on(t.tokenHash),
    uniqueIndex('invitations_wave_case_uq').on(t.waveId, t.caseId),
    index('invitations_status_idx').on(t.tenantId, t.status),
    index('invitations_interview_idx').on(t.interviewId),
  ],
);

/** Addresses never e-mailed again: hard bounces, complaints and unsubscribes. */
export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    email: text('email').notNull(),
    /** hard_bounce | complaint | unsubscribe */
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppressions_uq').on(t.tenantId, t.email)],
);

/** Anonymous links that anyone can open (no case); one interview per browser (W6). */
export const openLinks = pgTable('open_links', {
  id: id(),
  tenantId: tenantId().references(() => tenants.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  questionnaireId: uuid('questionnaire_id')
    .notNull()
    .references(() => questionnaires.id),
  slug: text('slug').notNull().unique(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/**
 * Paper forms keyed twice (P3): each variable whose two entries differ, until a supervisor
 * chooses the right value.
 */
export const entryMismatches = pgTable(
  'entry_mismatches',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    firstInterviewId: uuid('first_interview_id').notNull(),
    secondInterviewId: uuid('second_interview_id').notNull(),
    variable: text('variable').notNull(),
    firstValue: jsonb('first_value'),
    secondValue: jsonb('second_value'),
    /** open | resolved */
    status: text('status').notNull().default('open'),
    resolvedValue: jsonb('resolved_value'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('entry_mismatches_project_idx').on(t.tenantId, t.projectId, t.status),
    uniqueIndex('entry_mismatches_uq').on(t.secondInterviewId, t.variable),
  ],
);

/** Reviewers' comments on an interview, per question or on the whole interview. */
export const reviewComments = pgTable(
  'review_comments',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    interviewId: uuid('interview_id')
      .notNull()
      .references(() => interviews.id),
    /** The answer key commented on; null for the whole interview. */
    variable: text('variable'),
    body: text('body').notNull(),
    authorId: uuid('author_id').notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('review_comments_interview_idx').on(t.interviewId, t.createdAt)],
);

/** Codes for the free text of "Other, specify" answers (R6). */
export const openCodes = pgTable(
  'open_codes',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** The text variable, e.g. `A6_OCC_OTHER`. */
    variable: text('variable').notNull(),
    code: integer('code').notNull(),
    label: text('label').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('open_codes_uq').on(t.projectId, t.variable, t.code)],
);

/** Which code each distinct "other" text was given (R6). */
export const codedTexts = pgTable(
  'coded_texts',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    variable: text('variable').notNull(),
    /** Trimmed and lower-cased, so the same text written differently gets one code. */
    text: text('text').notNull(),
    code: integer('code').notNull(),
    codedBy: uuid('coded_by'),
    codedAt: timestamp('coded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('coded_texts_uq').on(t.projectId, t.variable, t.text)],
);

/**
 * Completed interviews per project, day, mode and interviewer (M3): kept current by a job
 * after each submission or review decision, and recomputed nightly.
 */
export const statsDaily = pgTable(
  'stats_daily',
  {
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** The project's local day of submission. */
    day: date('day').notNull(),
    mode: text('mode').notNull(),
    interviewerId: uuid('interviewer_id'),
    submitted: integer('submitted').notNull().default(0),
    completes: integer('completes').notNull().default(0),
    approved: integer('approved').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    activeMs: bigint('active_ms', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT is added by hand in the migration (drizzle-kit 0.31 has no option).
    uniqueIndex('stats_daily_uq').on(t.projectId, t.day, t.mode, t.interviewerId),
  ],
);

/** Data exports, built by the worker (M6). */
export const exports = pgTable(
  'exports',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    questionnaireId: uuid('questionnaire_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    options: jsonb('options').notNull(),
    /** queued | running | done | failed */
    status: text('status').notNull().default('queued'),
    fileName: text('file_name'),
    contentType: text('content_type'),
    file: bytea('file'),
    size: integer('size'),
    rows: integer('rows'),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('exports_project_idx').on(t.tenantId, t.projectId, t.createdAt)],
);

/** Read-only links to a project's summary for clients (M7). */
export const shareLinks = pgTable('share_links', {
  id: id(),
  tenantId: tenantId().references(() => tenants.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  tokenHash: text('token_hash').notNull().unique(),
  tokenEnc: text('token_enc').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** Tables protected by tenant row-level security. */
export const TENANT_TABLES = [
  'tenant_members',
  'projects',
  'memberships',
  'sessions',
  'tenant_sso',
  'questionnaires',
  'questionnaire_versions',
  'questionnaire_scenarios',
  'questionnaire_comments',
  'questionnaire_presence',
  'library_items',
  'sample_fields',
  'cases',
  'contacts',
  'sample_imports',
  'sample_import_rows',
  'assignments',
  'case_events',
  'interviews',
  'interview_devices',
  'interview_answer_events',
  'interview_paradata',
  'call_attempts',
  'email_templates',
  'waves',
  'invitations',
  'suppressions',
  'open_links',
  'entry_mismatches',
  'review_comments',
  'open_codes',
  'coded_texts',
  'stats_daily',
  'exports',
  'share_links',
  'audit_log',
] as const;
